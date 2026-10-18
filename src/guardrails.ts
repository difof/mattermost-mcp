// Pure, network-free safety checks evaluated BEFORE any write reaches the API.
// The tool framework composes these around every handler; resource-guardrails.ts
// resolves indirect post/file/channel references before checking the allowlists.
import type { GuardrailConfig } from "./config.js";

/** A guardrail refusal — distinct from a Mattermost API error. */
export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailError";
  }
}

/** The guardrail-relevant metadata of a tool. */
export interface ToolGuard {
  name: string;
  write?: boolean;
  destructive?: boolean;
}

/** Read-only mode blocks every write/destructive tool. */
export function assertNotReadOnly(tool: ToolGuard, g: GuardrailConfig): void {
  if (g.readOnly && (tool.write || tool.destructive)) {
    throw new GuardrailError(
      `refused: server is read-only (MM_READ_ONLY=true); '${tool.name}' performs a write`,
    );
  }
}

/** Destructive tools require BOTH the env flag AND an explicit confirm:true arg. */
export function assertDestructiveAllowed(
  tool: ToolGuard,
  args: { confirm?: unknown },
  g: GuardrailConfig,
): void {
  if (!tool.destructive) return;
  if (!g.allowDestructive) {
    throw new GuardrailError(
      `refused: destructive tool '${tool.name}' requires MM_ALLOW_DESTRUCTIVE=true`,
    );
  }
  if (args.confirm !== true) {
    throw new GuardrailError(`refused: destructive tool '${tool.name}' requires confirm:true`);
  }
}

/**
 * Non-resource write gate: read-only first, then the destructive double-lock.
 * Resource allowlists and message length are separate, resource-specific checks.
 */
export function assertWriteAllowed(
  tool: ToolGuard,
  args: { confirm?: unknown },
  g: GuardrailConfig,
): void {
  assertNotReadOnly(tool, g);
  assertDestructiveAllowed(tool, args, g);
}

/** Team allowlist (empty list = unrestricted). */
export function assertTeamAllowed(teamId: string, g: GuardrailConfig): void {
  if (g.teamAllowlist.length > 0 && !g.teamAllowlist.includes(teamId)) {
    throw new GuardrailError(`refused: team '${teamId}' is not in MM_TEAM_ALLOWLIST`);
  }
}

/** Channel allowlist (empty list = unrestricted). */
export function assertChannelAllowed(channelId: string, g: GuardrailConfig): void {
  if (g.channelAllowlist.length > 0 && !g.channelAllowlist.includes(channelId)) {
    throw new GuardrailError(`refused: channel '${channelId}' is not in MM_CHANNEL_ALLOWLIST`);
  }
}

/**
 * Reject over-long messages before they reach the API. Length is counted in
 * Unicode code points to match Mattermost's server-side rune count (a single
 * emoji is one unit, not its UTF-16 surrogate-pair length).
 */
export function assertMessageWithinLimit(message: string, g: GuardrailConfig): void {
  const length = [...message].length;
  if (length > g.maxMessageLen) {
    throw new GuardrailError(
      `refused: message length ${length} exceeds MM_MAX_MESSAGE_LEN (${g.maxMessageLen})`,
    );
  }
}
