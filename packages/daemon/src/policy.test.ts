import type { ControlAction } from "@ccshare/protocol";
import { describe, expect, it } from "vitest";
import { authorize, type PolicyDecision } from "./policy.js";

const actions: Record<string, ControlAction> = {
  send: { kind: "send_message", text: "hi", attachments: [] },
  interrupt: { kind: "interrupt" },
  permission: {
    kind: "permission_decision",
    requestId: "p1",
    decision: "allow",
  },
  model: { kind: "set_model", model: "opus" },
  permMode: { kind: "set_permission_mode", permissionMode: "plan" },
  sessionMode: { kind: "set_session_mode", sessionMode: "equal" },
  approve: { kind: "approve", targetId: "c1" },
  reject: { kind: "reject", targetId: "c1" },
  cancelOwn: { kind: "cancel", targetId: "c1" },
};

// The full matrix from PRD §5.3 / DESIGN §3.3, exhaustively.
const cases: [string, "equal" | "moderated", boolean, PolicyDecision][] = [
  // hosts can do everything in both modes
  ...Object.keys(actions).map(
    (name): [string, "equal", boolean, PolicyDecision] => [
      name,
      "equal",
      true,
      "apply",
    ],
  ),
  ...Object.keys(actions).map(
    (name): [string, "moderated", boolean, PolicyDecision] => [
      name,
      "moderated",
      true,
      "apply",
    ],
  ),
  // guest, equal mode
  ["send", "equal", false, "apply"],
  ["interrupt", "equal", false, "apply"],
  ["permission", "equal", false, "apply"],
  ["model", "equal", false, "apply"],
  ["permMode", "equal", false, "apply"],
  ["sessionMode", "equal", false, "reject"],
  ["approve", "equal", false, "reject"],
  ["reject", "equal", false, "reject"],
  // guest, moderated mode
  ["send", "moderated", false, "queue_for_approval"],
  ["interrupt", "moderated", false, "apply"],
  ["permission", "moderated", false, "reject"],
  ["model", "moderated", false, "queue_for_approval"],
  ["permMode", "moderated", false, "queue_for_approval"],
  ["sessionMode", "moderated", false, "reject"],
  ["approve", "moderated", false, "reject"],
  ["reject", "moderated", false, "reject"],
];

describe("authorize", () => {
  it.each(cases)(
    "%s in %s mode (host=%s) → %s",
    (name, mode, isHost, expected) => {
      const action = actions[name];
      if (!action) throw new Error(`unknown action ${name}`);
      expect(
        authorize(action, {
          mode,
          actorIsHost: isHost,
          actorOwnsTarget: isHost,
        }),
      ).toBe(expected);
    },
  );

  it("guests may cancel their own requests but not others'", () => {
    const cancel = actions.cancelOwn;
    if (!cancel) throw new Error("missing action");
    expect(
      authorize(cancel, {
        mode: "moderated",
        actorIsHost: false,
        actorOwnsTarget: true,
      }),
    ).toBe("apply");
    expect(
      authorize(cancel, {
        mode: "moderated",
        actorIsHost: false,
        actorOwnsTarget: false,
      }),
    ).toBe("reject");
    expect(
      authorize(cancel, {
        mode: "equal",
        actorIsHost: false,
        actorOwnsTarget: true,
      }),
    ).toBe("apply");
  });
});
