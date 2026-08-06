import type {
  AssistantContentBlock,
  Attachment,
  EventRow,
  PermissionMode,
  RunStatus,
  SessionMode,
  TokenUsage,
} from "./events";

// One reducer for live and replay — DESIGN.md §6.2. Live folds the realtime
// stream; replay folds the fetched log. Token deltas live in a separate
// provisional overlay (applyDelta/clearProvisional), never in durable state.

export type ToolCallState = {
  toolUseId: string;
  toolName: string;
  input: unknown;
  inputTruncated: boolean;
  output?: unknown;
  outputTruncated?: boolean;
  isError?: boolean;
  done: boolean;
};

export type TranscriptItem =
  | {
      kind: "user";
      seq: number;
      authorUserId: string | null;
      authorName: string;
      via: "web" | "tui";
      text: string;
      attachments: Attachment[];
    }
  | {
      kind: "assistant";
      seq: number;
      messageId: string;
      blocks: AssistantContentBlock[];
    }
  | { kind: "thinking"; seq: number; messageId: string; text: string }
  | {
      kind: "permission";
      seq: number;
      requestId: string;
      toolName: string;
      inputSummary: string;
      input: unknown;
      decision?: "allow" | "deny";
      decidedByName?: string;
    }
  | {
      kind: "turn_result";
      seq: number;
      durationMs: number;
      usage?: TokenUsage;
      costUsd?: number;
      isError: boolean;
    }
  | {
      kind: "settings";
      seq: number;
      field: "model" | "permission_mode" | "session_mode";
      value: string;
      changedByName: string;
    }
  | {
      kind: "note";
      seq: number;
      note: "queued" | "approved" | "rejected" | "cancelled" | "failed";
      controlId: string;
      authorName: string;
      text?: string;
    }
  | { kind: "session_ended"; seq: number; reason: string };

export type SessionState = {
  lastSeq: number;
  items: TranscriptItem[];
  // tool calls are rendered inline via assistant block refs; state lives here
  toolCalls: Record<string, ToolCallState>;
  pendingPermissionIds: string[];
  status: RunStatus;
  cwd?: string;
  hostName?: string;
  model?: string;
  permissionMode?: PermissionMode;
  sessionMode: SessionMode;
  ended: boolean;
  endedReason?: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turns: number;
  };
};

export function initialSessionState(): SessionState {
  return {
    lastSeq: 0,
    items: [],
    toolCalls: {},
    pendingPermissionIds: [],
    status: "idle",
    sessionMode: "moderated",
    ended: false,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 },
  };
}

// Pure and idempotent: rows at or below lastSeq are ignored, so replayed or
// double-delivered broadcasts cannot corrupt state.
export function reduceSession(
  state: SessionState,
  row: EventRow,
): SessionState {
  if (row.seq <= state.lastSeq) return state;
  const e = row.event;
  const next: SessionState = {
    ...state,
    lastSeq: row.seq,
    items: state.items,
    toolCalls: state.toolCalls,
    pendingPermissionIds: state.pendingPermissionIds,
    totals: state.totals,
  };

  switch (e.type) {
    case "session_started": {
      next.cwd = e.cwd;
      next.hostName = e.hostName;
      next.model = e.model;
      next.permissionMode = e.permissionMode;
      next.sessionMode = e.sessionMode;
      break;
    }
    case "user_message": {
      next.items = [
        ...state.items,
        {
          kind: "user",
          seq: row.seq,
          authorUserId: row.authorUserId,
          authorName: e.authorName,
          via: e.via,
          text: e.text,
          attachments: e.attachments,
        },
      ];
      break;
    }
    case "assistant_message": {
      next.items = [
        ...state.items,
        {
          kind: "assistant",
          seq: row.seq,
          messageId: e.messageId,
          blocks: e.content,
        },
      ];
      if (e.model) next.model = e.model;
      break;
    }
    case "thinking": {
      next.items = [
        ...state.items,
        {
          kind: "thinking",
          seq: row.seq,
          messageId: e.messageId,
          text: e.text,
        },
      ];
      break;
    }
    case "tool_use": {
      next.toolCalls = {
        ...state.toolCalls,
        [e.toolUseId]: {
          toolUseId: e.toolUseId,
          toolName: e.toolName,
          input: e.input,
          inputTruncated: e.truncated,
          done: false,
        },
      };
      break;
    }
    case "tool_result": {
      const call = state.toolCalls[e.toolUseId];
      if (!call) break;
      next.toolCalls = {
        ...state.toolCalls,
        [e.toolUseId]: {
          ...call,
          output: e.output,
          outputTruncated: e.truncated,
          isError: e.isError,
          done: true,
        },
      };
      break;
    }
    case "permission_request": {
      next.items = [
        ...state.items,
        {
          kind: "permission",
          seq: row.seq,
          requestId: e.requestId,
          toolName: e.toolName,
          inputSummary: e.inputSummary,
          input: e.input,
        },
      ];
      next.pendingPermissionIds = [...state.pendingPermissionIds, e.requestId];
      next.status = "awaiting_permission";
      break;
    }
    case "permission_decision": {
      next.items = state.items.map((item) =>
        item.kind === "permission" && item.requestId === e.requestId
          ? { ...item, decision: e.decision, decidedByName: e.decidedByName }
          : item,
      );
      next.pendingPermissionIds = state.pendingPermissionIds.filter(
        (id) => id !== e.requestId,
      );
      if (
        next.pendingPermissionIds.length === 0 &&
        state.status === "awaiting_permission"
      ) {
        next.status = "working";
      }
      break;
    }
    case "turn_result": {
      next.items = [
        ...state.items,
        {
          kind: "turn_result",
          seq: row.seq,
          durationMs: e.durationMs,
          usage: e.usage,
          costUsd: e.costUsd,
          isError: e.isError,
        },
      ];
      next.totals = {
        inputTokens: state.totals.inputTokens + (e.usage?.inputTokens ?? 0),
        outputTokens: state.totals.outputTokens + (e.usage?.outputTokens ?? 0),
        costUsd: state.totals.costUsd + (e.costUsd ?? 0),
        turns: state.totals.turns + 1,
      };
      break;
    }
    case "status_change": {
      next.status = e.status;
      break;
    }
    case "settings_change": {
      next.items = [
        ...state.items,
        {
          kind: "settings",
          seq: row.seq,
          field: e.field,
          value: e.value,
          changedByName: e.changedByName,
        },
      ];
      if (e.field === "model") next.model = e.value;
      if (e.field === "permission_mode")
        next.permissionMode = e.value as PermissionMode;
      if (e.field === "session_mode") next.sessionMode = e.value as SessionMode;
      break;
    }
    case "control_note": {
      next.items = [
        ...state.items,
        {
          kind: "note",
          seq: row.seq,
          note: e.note,
          controlId: e.controlId,
          authorName: e.authorName,
          text: e.text,
        },
      ];
      break;
    }
    case "session_ended": {
      next.items = [
        ...state.items,
        { kind: "session_ended", seq: row.seq, reason: e.reason },
      ];
      next.ended = true;
      next.endedReason = e.reason;
      next.status = "idle";
      break;
    }
  }
  return next;
}

export function reduceAll(rows: EventRow[]): SessionState {
  return rows.reduce(reduceSession, initialSessionState());
}

// ---------------------------------------------------------------------------
// Provisional overlay for streaming deltas (DESIGN §3.2). Kept apart from
// SessionState so durable state stays a pure function of the event log.

export type ProvisionalState = {
  text: Record<string, string>;
  thinking: Record<string, string>;
};

export function initialProvisionalState(): ProvisionalState {
  return { text: {}, thinking: {} };
}

export function applyDelta(
  p: ProvisionalState,
  messageId: string,
  lane: "text" | "thinking",
  chunk: string,
): ProvisionalState {
  const store = lane === "text" ? p.text : p.thinking;
  const updated = { ...store, [messageId]: (store[messageId] ?? "") + chunk };
  return lane === "text"
    ? { ...p, text: updated }
    : { ...p, thinking: updated };
}

// Called when the durable message lands; the overlay entry is superseded.
export function clearProvisional(
  p: ProvisionalState,
  messageId: string,
): ProvisionalState {
  if (!(messageId in p.text) && !(messageId in p.thinking)) return p;
  const { [messageId]: _t, ...text } = p.text;
  const { [messageId]: _k, ...thinking } = p.thinking;
  return { text, thinking };
}
