"use client";

import type { ToolCallState } from "@ccshare/protocol";

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function inputSummary(call: ToolCallState): string {
  const input = call.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return "";
  const known =
    (input.file_path as string) ??
    (input.command as string) ??
    (input.path as string) ??
    (input.pattern as string) ??
    (input.url as string);
  return known ? String(known) : asText(input).slice(0, 120);
}

// Per-tool rendering: Edit/Write get diff-style blocks, Bash gets a terminal
// look, everything else collapses to name + summary with expandable payloads.
export function ToolCard({ call }: { call: ToolCallState | undefined }) {
  if (!call) return null;
  const input = (call.input ?? {}) as Record<string, unknown>;
  const statusDot = !call.done ? (
    <span className="animate-pulse text-warn">●</span>
  ) : call.isError ? (
    <span className="text-bad">●</span>
  ) : (
    <span className="text-good">●</span>
  );

  const isEdit = call.toolName === "Edit" || call.toolName === "Write";
  const isBash = call.toolName === "Bash";

  return (
    <details className="rounded border border-border bg-panel text-xs">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5">
        {statusDot}
        <span className="font-semibold">{call.toolName}</span>
        <span className="truncate text-muted">{inputSummary(call)}</span>
      </summary>

      <div className="border-t border-border px-3 py-2">
        {isEdit ? (
          <div className="flex flex-col gap-1">
            <div className="text-muted">{String(input.file_path ?? "")}</div>
            {typeof input.old_string === "string" &&
              input.old_string.length > 0 && (
                <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-[#2d1b22] p-2 text-bad">
                  {input.old_string.slice(0, 4000)}
                </pre>
              )}
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-[#1b2d1f] p-2 text-good">
              {asText(input.new_string ?? input.content).slice(0, 4000)}
            </pre>
          </div>
        ) : isBash ? (
          <div className="flex flex-col gap-1">
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black p-2">
              <span className="text-good">$ </span>
              {String(input.command ?? "")}
            </pre>
          </div>
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
            {asText(call.input).slice(0, 4000)}
          </pre>
        )}

        {call.done && (
          <div className="mt-2">
            <div className="mb-1 text-muted">
              output{call.outputTruncated && " (truncated)"}
              {call.isError && <span className="text-bad"> · error</span>}
            </div>
            <pre
              className={`max-h-64 overflow-auto whitespace-pre-wrap rounded p-2 ${
                call.isError ? "bg-[#2d1b22]" : "bg-panel-2"
              }`}
            >
              {asText(call.output).slice(0, 8000)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
