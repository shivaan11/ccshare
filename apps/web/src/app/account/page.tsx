import Link from "next/link";
import { redirect } from "next/navigation";
import { SetPassword } from "@/components/set-password";
import { SignOutButton } from "@/components/sign-out";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <Link href="/" className="text-xl font-bold text-accent">
            ccshare
          </Link>
          <p className="text-xs text-muted">{user.email}</p>
        </div>
        <SignOutButton />
      </header>

      <h1 className="mb-2 text-xs uppercase tracking-widest text-muted">
        password
      </h1>
      <p className="mb-4 max-w-sm text-sm text-muted">
        Signing in with a password keeps you in this tab, and the{" "}
        <span className="text-ink">ccshare</span> CLI uses the same credentials.
      </p>
      <SetPassword />
    </main>
  );
}
