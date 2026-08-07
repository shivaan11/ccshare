"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Accounts created by magic link have no password, and the CLI needs one.
// This sets or replaces it for the signed-in user.

export function SetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setPassword("");
    setConfirm("");
    setDone(true);
  };

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
      <input
        type="password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="new password (8+ characters)"
        autoComplete="new-password"
        className="rounded border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <input
        type="password"
        required
        minLength={8}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="confirm password"
        autoComplete="new-password"
        className="rounded border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
      >
        {busy ? "saving…" : "save password"}
      </button>
      {done && (
        <p className="text-sm text-good">
          Saved. Use it on this site and for{" "}
          <span className="text-ink">ccshare login</span>.
        </p>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </form>
  );
}
