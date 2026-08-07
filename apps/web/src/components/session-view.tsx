"use client";

import {
  applyDelta,
  BroadcastMessage,
  clearProvisional,
  type EventRow,
  initialProvisionalState,
  initialSessionState,
  type PresenceState,
  type ProvisionalState,
  reduceSession,
  SessionEvent,
  type SessionState,
} from "@ccshare/protocol";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ApprovalTray } from "./approval-tray";
import { Composer, useSendControl } from "./composer";
import { Transcript } from "./transcript";

// Catch-up rule (DESIGN §3.4): subscribe first (buffering), then backfill from
// Postgres by seq, then drain the buffer. The reducer dedups by seq, so overlap
// between backfill and buffered broadcasts is harmless. Replay is the same path
// minus the live tail. Presence rides the same private channel.

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
  hostUserId,
  names,
  title,
}: {
  sessionId: string;
  initialStatus: "live" | "ended";
  kind: "shared" | "mirror";
  hostUserId: string;
  names: Record<string, string>;
  title: string;
}) {
  const [state, setState] = useState<SessionState>(initialSessionState);
  const [provisional, setProvisional] = useState<ProvisionalState>(
    initialProvisionalState,
  );
  const [connected, setConnected] = useState(false);
  const [caughtUp, setCaughtUp] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<PresenceState[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<((self: PresenceState) => void) | null>(null);
  const selfRef = useRef<PresenceState | null>(null);
  const sendControl = useSendControl(sessionId);

  useEffect(() => {
    const supabase = supabaseBrowser();
    let disposed = false;
    const buffer: EventRow[] = [];
    let live = false;

    const apply = (row: EventRow) => {
      setState((s) => reduceSession(s, row));
      const ev = row.event;
      if (ev.type === "assistant_message" || ev.type === "thinking") {
        const { messageId } = ev;
        setProvisional((p) => clearProvisional(p, messageId));
      }
    };

    const setup = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (disposed || !user) return;
      setMyId(user.id);
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("user_id", user.id)
        .maybeSingle();

      selfRef.current = {
        userId: user.id,
        name: profile?.display_name ?? user.email ?? "me",
        typing: false,
        draftShared: true,
        draftText: null,
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
        .on("presence", { event: "sync" }, () => {
          const all = Object.values(
            channel.presenceState<PresenceState>(),
          ).flat();
          setPeers(all.filter((p) => p.userId !== user.id));
        })
        .subscribe((status) => {
          setConnected(status === "SUBSCRIBED");
          if (status === "SUBSCRIBED" && selfRef.current) {
            void channel.track(selfRef.current);
          }
        });

      let trackTimer: ReturnType<typeof setTimeout> | null = null;
      trackRef.current = (self) => {
        selfRef.current = self;
        trackTimer ??= setTimeout(() => {
          trackTimer = null;
          if (selfRef.current) void channel.track(selfRef.current);
        }, 200);
      };

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

      return channel;
    };

    const channelPromise = setup();
    return () => {
      disposed = true;
      void channelPromise.then((ch) => {
        if (ch) void supabase.removeChannel(ch);
      });
    };
  }, [sessionId]);

  const updateSelf = useCallback((patch: Partial<PresenceState>) => {
    if (!selfRef.current || !trackRef.current) return;
    trackRef.current({ ...selfRef.current, ...patch });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.lastSeq, provisional]);

  const status = state.ended ? "ended" : state.status;
  const interactive =
    kind === "shared" && !state.ended && initialStatus === "live";
  const isHost = myId === hostUserId;
  const hostName = names[hostUserId] ?? "?";
  const statusColor =
    status === "working"
      ? "text-accent"
      : status === "awaiting_permission"
        ? "text-warn"
        : status === "ended"
          ? "text-muted"
          : "text-good";

  const draftingPeers = peers.filter((p) => p.draftShared && p.draftText);

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
          <span className="flex items-center gap-1">
            {peers.map((p) => (
              <span
                key={p.userId}
                title={p.name}
                className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-bg"
              >
                {p.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {peers.some((p) => p.typing) && (
              <span className="text-accent">typing…</span>
            )}
          </span>
          <span title={`hosted on ${hostName}'s machine and plan`}>
            host {hostName}
          </span>
          <span className={statusColor}>
            {initialStatus === "ended" || state.ended ? "ended" : status}
          </span>
          <span className={connected ? "text-good" : "text-warn"}>
            {connected ? "●" : "○"}
          </span>
        </span>
      </header>

      {interactive && (
        <div className="flex items-center gap-3 border-b border-border py-1.5 text-[11px] text-muted">
          <label className="flex items-center gap-1">
            model
            <select
              value={state.model ?? ""}
              onChange={(e) =>
                e.target.value &&
                void sendControl({ kind: "set_model", model: e.target.value })
              }
              className="rounded border border-border bg-panel px-1 py-0.5 outline-none"
            >
              <option value="">{state.model ?? "default"}</option>
              <option value="opus">opus</option>
              <option value="sonnet">sonnet</option>
              <option value="haiku">haiku</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            permissions
            <select
              value={state.permissionMode ?? "default"}
              onChange={(e) =>
                void sendControl({
                  kind: "set_permission_mode",
                  permissionMode: e.target.value as
                    | "default"
                    | "plan"
                    | "acceptEdits",
                })
              }
              className="rounded border border-border bg-panel px-1 py-0.5 outline-none"
            >
              <option value="default">default</option>
              <option value="plan">plan</option>
              <option value="acceptEdits">accept edits</option>
            </select>
          </label>
          {isHost ? (
            <button
              type="button"
              onClick={() =>
                void sendControl({
                  kind: "set_session_mode",
                  sessionMode:
                    state.sessionMode === "equal" ? "moderated" : "equal",
                })
              }
              className="rounded border border-border px-2 py-0.5 hover:border-accent"
              title="toggle guest moderation"
            >
              mode: {state.sessionMode} ⇄
            </button>
          ) : (
            <span>mode: {state.sessionMode}</span>
          )}
        </div>
      )}

      <main className="flex-1 overflow-y-auto py-4">
        {!caughtUp && <p className="text-sm text-muted">loading transcript…</p>}
        <Transcript
          state={state}
          provisional={provisional}
          onPermissionDecide={
            interactive
              ? (requestId, decision) =>
                  void sendControl({
                    kind: "permission_decision",
                    requestId,
                    decision,
                  })
              : undefined
          }
        />
        <div ref={bottomRef} />
      </main>

      {draftingPeers.length > 0 && (
        <div className="border-t border-border py-1.5">
          {draftingPeers.map((p) => (
            <p
              key={p.userId}
              className="truncate text-[11px] italic text-muted"
            >
              <span className="not-italic text-accent">{p.name}</span> is
              drafting: {p.draftText}
            </p>
          ))}
        </div>
      )}

      {interactive && isHost && (
        <ApprovalTray
          sessionId={sessionId}
          names={new Map(Object.entries(names))}
        />
      )}

      {interactive ? (
        <Composer
          sessionId={sessionId}
          status={status}
          disabled={false}
          onDraft={(text, shared) =>
            updateSelf({
              typing: text.length > 0,
              draftShared: shared,
              draftText: shared ? text.slice(0, 2000) || null : null,
            })
          }
        />
      ) : (
        <footer className="border-t border-border py-3 text-xs text-muted">
          {state.ended || initialStatus === "ended"
            ? "session ended — replay"
            : "read-only mirror of a terminal session"}
        </footer>
      )}
    </div>
  );
}
