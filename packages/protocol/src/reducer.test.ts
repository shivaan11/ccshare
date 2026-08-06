import { describe, expect, it } from "vitest";
import type { EventRow, SessionEvent } from "./events.js";
import {
  applyDelta,
  clearProvisional,
  initialProvisionalState,
  initialSessionState,
  reduceAll,
  reduceSession,
} from "./reducer.js";

let seqCounter = 0;
function row(event: SessionEvent, author: string | null = null): EventRow {
  seqCounter += 1;
  return {
    sessionId: "s1",
    seq: seqCounter,
    authorUserId: author,
    createdAt: new Date(0).toISOString(),
    event,
  };
}

function sampleSession(): EventRow[] {
  seqCounter = 0;
  return [
    row({
      type: "session_started",
      cwd: "/repo",
      model: "opus",
      permissionMode: "default",
      sessionMode: "equal",
      hostName: "shivaan",
      resumed: false,
    }),
    row(
      {
        type: "user_message",
        text: "add a --dry-run flag",
        authorName: "anmol",
        via: "web",
        attachments: [],
      },
      "u-anmol",
    ),
    row({ type: "status_change", status: "working" }),
    row({
      type: "thinking",
      messageId: "m1",
      text: "planning the flag",
    }),
    row({
      type: "assistant_message",
      messageId: "m1",
      content: [
        { type: "text", text: "Adding it now." },
        { type: "tool_use", toolUseId: "t1", toolName: "Edit" },
      ],
    }),
    row({
      type: "tool_use",
      toolUseId: "t1",
      toolName: "Edit",
      input: { file_path: "cli.py" },
      truncated: false,
    }),
    row({
      type: "permission_request",
      requestId: "p1",
      toolName: "Edit",
      inputSummary: "edit cli.py",
      input: { file_path: "cli.py" },
    }),
    row({
      type: "permission_decision",
      requestId: "p1",
      decision: "allow",
      decidedByName: "shivaan",
    }),
    row({
      type: "tool_result",
      toolUseId: "t1",
      output: "ok",
      isError: false,
      truncated: false,
    }),
    row({
      type: "turn_result",
      durationMs: 4200,
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0.02,
      isError: false,
    }),
    row({ type: "status_change", status: "idle" }),
  ];
}

describe("reduceSession", () => {
  it("builds transcript state from a full turn", () => {
    const state = reduceAll(sampleSession());
    expect(state.hostName).toBe("shivaan");
    expect(state.sessionMode).toBe("equal");
    expect(state.status).toBe("idle");
    expect(state.items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(state.toolCalls.t1?.done).toBe(true);
    expect(state.toolCalls.t1?.isError).toBe(false);
    expect(state.pendingPermissionIds).toEqual([]);
    const perm = state.items.find((i) => i.kind === "permission");
    expect(perm && perm.kind === "permission" && perm.decision).toBe("allow");
    expect(state.totals).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.02,
      turns: 1,
    });
  });

  it("is idempotent: re-delivered rows never change state", () => {
    const rows = sampleSession();
    const once = reduceAll(rows);
    const redelivered = rows.reduce(reduceSession, once);
    expect(redelivered).toEqual(once);
  });

  it("incremental folding equals batch replay at every prefix", () => {
    const rows = sampleSession();
    let incremental = initialSessionState();
    rows.forEach((r, i) => {
      incremental = reduceSession(incremental, r);
      expect(incremental).toEqual(reduceAll(rows.slice(0, i + 1)));
    });
  });

  it("tracks permission pending state and awaiting status", () => {
    const rows = sampleSession();
    const untilRequest = reduceAll(rows.slice(0, 7));
    expect(untilRequest.pendingPermissionIds).toEqual(["p1"]);
    expect(untilRequest.status).toBe("awaiting_permission");
  });

  it("marks session ended", () => {
    const rows = [
      ...sampleSession(),
      row({ type: "session_ended", reason: "host_exit" }),
    ];
    const state = reduceAll(rows);
    expect(state.ended).toBe(true);
    expect(state.endedReason).toBe("host_exit");
  });
});

describe("provisional overlay", () => {
  it("accumulates deltas per message and lane, then clears", () => {
    let p = initialProvisionalState();
    p = applyDelta(p, "m1", "text", "Hello ");
    p = applyDelta(p, "m1", "text", "world");
    p = applyDelta(p, "m1", "thinking", "hmm");
    expect(p.text.m1).toBe("Hello world");
    expect(p.thinking.m1).toBe("hmm");
    p = clearProvisional(p, "m1");
    expect(p.text.m1).toBeUndefined();
    expect(p.thinking.m1).toBeUndefined();
  });
});
