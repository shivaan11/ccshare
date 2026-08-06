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

  const { data: session } = await supabase
    .from("sessions")
    .select(
      "id, kind, status, mode, title, cwd, host_user_id, model, permission_mode, last_heartbeat_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!session) notFound();

  const { data: host } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("user_id", session.host_user_id)
    .maybeSingle();

  return (
    <SessionView
      sessionId={id}
      initialStatus={session.status}
      kind={session.kind}
      hostName={host?.display_name ?? "?"}
      title={session.title ?? session.cwd}
    />
  );
}
