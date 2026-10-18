// Validate tool arguments, apply guards, execute handlers, and format MCP results.
// The low-level MCP Server uses the schemas for tools/list and tools/call.
import { zodToJsonSchema } from "zod-to-json-schema";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatMattermostError } from "../mattermost/errors.js";
import { GuardrailError, assertWriteAllowed, assertMessageWithinLimit } from "../guardrails.js";
import { ResourceGuard } from "../resource-guardrails.js";
const text = (body, isError = false) => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});
/** Map a tool definition to its MCP `tools/list` entry (zod → JSON Schema). */
export function toMcpTool(def) {
  const json = zodToJsonSchema(def.inputSchema, { target: "jsonSchema7", $refStrategy: "none" });
  // Drop the $schema dialect marker; keep type/properties/required.
  const { $schema: _schema, ...schema } = json;
  const isWrite = Boolean(def.write || def.destructive);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: { type: "object", ...schema },
    annotations: {
      title: def.title,
      readOnlyHint: !isWrite,
      destructiveHint: Boolean(def.destructive),
    },
  };
}
export function buildToolList(tools) {
  return { tools: tools.map(toMcpTool) };
}
function formatResult(result, compact = false) {
  return typeof result === "string"
    ? result
    : JSON.stringify(result, null, compact ? undefined : 2);
}
/**
 * Validate args, enforce guardrails, run the handler, and format the result.
 * Never throws: guardrail refusals and API errors both come back as
 * `isError: true` text content (API errors surfaced verbatim).
 */
export async function dispatchToolCall(tools, ctx, name, rawArgs) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return text(`unknown tool: ${name}`, true);
  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return text(`invalid arguments for ${name}: ${detail}`, true);
  }
  const args = parsed.data;
  try {
    const policy = tool.guard ? tool.guard(args) : tool;
    const guard = {
      name: tool.name,
      ...(policy.write ? { write: true } : {}),
      ...(policy.destructive ? { destructive: true } : {}),
    };
    const g = ctx.session.config.guardrails;
    assertWriteAllowed(guard, args, g);
    if (tool.messageText) {
      const message = tool.messageText(args);
      if (message != null) assertMessageWithinLimit(message, g);
    }
    const resources = new ResourceGuard(ctx.session);
    if (tool.resources) await resources.assertResources(tool.resources(args));
    const result = await tool.handler(args, ctx);
    return text(
      formatResult(
        tool.resultScope ? await resources.filterResult(tool.resultScope, result) : result,
        tool.compact,
      ),
    );
  } catch (err) {
    if (err instanceof GuardrailError) return text(err.message, true);
    // Surface Mattermost API errors verbatim; never swallow.
    return text(formatMattermostError(err), true);
  }
}
/** Wire tools/list and tools/call onto a low-level MCP Server. */
export function registerTools(server, tools, ctx) {
  server.setRequestHandler(ListToolsRequestSchema, () => buildToolList(tools));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    dispatchToolCall(tools, ctx, req.params.name, req.params.arguments),
  );
}
