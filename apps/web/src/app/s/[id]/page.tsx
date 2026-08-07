import { notFound } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const [{ data: session }, { data: profiles }] = await Promise.all([
    supabase
      .from("sessions")
      .select(
        "id, kind, status, mode, title, cwd, host_user_id, model, permission_mode, last_heartbeat_at, created_at",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("profiles").select("user_id, display_name"),
  ]);
  if (!session) notFound();

  const names: Record<string, string> = {};
  for (const p of profiles ?? []) {
    names[p.user_id as string] = p.display_name as string;
  }

  return (
    <SessionView
      sessionId={id}
      initialStatus={session.status}
      kind={session.kind}
      hostUserId={session.host_user_id}
      names={names}
      title={session.title ?? session.cwd}
    />
  );
}
