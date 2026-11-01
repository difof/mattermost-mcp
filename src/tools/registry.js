// Validate tool arguments, apply guards, execute handlers, and format MCP results.
// The low-level MCP Server uses the schemas for tools/list and tools/call.
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { formatMattermostError } from "../mattermost/errors.js";
import { GuardrailError, assertWriteAllowed, assertMessageWithinLimit } from "../guardrails.js";
import { combineSignals, withRequestSignal } from "../mattermost/request-signal.js";
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
      readOnlyHint: !isWrite && !def.localWrite,
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
 * Unknown tool names are protocol errors. Validation, guardrail, and API
 * failures return `isError: true` tool results so the caller can correct them.
 */
export async function dispatchToolCall(tools, ctx, name, rawArgs) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
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
    const result = await tool.handler(args, { ...ctx, resources });
    const encoded = formatResult(
      tool.resultScope ? await resources.filterResult(tool.resultScope, result) : result,
      tool.compact || Boolean(ctx.exchange),
    );
    if (ctx.exchange && Buffer.byteLength(encoded) > ctx.exchange.outputLimit) {
      return text(
        "Operation finished but its result is too large. Use a smaller page or filter; do not repeat a mutation.",
        true,
      );
    }
    return text(encoded);
  } catch (err) {
    if (err instanceof GuardrailError) return text(err.message, true);
    // Surface Mattermost API errors verbatim; never swallow.
    return text(formatMattermostError(err), true);
  }
}
/** Wire tools/list and tools/call onto a low-level MCP Server. */
export function registerTools(server, tools, ctx) {
  server.setRequestHandler(ListToolsRequestSchema, () => buildToolList(tools));
  server.setRequestHandler(CallToolRequestSchema, ({ params }, extra) => {
    // A routing hint for this one call, never an identity attached to the shared account.
    const hint = params._meta?.["ai.opencode/sessionID"];
    const callerSessionId =
      typeof hint === "string" && /^ses_[A-Za-z0-9]{1,100}$/.test(hint) ? hint : undefined;
    const signal = combineSignals(ctx.exchange?.signal, extra?.signal);
    // Limit cancellation to operations performed on this caller's behalf.
    // Background subscriptions and shared listener/refresh tasks keep their own lifetime.
    const session = Object.create(ctx.session);
    session.call = (fn) =>
      withRequestSignal(signal, () => {
        signal?.throwIfAborted();
        return ctx.session.call(fn);
      });
    const run = () =>
      dispatchToolCall(
        tools,
        { ...ctx, session, signal, callerSessionId },
        params.name,
        params.arguments,
      );
    if (!ctx.exchange) return run();
    return ctx.exchange.track(async () => {
      const reply = await run();
      if (reply.isError && Buffer.byteLength(reply.content[0].text) > ctx.exchange.outputLimit)
        return text("The error response exceeds the service limit.", true);
      return reply;
    });
  });
}
