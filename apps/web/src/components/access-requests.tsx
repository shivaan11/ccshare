"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Owner-only panel: signed-up users with no workspace membership are access
// requests. Approve/deny hit the owner-gated service-role route.

type Pending = { user_id: string; display_name: string; email: string | null };

export function AccessRequests() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = supabaseBrowser();
    const [{ data: profiles }, { data: members }] = await Promise.all([
      supabase.from("profiles").select("user_id, display_name, email"),
      supabase.from("workspace_members").select("user_id"),
    ]);
    const memberIds = new Set((members ?? []).map((m) => m.user_id as string));
    setPending(
      ((profiles ?? []) as Pending[]).filter((p) => !memberIds.has(p.user_id)),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = async (userId: string, decision: "approve" | "deny") => {
    setBusy(userId);
    setError(null);
    const res = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, decision }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(body?.error ?? `request failed (${res.status})`);
    }
    setBusy(null);
    void refresh();
  };

  if (pending.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-xs uppercase tracking-widest text-warn">
        access requests · {pending.length}
      </h2>
      <div className="flex flex-col gap-2">
        {pending.map((p) => (
          <div
            key={p.user_id}
            className="flex items-center gap-3 rounded border border-warn/50 bg-panel px-4 py-2 text-sm"
          >
            <span className="font-semibold">{p.display_name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">
              {p.email ?? p.user_id}
            </span>
            <button
              type="button"
              disabled={busy === p.user_id}
              onClick={() => void decide(p.user_id, "approve")}
              className="rounded bg-good px-2 py-1 text-xs font-semibold text-bg disabled:opacity-50"
            >
              approve
            </button>
            <button
              type="button"
              disabled={busy === p.user_id}
              onClick={() => void decide(p.user_id, "deny")}
              className="rounded bg-bad px-2 py-1 text-xs font-semibold text-bg disabled:opacity-50"
            >
              deny
            </button>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </section>
  );
}
