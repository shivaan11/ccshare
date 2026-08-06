import { z } from "zod";
import { EventRow } from "./events";

// Realtime broadcast lanes on channel `session:{id}` — DESIGN.md §3.2/§3.4.
// `event` mirrors durable rows for sub-second delivery (Postgres remains the
// source of truth; clients reconcile by seq). `delta` is ephemeral token
// streaming, never persisted.

export const BroadcastMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), row: EventRow }),
  z.object({
    type: z.literal("delta"),
    messageId: z.string(),
    lane: z.enum(["text", "thinking"]),
    // append-only chunk; receivers concatenate per (messageId, lane)
    text: z.string(),
  }),
]);
export type BroadcastMessage = z.infer<typeof BroadcastMessage>;

// Presence payload per connected user (Realtime presence lane).
export const PresenceState = z.object({
  userId: z.string(),
  name: z.string(),
  typing: z.boolean(),
  draftShared: z.boolean(),
  draftText: z.string().nullable(),
});
export type PresenceState = z.infer<typeof PresenceState>;
