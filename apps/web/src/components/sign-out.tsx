"use client";

import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="rounded border border-border px-2 py-1 text-xs text-muted hover:border-accent hover:text-ink"
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      sign out
    </button>
  );
}
