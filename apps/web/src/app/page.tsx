import Link from "next/link";
import { redirect } from "next/navigation";
import { AccessRequests } from "@/components/access-requests";
import { SignOutButton } from "@/components/sign-out";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SessionRow = {
  id: string;
  kind: "shared" | "mirror";
  status: "live" | "ended";
  mode: string;
  title: string | null;
  cwd: string;
  host_user_id: string;
  last_heartbeat_at: string | null;
  created_at: string;
};

function isOnline(row: SessionRow): boolean {
  if (row.status !== "live" || !row.last_heartbeat_at) return false;
  return Date.now() - new Date(row.last_heartbeat_at).getTime() < 45_000;
}

export default async function Home() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: myMemberships } = await supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", user.id);
  if (!myMemberships || myMemberships.length === 0) redirect("/pending");
  const isOwner = myMemberships.some((m) => m.role === "owner");

  const [{ data: sessions }, { data: profiles }] = await Promise.all([
    supabase
      .from("sessions")
      .select(
        "id, kind, status, mode, title, cwd, host_user_id, last_heartbeat_at, created_at",
      )
      .order("status", { ascending: true }) // 'ended' < 'live'? no — sort below
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("profiles").select("user_id, display_name"),
  ]);

  const nameOf = new Map(
    (profiles ?? []).map((p) => [
      p.user_id as string,
      p.display_name as string,
    ]),
  );
  const rows = (sessions ?? []) as SessionRow[];
  const live = rows.filter((r) => r.status === "live");
  const ended = rows.filter((r) => r.status === "ended");

  const card = (row: SessionRow) => (
    <Link
      key={row.id}
      href={`/s/${row.id}`}
      className="block rounded border border-border bg-panel px-4 py-3 hover:border-accent"
    >
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            isOnline(row)
              ? "bg-good"
              : row.status === "live"
                ? "bg-warn"
                : "bg-border"
          }`}
        />
        <span className="truncate font-semibold">
          {row.title ?? row.cwd.split("/").pop() ?? "session"}
        </span>
        {row.kind === "mirror" && (
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">
            mirror · read-only
          </span>
        )}
      </div>
      <div className="mt-1 flex gap-3 text-xs text-muted">
        <span>
          hosted by {nameOf.get(row.host_user_id) ?? "?"} ·{" "}
          {nameOf.get(row.host_user_id) ?? "?"}&apos;s plan
        </span>
        <span>{row.mode}</span>
        <span className="truncate">{row.cwd}</span>
      </div>
    </Link>
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-accent">ccshare</h1>
          <p className="text-xs text-muted">{user.email}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/account" className="text-xs text-muted hover:text-ink">
            account
          </Link>
          <SignOutButton />
        </div>
      </header>

      {isOwner && <AccessRequests />}

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-widest text-muted">
          live · {live.length}
        </h2>
        <div className="flex flex-col gap-2">
          {live.length === 0 && (
            <p className="rounded border border-dashed border-border p-4 text-sm text-muted">
              No live sessions. Run <span className="text-ink">ccshare</span> in
              a repo, or <span className="text-ink">ccshare watch</span> to
              mirror TUI sessions.
            </p>
          )}
          {live.map(card)}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-xs uppercase tracking-widest text-muted">
          archive · {ended.length}
        </h2>
        <div className="flex flex-col gap-2">{ended.map(card)}</div>
      </section>
    </main>
  );
}
