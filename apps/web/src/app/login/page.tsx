"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const callback = () =>
    `${window.location.origin}/auth/callback?next=${encodeURIComponent("/")}`;

  const sendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callback() },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  };

  const githubLogin = async () => {
    setError(null);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: callback() },
    });
    if (error) setError(error.message);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-bold text-accent">ccshare</h1>
        <p className="mt-1 text-sm text-muted">
          Multiplayer Claude Code — sign in to your workspace.
        </p>
      </div>

      {sent ? (
        <p className="rounded border border-border bg-panel p-4 text-sm">
          Check <span className="text-accent">{email}</span> for a sign-in link.
        </p>
      ) : (
        <form onSubmit={sendMagicLink} className="flex flex-col gap-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="rounded border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
          >
            {busy ? "sending…" : "email me a sign-in link"}
          </button>
        </form>
      )}

      <div className="flex items-center gap-3 text-xs text-muted">
        <div className="h-px flex-1 bg-border" />
        or
        <div className="h-px flex-1 bg-border" />
      </div>

      <button
        type="button"
        onClick={githubLogin}
        className="rounded border border-border bg-panel px-3 py-2 text-sm hover:border-accent"
      >
        continue with GitHub
      </button>

      {error && <p className="text-sm text-bad">{error}</p>}
    </main>
  );
}
