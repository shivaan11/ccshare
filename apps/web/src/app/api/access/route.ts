import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

// Owner-gated access decisions. The service role key lives only here (server).
// approve → insert workspace membership (+ standing invite row for audit)
// deny    → delete the auth user entirely (profile cascades)

function adminClient() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("service role key not configured");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, key, {
    auth: { persistSession: false },
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    userId?: string;
    decision?: "approve" | "deny";
  };
  if (!body.userId || !body.decision) {
    return NextResponse.json(
      { error: "userId and decision required" },
      { status: 400 },
    );
  }

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: ownership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("role", "owner")
    .limit(1);
  const workspaceId = ownership?.[0]?.workspace_id;
  if (!workspaceId) {
    return NextResponse.json({ error: "owners only" }, { status: 403 });
  }
  if (body.userId === user.id) {
    return NextResponse.json(
      { error: "cannot decide on yourself" },
      { status: 400 },
    );
  }

  const admin = adminClient();
  const { data: target } = await admin
    .from("profiles")
    .select("user_id, email")
    .eq("user_id", body.userId)
    .maybeSingle();
  if (!target)
    return NextResponse.json({ error: "no such user" }, { status: 404 });

  if (body.decision === "approve") {
    const { error } = await admin.from("workspace_members").insert({
      workspace_id: workspaceId,
      user_id: target.user_id,
      role: "member",
    });
    if (error && !error.message.includes("duplicate")) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (target.email) {
      await admin.from("workspace_invites").upsert({
        workspace_id: workspaceId,
        email: target.email,
        role: "member",
      });
    }
    return NextResponse.json({ ok: true });
  }

  const { error } = await admin.auth.admin.deleteUser(target.user_id);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
