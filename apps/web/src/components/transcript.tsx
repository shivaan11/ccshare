"use client";

import type {
  ProvisionalState,
  SessionState,
  ToolCallState,
  TranscriptItem,
} from "@ccshare/protocol";
import { ToolCard } from "./tool-card";

function UserItem({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "user" }>;
}) {
  return (
    <div className="rounded border border-border bg-panel-2 px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold text-accent">
        {item.authorName}
        {item.via === "tui" && <span className="text-muted"> · terminal</span>}
      </div>
      <div className="whitespace-pre-wrap text-sm">{item.text}</div>
    </div>
  );
}

function AssistantItem({
  item,
  toolCalls,
}: {
  item: Extract<TranscriptItem, { kind: "assistant" }>;
  toolCalls: Record<string, ToolCallState>;
}) {
  return (
    <div className="flex flex-col gap-2">
      {item.blocks.map((block, i) =>
        block.type === "text" ? (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static block list
            key={i}
            className="whitespace-pre-wrap text-sm leading-relaxed"
          >
            {block.text}
          </div>
        ) : (
          <ToolCard key={block.toolUseId} call={toolCalls[block.toolUseId]} />
        ),
      )}
    </div>
  );
}

function PermissionItem({
  item,
  onDecide,
}: {
  item: Extract<TranscriptItem, { kind: "permission" }>;
  onDecide?: (requestId: string, decision: "allow" | "deny") => void;
}) {
  const border =
    item.decision === undefined
      ? "border-warn"
      : item.decision === "allow"
        ? "border-good"
        : "border-bad";
  return (
    <div className={`rounded border ${border} bg-panel px-3 py-2 text-sm`}>
      <span className="text-warn">⚠ permission</span>{" "}
      <span className="font-semibold">{item.toolName}</span>
      <span className="ml-2 break-all text-xs text-muted">
        {item.inputSummary}
      </span>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {item.decision === undefined ? (
          <>
            <span className="text-warn">waiting for a decision…</span>
            {onDecide && (
              <>
                <button
                  type="button"
                  onClick={() => onDecide(item.requestId, "allow")}
                  className="rounded bg-good px-2 py-0.5 font-semibold text-bg"
                >
                  allow
                </button>
                <button
                  type="button"
                  onClick={() => onDecide(item.requestId, "deny")}
                  className="rounded bg-bad px-2 py-0.5 font-semibold text-bg"
                >
                  deny
                </button>
              </>
            )}
          </>
        ) : (
          <span
            className={item.decision === "allow" ? "text-good" : "text-bad"}
          >
            {item.decision === "allow" ? "allowed" : "denied"} by{" "}
            {item.decidedByName}
          </span>
        )}
      </div>
    </div>
  );
}

function SystemLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-0.5 text-center text-xs text-muted">{children}</div>
  );
}

export function Transcript({
  state,
  provisional,
  onPermissionDecide,
}: {
  state: SessionState;
  provisional: ProvisionalState;
  onPermissionDecide?: (requestId: string, decision: "allow" | "deny") => void;
}) {
  const streamingText = Object.entries(provisional.text);
  const streamingThinking = Object.entries(provisional.thinking);

  return (
    <div className="flex flex-col gap-3">
      {state.items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserItem key={item.seq} item={item} />;
          case "assistant":
            return (
              <AssistantItem
                key={item.seq}
                item={item}
                toolCalls={state.toolCalls}
              />
            );
          case "thinking":
            return (
              <details key={item.seq} className="text-xs text-muted">
                <summary className="cursor-pointer select-none">
                  thinking
                </summary>
                <div className="mt-1 whitespace-pre-wrap border-l border-border pl-3 italic">
                  {item.text}
                </div>
              </details>
            );
          case "permission":
            return (
              <PermissionItem
                key={item.seq}
                item={item}
                onDecide={onPermissionDecide}
              />
            );
          case "turn_result":
            return (
              <SystemLine key={item.seq}>
                — turn done in {(item.durationMs / 1000).toFixed(1)}s
                {item.usage &&
                  ` · ${item.usage.inputTokens + item.usage.outputTokens} tokens`}
                {item.isError && <span className="text-bad"> · error</span>} —
              </SystemLine>
            );
          case "settings":
            return (
              <SystemLine key={item.seq}>
                {item.changedByName} set {item.field.replace("_", " ")} →{" "}
                {item.value}
              </SystemLine>
            );
          case "note":
            return (
              <SystemLine key={item.seq}>
                {item.authorName}: message {item.note}
                {item.text ? ` — “${item.text.slice(0, 80)}”` : ""}
              </SystemLine>
            );
          case "session_ended":
            return (
              <SystemLine key={item.seq}>
                session ended ({item.reason})
              </SystemLine>
            );
          default:
            return null;
        }
      })}

      {streamingThinking.map(([id, text]) => (
        <div key={id} className="text-xs italic text-muted">
          <span className="not-italic">thinking… </span>
          {text.slice(-400)}
        </div>
      ))}
      {streamingText.map(([id, text]) => (
        <div key={id} className="whitespace-pre-wrap text-sm leading-relaxed">
          {text}
          <span className="animate-pulse text-accent">▌</span>
        </div>
      ))}
    </div>
  );
}
