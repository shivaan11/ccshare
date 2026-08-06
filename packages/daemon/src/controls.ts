import {
  type ControlAction,
  ControlRequestRow,
  type SessionMode,
} from "@ccshare/protocol";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.js";
import { authorize } from "./policy.js";

// Control consumer — DESIGN §3.3. The daemon is the sole state-machine writer:
// browsers INSERT control_requests; this module authorizes and executes them.
// Moderation is enforced here, at the trust boundary, never in the UI.

export type ControlHandlers = {
  sendMessage(
    text: string,
    authorId: string,
    authorName: string,
  ): Promise<void>;
  interrupt(): Promise<void>;
  permissionDecision(
    requestId: string,
    decision: "allow" | "deny",
    decidedByName: string,
  ): Promise<boolean>; // false if already decided (superseded)
  setModel(model: string, byName: string): Promise<void>;
  setPermissionMode(mode: string, byName: string): Promise<void>;
  setSessionMode(mode: SessionMode, byName: string): Promise<void>;
  noteQueued(
    controlId: string,
    authorName: string,
    text: string,
  ): Promise<void>;
};

type DbControlRow = {
  id: string;
  session_id: string;
  requested_by: string;
  action: unknown;
  status: string;
  created_at: string;
};

export class ControlConsumer {
  private channel: RealtimeChannel | null = null;
  private names = new Map<string, string>();
  private mode: SessionMode;

  constructor(
    private client: SupabaseClient,
    private sessionId: string,
    private hostUserId: string,
    initialMode: SessionMode,
    private handlers: ControlHandlers,
  ) {
    this.mode = initialMode;
  }

  setMode(mode: SessionMode): void {
    this.mode = mode;
  }

  start(): void {
    this.channel = this.client
      .channel(`control:${this.sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "control_requests",
          filter: `session_id=eq.${this.sessionId}`,
        },
        ({ new: row }) => {
          void this.handle(row as DbControlRow).catch((err) =>
            log.error({ err: String(err) }, "control handling failed"),
          );
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") log.info("control consumer live");
      });
  }

  private async nameOf(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    const { data } = await this.client
      .from("profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    const name = data?.display_name ?? "someone";
    this.names.set(userId, name);
    return name;
  }

  private async setStatus(
    id: string,
    status: string,
    decidedBy?: string,
  ): Promise<void> {
    const patch: Record<string, unknown> = { status };
    if (decidedBy) {
      patch.decided_by = decidedBy;
      patch.decided_at = new Date().toISOString();
    }
    const { error } = await this.client
      .from("control_requests")
      .update(patch)
      .eq("id", id);
    if (error) log.warn({ err: error.message }, "control status update failed");
  }

  private async handle(row: DbControlRow): Promise<void> {
    const parsed = ControlRequestRow.pick({ action: true }).safeParse({
      action: row.action,
    });
    if (!parsed.success) {
      await this.setStatus(row.id, "failed", this.hostUserId);
      return;
    }
    const action = parsed.data.action;
    const actorIsHost = row.requested_by === this.hostUserId;
    const actorName = await this.nameOf(row.requested_by);

    let actorOwnsTarget = false;
    let target: DbControlRow | null = null;
    if (
      action.kind === "cancel" ||
      action.kind === "approve" ||
      action.kind === "reject"
    ) {
      const { data } = await this.client
        .from("control_requests")
        .select("id, session_id, requested_by, action, status, created_at")
        .eq("id", action.targetId)
        .eq("session_id", this.sessionId)
        .maybeSingle();
      target = (data as DbControlRow | null) ?? null;
      actorOwnsTarget = target?.requested_by === row.requested_by;
    }

    const decision = authorize(action, {
      mode: this.mode,
      actorIsHost,
      actorOwnsTarget,
    });

    if (decision === "reject") {
      await this.setStatus(row.id, "rejected", this.hostUserId);
      return;
    }
    if (decision === "queue_for_approval") {
      await this.setStatus(row.id, "needs_approval");
      if (action.kind === "send_message") {
        await this.handlers.noteQueued(row.id, actorName, action.text);
      }
      return;
    }
    await this.execute(row, action, actorName);
  }

  private async execute(
    row: DbControlRow,
    action: ControlAction,
    actorName: string,
  ): Promise<void> {
    switch (action.kind) {
      case "send_message":
        await this.handlers.sendMessage(
          action.text,
          row.requested_by,
          actorName,
        );
        await this.setStatus(row.id, "applied");
        return;
      case "interrupt":
        await this.handlers.interrupt();
        await this.setStatus(row.id, "applied");
        return;
      case "permission_decision": {
        const won = await this.handlers.permissionDecision(
          action.requestId,
          action.decision,
          actorName,
        );
        await this.setStatus(row.id, won ? "applied" : "superseded");
        return;
      }
      case "set_model":
        await this.handlers.setModel(action.model, actorName);
        await this.setStatus(row.id, "applied");
        return;
      case "set_permission_mode":
        await this.handlers.setPermissionMode(action.permissionMode, actorName);
        await this.setStatus(row.id, "applied");
        return;
      case "set_session_mode":
        this.mode = action.sessionMode;
        await this.handlers.setSessionMode(action.sessionMode, actorName);
        await this.setStatus(row.id, "applied");
        return;
      case "cancel": {
        const { error } = await this.client
          .from("control_requests")
          .update({ status: "superseded" })
          .eq("id", action.targetId)
          .in("status", ["pending", "needs_approval"]);
        await this.setStatus(row.id, error ? "failed" : "applied");
        return;
      }
      case "approve":
      case "reject": {
        const target = await this.client
          .from("control_requests")
          .select("id, requested_by, action, status")
          .eq("id", action.targetId)
          .maybeSingle();
        const t = target.data as DbControlRow | null;
        if (!t || t.status !== "needs_approval") {
          await this.setStatus(row.id, "failed");
          return;
        }
        if (action.kind === "reject") {
          await this.setStatus(t.id, "rejected", row.requested_by);
          await this.setStatus(row.id, "applied");
          return;
        }
        const targetAction = ControlRequestRow.pick({ action: true }).safeParse(
          {
            action: t.action,
          },
        );
        if (!targetAction.success) {
          await this.setStatus(t.id, "failed", row.requested_by);
          await this.setStatus(row.id, "failed");
          return;
        }
        const requesterName = await this.nameOf(t.requested_by);
        await this.setStatus(t.id, "approved", row.requested_by);
        await this.execute(
          { ...t, session_id: this.sessionId, created_at: "" },
          targetAction.data.action,
          requesterName,
        );
        await this.setStatus(row.id, "applied");
        return;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.channel) await this.client.removeChannel(this.channel);
  }
}
