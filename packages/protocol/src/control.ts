import { z } from "zod";
import { Attachment, PermissionMode, SessionMode } from "./events.js";

// Control plane — DESIGN.md §3.3. Guests and the host's browser INSERT these as
// control_requests rows; the host daemon is the sole consumer and state-machine
// writer. Moderation is enforced by the daemon's policy function, never the UI.

export const ControlAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("send_message"),
    text: z.string(),
    attachments: z.array(Attachment).default([]),
  }),
  z.object({ kind: z.literal("interrupt") }),
  z.object({
    kind: z.literal("permission_decision"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    updatedInput: z.unknown().optional(),
  }),
  z.object({ kind: z.literal("set_model"), model: z.string() }),
  z.object({
    kind: z.literal("set_permission_mode"),
    permissionMode: PermissionMode,
  }),
  z.object({ kind: z.literal("set_session_mode"), sessionMode: SessionMode }),
  // approve/reject/cancel target a prior control_requests row by id
  z.object({ kind: z.literal("approve"), targetId: z.string() }),
  z.object({ kind: z.literal("reject"), targetId: z.string() }),
  z.object({ kind: z.literal("cancel"), targetId: z.string() }),
]);
export type ControlAction = z.infer<typeof ControlAction>;

export const ControlStatus = z.enum([
  "pending",
  "applied",
  "needs_approval",
  "approved",
  "rejected",
  "superseded",
  "failed",
]);
export type ControlStatus = z.infer<typeof ControlStatus>;

export const ControlRequestRow = z.object({
  id: z.string(),
  sessionId: z.string(),
  requestedBy: z.string(),
  action: ControlAction,
  status: ControlStatus,
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ControlRequestRow = z.infer<typeof ControlRequestRow>;
