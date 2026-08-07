"use client";

import type { ControlAction } from "@ccshare/protocol";
import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// M2 composer: every action is a control_requests INSERT; the host daemon is
// the only executor (DESIGN §3.3). Chips show my requests' lifecycle.

type ControlRow = {
  id: string;
  requested_by: string;
  action: { kind: string; text?: string };
  status: string;
};

export function useSendControl(sessionId: string) {
  return async (action: ControlAction): Promise<string | null> => {
    const supabase = supabaseBrowser();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return "not signed in";
    const { error } = await supabase.from("control_requests").insert({
      session_id: sessionId,
      requested_by: user.id,
      action,
    });
    return error ? error.message : null;
  };
}

export function Composer({
  sessionId,
  status,
  disabled,
  onDraft,
}: {
  sessionId: string;
  status: string;
  disabled: boolean;
  onDraft?: (text: string, shared: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [shareDraft, setShareDraft] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [requests, setRequests] = useState<ControlRow[]>([]);
  const send = useSendControl(sessionId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    void supabase.auth
      .getUser()
      .then(({ data }) => setMyId(data.user?.id ?? null));

    const channel = supabase
      .channel(`control-watch:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "control_requests",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as ControlRow;
          if (!row?.id) return;
          setRequests((prev) => {
            const rest = prev.filter((r) => r.id !== row.id);
            return [...rest, row].slice(-20);
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionId]);

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    onDraft?.("", shareDraft);
    setError(null);
    const err = await send({
      kind: "send_message",
      text: value,
      attachments: [],
    });
    if (err) {
      setError(err);
      setText(value);
    }
  };

  const interrupt = async () => {
    setError(null);
    const err = await send({ kind: "interrupt" });
    if (err) setError(err);
  };

  const visible = requests.filter(
    (r) =>
      (r.status === "pending" || r.status === "needs_approval") &&
      r.action.kind === "send_message",
  );

  return (
    <div className="border-t border-border py-3">
      {visible.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {visible.map((r) => (
            <span
              key={r.id}
              className="rounded border border-border bg-panel px-2 py-1 text-[11px] text-muted"
            >
              {r.status === "needs_approval"
                ? "⏳ awaiting host approval"
                : "⏳ queued"}
              {r.action.text ? ` — “${r.action.text.slice(0, 60)}”` : ""}
              {myId === r.requested_by && (
                <button
                  type="button"
                  className="ml-2 text-bad hover:underline"
                  onClick={() => void send({ kind: "cancel", targetId: r.id })}
                >
                  cancel
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            onDraft?.(e.target.value, shareDraft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder={
            disabled ? "session is not live" : "message Claude… (Enter to send)"
          }
          className="flex-1 resize-none rounded border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={disabled || text.trim().length === 0}
            className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-bg disabled:opacity-40"
          >
            send
          </button>
          <button
            type="button"
            onClick={() => void interrupt()}
            disabled={disabled || status === "idle"}
            className="rounded border border-bad px-3 py-1.5 text-xs text-bad hover:bg-bad hover:text-bg disabled:opacity-40"
            title="stop Claude mid-turn"
          >
            ⏹ stop
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
        <span>
          {status === "working" &&
            "Claude is working — messages sent now will queue for the next turn."}
        </span>
        <button
          type="button"
          onClick={() => {
            const next = !shareDraft;
            setShareDraft(next);
            onDraft?.(text, next);
          }}
          className="hover:text-ink"
          title="when on, your co-worker sees what you're typing before you send"
        >
          draft sharing: {shareDraft ? "on" : "off"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}
