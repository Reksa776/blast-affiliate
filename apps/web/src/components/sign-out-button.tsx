"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Header sign-out button. Mirrors the logout route: CSRF first, then POST. */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);

    try {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const csrfBody = (await csrfResponse.json().catch(() => ({}))) as { csrfToken?: string };

      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": csrfBody.csrfToken ?? "" },
      });

      router.push("/sign-in");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50"
      type="button"
      onClick={signOut}
      disabled={busy}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
