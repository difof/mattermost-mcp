// Tool framework: a typed tool-definition shape, a central call wrapper that
// runs guardrails → handler → uniform formatting, and the MCP wiring.
//
// We use the low-level `Server` (not `McpServer`) — see index.ts — so we map
// zod → JSON Schema ourselves and answer tools/list + tools/call by hand.
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { MattermostSession } from "../mattermost/types.js";
import { formatMattermostError } from "../mattermost/errors.js";
import {
  GuardrailError,
  assertWriteAllowed,
  assertMessageWithinLimit,
  type ToolGuard,
} from "../guardrails.js";
import { ResourceGuard, type ResultScope, type ToolResources } from "../resource-guardrails.js";

/** Shared, authenticated context passed to every handler. */
export interface ToolContext {
  session: MattermostSession;
}

/** A tool definition. `inputSchema` is the single source of truth for args. */
export interface ToolDef<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** Performs a write (blocked under MM_READ_ONLY). */
  write?: boolean;
  /** Destructive (needs MM_ALLOW_DESTRUCTIVE + confirm:true). Implies write. */
  destructive?: boolean;
  /** Operation-specific policy for tools that dispatch multiple API operations. */
  guard?: (args: z.infer<S>) => Omit<ToolGuard, "name">;
  /** Avoid pretty-printing large machine-readable API results. */
  compact?: boolean;
  /** Direct and indirect resource ids to resolve and check before the handler. */
  resources?: (args: z.infer<S>) => ToolResources;
  /** Filter collection results to the permitted resources. */
  resultScope?: ResultScope;
  /** Message text to length-check before sending. */
  messageText?: (args: z.infer<S>) => string | undefined;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export type AnyToolDef = ToolDef<ZodTypeAny>;

/**
 * Author a tool with full arg-type inference, erased to {@link AnyToolDef} so
 * heterogeneous tools share one array. `S` is invariant in `ToolDef` (it sits
 * in both `inputSchema` and the handler's arg type), so the erasure is a cast.
 */
export function defineTool<S extends ZodTypeAny>(def: ToolDef<S>): AnyToolDef {
  return def as unknown as AnyToolDef;
}

// --- MCP shapes --------------------------------------------------------------

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean };
}

const text = (body: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

/** Map a tool definition to its MCP `tools/list` entry (zod → JSON Schema). */
export function toMcpTool(def: AnyToolDef): McpTool {
  const json = zodToJsonSchema(def.inputSchema, { target: "jsonSchema7", $refStrategy: "none" });
  // Drop the $schema dialect marker; keep type/properties/required.
  const { $schema: _schema, ...schema } = json as Record<string, unknown>;
  const isWrite = Boolean(def.write || def.destructive);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: { type: "object", ...schema } as McpTool["inputSchema"],
    annotations: {
      title: def.title,
      readOnlyHint: !isWrite,
      destructiveHint: Boolean(def.destructive),
    },
  };
}

export function buildToolList(tools: AnyToolDef[]): { tools: McpTool[] } {
  return { tools: tools.map(toMcpTool) };
}

function formatResult(result: unknown, compact = false): string {
  return typeof result === "string"
    ? result
    : JSON.stringify(result, null, compact ? undefined : 2);
}

/**
 * Validate args, enforce guardrails, run the handler, and format the result.
 * Never throws: guardrail refusals and API errors both come back as
 * `isError: true` text content (API errors surfaced verbatim).
 */
export async function dispatchToolCall(
  tools: AnyToolDef[],
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return text(`unknown tool: ${name}`, true);

  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return text(`invalid arguments for ${name}: ${detail}`, true);
  }
  const args = parsed.data as Record<string, unknown>;

  try {
    const policy = tool.guard ? tool.guard(args) : tool;
    const guard: ToolGuard = {
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

/** Wire tools/list and tools/call onto a low-level MCP {@link Server}. */
export function registerTools(server: Server, tools: AnyToolDef[], ctx: ToolContext): void {
  server.setRequestHandler(ListToolsRequestSchema, () => buildToolList(tools));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    dispatchToolCall(tools, ctx, req.params.name, req.params.arguments),
  );
}
