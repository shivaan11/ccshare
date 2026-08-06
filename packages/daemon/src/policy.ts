import type { ControlAction, SessionMode } from "@ccshare/protocol";

// The moderation matrix (PRD §5.3, DESIGN §3.3) as one pure function.
// Enforced here — in the daemon, at the trust boundary — never in the UI.

export type PolicyDecision = "apply" | "queue_for_approval" | "reject";

export type PolicyContext = {
  mode: SessionMode;
  actorIsHost: boolean;
  // for `cancel`: whether the actor authored the request being cancelled
  actorOwnsTarget?: boolean;
};

export function authorize(
  action: ControlAction,
  ctx: PolicyContext,
): PolicyDecision {
  if (ctx.actorIsHost) {
    // The host can do everything, always — it's their machine.
    return "apply";
  }

  switch (action.kind) {
    case "interrupt":
      // Free for guests in both modes (explicit product decision).
      return "apply";
    case "cancel":
      // Guests may withdraw their own queued/pending requests only.
      return ctx.actorOwnsTarget ? "apply" : "reject";
    case "approve":
    case "reject":
      // Deciding others' pending actions is host-only in every mode.
      return "reject";
    case "set_session_mode":
      // Mode switching is host-only in every mode.
      return "reject";
    case "permission_decision":
      // Equal: first responder wins. Moderated: host only.
      return ctx.mode === "equal" ? "apply" : "reject";
    case "send_message":
    case "set_model":
    case "set_permission_mode":
      return ctx.mode === "equal" ? "apply" : "queue_for_approval";
  }
}
