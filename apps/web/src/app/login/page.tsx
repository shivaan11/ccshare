"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Password sign-in keeps the whole flow in this tab. Email is only involved
// once, to confirm a new address — magic links are kept as the escape hatch
// for a forgotten password. Signing in grants nothing on its own: access still
// waits on owner approval (DESIGN §7).

type Mode = "signin" | "signup";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const callback = () =>
    `${window.location.origin}/auth/callback?next=${encodeURIComponent("/")}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = supabaseBrowser();

    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: callback(),
          data: name.trim() ? { name: name.trim() } : undefined,
        },
      });
      setBusy(false);
      if (error) setError(error.message);
      else
        setNotice(
          `Confirm ${email} using the link we just sent, then sign in here.`,
        );
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setBusy(false);
      setError(
        error.message === "Email not confirmed"
          ? "Confirm your email address first — check your inbox for the link."
          : error.message,
      );
      return;
    }
    // Full navigation so the server sees the fresh auth cookie.
    window.location.assign("/");
  };

  const magicLink = async () => {
    if (!email) {
      setError("Enter your email address first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callback(), shouldCreateUser: false },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setNotice(`Sign-in link sent to ${email} — it opens in a new tab.`);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-bold text-accent">ccshare</h1>
        <p className="mt-1 text-sm text-muted">
          Multiplayer Claude Code — sign in to your workspace.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === "signup" && (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="display name"
            autoComplete="name"
            className="rounded border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />
        )}
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="rounded border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          className="rounded border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
        >
          {busy ? "working…" : mode === "signup" ? "create account" : "sign in"}
        </button>
      </form>

      <div className="flex flex-col gap-2 text-xs text-muted">
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signup" ? "signin" : "signup");
            setError(null);
            setNotice(null);
          }}
          className="text-left hover:text-ink"
        >
          {mode === "signup"
            ? "← already have an account? sign in"
            : "no account yet? create one →"}
        </button>
        {mode === "signin" && (
          <button
            type="button"
            onClick={() => void magicLink()}
            disabled={busy}
            className="text-left hover:text-ink disabled:opacity-50"
          >
            forgot your password? email me a sign-in link
          </button>
        )}
      </div>

      {notice && (
        <p className="rounded border border-border bg-panel p-3 text-sm">
          {notice}
        </p>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}

      <p className="text-xs text-muted">
        New accounts need approval from the workspace owner before they can see
        any sessions.
      </p>
    </main>
  );
}
