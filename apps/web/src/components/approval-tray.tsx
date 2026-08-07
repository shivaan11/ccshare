"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useSendControl } from "./composer";

// Host-only tray (M3): guest actions parked as needs_approval by the daemon's
// policy engine surface here; approve/reject are themselves control requests,
// so the daemon stays the single state-machine writer.

type PendingRow = {
  id: string;
  requested_by: string;
  action: {
    kind: string;
    text?: string;
    model?: string;
    permissionMode?: string;
  };
  status: string;
  created_at: string;
};

function describe(action: PendingRow["action"]): string {
  switch (action.kind) {
    case "send_message":
      return `message: “${(action.text ?? "").slice(0, 120)}”`;
    case "set_model":
      return `change model → ${action.model}`;
    case "set_permission_mode":
      return `change permission mode → ${action.permissionMode}`;
    default:
      return action.kind;
  }
}

export function ApprovalTray({
  sessionId,
  names,
}: {
  sessionId: string;
  names: Map<string, string>;
}) {
  const [pending, setPending] = useState<PendingRow[]>([]);
  const send = useSendControl(sessionId);

  useEffect(() => {
    const supabase = supabaseBrowser();

    const refresh = async () => {
      const { data } = await supabase
        .from("control_requests")
        .select("id, requested_by, action, status, created_at")
        .eq("session_id", sessionId)
        .eq("status", "needs_approval")
        .order("created_at", { ascending: true });
      setPending((data ?? []) as PendingRow[]);
    };
    void refresh();

    const channel = supabase
      .channel(`approvals:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "control_requests",
          filter: `session_id=eq.${sessionId}`,
        },
        () => void refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionId]);

  if (pending.length === 0) return null;

  return (
    <div className="border-t border-warn/40 bg-panel px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-warn">
        needs your approval · {pending.length}
      </div>
      <div className="flex flex-col gap-1">
        {pending.map((row) => (
          <div key={row.id} className="flex items-center gap-2 text-xs">
            <span className="text-accent">
              {names.get(row.requested_by) ?? "guest"}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {describe(row.action)}
            </span>
            <button
              type="button"
              onClick={() => void send({ kind: "approve", targetId: row.id })}
              className="rounded bg-good px-2 py-0.5 font-semibold text-bg"
            >
              approve
            </button>
            <button
              type="button"
              onClick={() => void send({ kind: "reject", targetId: row.id })}
              className="rounded bg-bad px-2 py-0.5 font-semibold text-bg"
            >
              reject
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
