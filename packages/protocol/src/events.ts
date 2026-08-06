import { z } from "zod";

// Durable session events — DESIGN.md §3.1. These are the only shapes ever written
// to the `events` table; the daemon's adapter is the only producer.

export const SessionMode = z.enum(["equal", "moderated"]);
export type SessionMode = z.infer<typeof SessionMode>;

export const PermissionMode = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const RunStatus = z.enum([
  "working",
  "idle",
  "awaiting_permission",
  "interrupted",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const SessionKind = z.enum(["shared", "mirror"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const Attachment = z.object({
  storagePath: z.string(),
  mime: z.string(),
  name: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

export const AssistantContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    toolUseId: z.string(),
    toolName: z.string(),
  }),
]);
export type AssistantContentBlock = z.infer<typeof AssistantContentBlock>;

export const TokenUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const SessionEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_started"),
    cwd: z.string(),
    model: z.string().optional(),
    permissionMode: PermissionMode,
    sessionMode: SessionMode,
    hostName: z.string(),
    claudeSessionId: z.string().optional(),
    resumed: z.boolean(),
  }),
  z.object({
    type: z.literal("user_message"),
    text: z.string(),
    authorName: z.string(),
    via: z.enum(["web", "tui"]),
    attachments: z.array(Attachment),
  }),
  z.object({
    type: z.literal("assistant_message"),
    messageId: z.string(),
    content: z.array(AssistantContentBlock),
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal("thinking"),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_use"),
    toolUseId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string(),
    toolName: z.string(),
    inputSummary: z.string(),
    input: z.unknown(),
    suggestions: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("permission_decision"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    decidedByName: z.string(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("turn_result"),
    durationMs: z.number(),
    usage: TokenUsage.optional(),
    costUsd: z.number().optional(),
    stopReason: z.string().optional(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("status_change"),
    status: RunStatus,
  }),
  z.object({
    type: z.literal("settings_change"),
    field: z.enum(["model", "permission_mode", "session_mode"]),
    value: z.string(),
    changedByName: z.string(),
  }),
  z.object({
    type: z.literal("control_note"),
    note: z.enum(["queued", "approved", "rejected", "cancelled", "failed"]),
    controlId: z.string(),
    authorName: z.string(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal("session_ended"),
    reason: z.string(),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

// The shape a durable event takes on the wire and in client state: DB row columns
// plus the parsed event payload. `seq` is the authoritative order, always.
export const EventRow = z.object({
  sessionId: z.string(),
  seq: z.number(),
  authorUserId: z.string().nullable(),
  createdAt: z.string(),
  event: SessionEvent,
});
export type EventRow = z.infer<typeof EventRow>;
