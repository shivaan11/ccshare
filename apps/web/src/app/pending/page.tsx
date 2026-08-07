import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/sign-out";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .limit(1);
  if (memberships && memberships.length > 0) redirect("/");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-bold text-accent">ccshare</h1>
      <div className="rounded border border-warn bg-panel p-5 text-sm">
        <p className="font-semibold text-warn">waiting for approval</p>
        <p className="mt-2 text-muted">
          Your account (<span className="text-ink">{user.email}</span>) is
          created, but a workspace owner has to let you in. Check back once
          they've approved you.
        </p>
      </div>
      <div>
        <SignOutButton />
      </div>
    </main>
  );
}
