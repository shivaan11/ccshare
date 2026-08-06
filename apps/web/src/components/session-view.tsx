"use client";

import {
  applyDelta,
  BroadcastMessage,
  clearProvisional,
  type EventRow,
  initialProvisionalState,
  initialSessionState,
  type ProvisionalState,
  reduceSession,
  SessionEvent,
  type SessionState,
} from "@ccshare/protocol";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Transcript } from "./transcript";

// Catch-up rule (DESIGN §3.4): subscribe first (buffering), then backfill from
// Postgres by seq, then drain the buffer. The reducer dedups by seq, so overlap
// between backfill and buffered broadcasts is harmless. Replay is the same path
// minus the live tail.

type DbEventRow = {
  session_id: string;
  seq: number;
  author_user_id: string | null;
  payload: unknown;
  created_at: string;
};

function toEventRow(row: DbEventRow): EventRow | null {
  const parsed = SessionEvent.safeParse(row.payload);
  if (!parsed.success) return null;
  return {
    sessionId: row.session_id,
    seq: row.seq,
    authorUserId: row.author_user_id,
    createdAt: row.created_at,
    event: parsed.data,
  };
}

export function SessionView({
  sessionId,
  initialStatus,
  kind,
  hostName,
  title,
}: {
  sessionId: string;
  initialStatus: "live" | "ended";
  kind: "shared" | "mirror";
  hostName: string;
  title: string;
}) {
  const [state, setState] = useState<SessionState>(initialSessionState);
  const [provisional, setProvisional] = useState<ProvisionalState>(
    initialProvisionalState,
  );
  const [connected, setConnected] = useState(false);
  const [caughtUp, setCaughtUp] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    let disposed = false;
    const buffer: EventRow[] = [];
    let live = false;

    const apply = (row: EventRow) => {
      setState((s) => reduceSession(s, row));
      if (
        row.event.type === "assistant_message" ||
        row.event.type === "thinking"
      ) {
        const id =
          row.event.type === "assistant_message" ||
          row.event.type === "thinking"
            ? row.event.messageId
            : "";
        setProvisional((p) => clearProvisional(p, id));
      }
    };

    const channel = supabase
      .channel(`session:${sessionId}`, {
        config: { private: true, broadcast: { self: false } },
      })
      .on("broadcast", { event: "event" }, ({ payload }) => {
        const msg = BroadcastMessage.safeParse(payload);
        if (!msg.success || msg.data.type !== "event") return;
        if (live) apply(msg.data.row);
        else buffer.push(msg.data.row);
      })
      .on("broadcast", { event: "delta" }, ({ payload }) => {
        const msg = BroadcastMessage.safeParse(payload);
        if (!msg.success || msg.data.type !== "delta") return;
        const { messageId, lane, text } = msg.data;
        setProvisional((p) => applyDelta(p, messageId, lane, text));
      })
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));

    const backfill = async () => {
      const pageSize = 1000;
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("events")
          .select("session_id, seq, author_user_id, payload, created_at")
          .eq("session_id", sessionId)
          .order("seq", { ascending: true })
          .range(from, from + pageSize - 1);
        if (disposed || error) break;
        for (const raw of (data ?? []) as DbEventRow[]) {
          const row = toEventRow(raw);
          if (row) apply(row);
        }
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      live = true;
      for (const row of buffer.splice(0)) apply(row);
      setCaughtUp(true);
    };
    void backfill();

    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
  }, [sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.lastSeq, provisional]);

  const status = state.ended ? "ended" : state.status;
  const statusColor =
    status === "working"
      ? "text-accent"
      : status === "awaiting_permission"
        ? "text-warn"
        : status === "ended"
          ? "text-muted"
          : "text-good";

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col px-4">
      <header className="flex items-center gap-3 border-b border-border py-3 text-sm">
        <Link href="/" className="text-muted hover:text-ink">
          ←
        </Link>
        <span className="truncate font-semibold">{title}</span>
        {kind === "mirror" && (
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">
            mirror · read-only
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span>
            host {hostName} · {hostName}&apos;s plan
          </span>
          {state.model && <span>{state.model}</span>}
          <span>{state.sessionMode}</span>
          <span className={statusColor}>
            {initialStatus === "ended" || state.ended ? "ended" : status}
          </span>
          <span className={connected ? "text-good" : "text-warn"}>
            {connected ? "●" : "○"}
          </span>
        </span>
      </header>

      <main className="flex-1 overflow-y-auto py-4">
        {!caughtUp && <p className="text-sm text-muted">loading transcript…</p>}
        <Transcript state={state} provisional={provisional} />
        <div ref={bottomRef} />
      </main>

      <footer className="border-t border-border py-3 text-xs text-muted">
        {state.ended || initialStatus === "ended"
          ? "session ended — replay"
          : kind === "mirror"
            ? "read-only mirror of a terminal session"
            : `watching live · ${state.totals.turns} turns · ${state.totals.inputTokens + state.totals.outputTokens} tokens`}
      </footer>
    </div>
  );
}
