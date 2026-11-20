"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/**
 * Sign-in form (P1 MEDIUM #6, item 3a).
 *
 * Mirrors the API contract exactly: a fresh CSRF token first (double-submit cookie),
 * then POST /api/auth/login. The API answers 401 for every credential failure and
 * 429 when the per-IP login window is exhausted, so the UI maps those two statuses
 * to the two messages the brief asks for and shows anything else verbatim.
 */
export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const csrfBody = (await csrfResponse.json().catch(() => ({}))) as { csrfToken?: string };

      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfBody.csrfToken ?? "",
        },
        body: JSON.stringify({ email, password }),
      });

      if (response.status === 401) {
        setError("Email atau password salah.");
        return;
      }
      if (response.status === 429) {
        setError("Terlalu banyak percobaan. Coba lagi beberapa menit lagi.");
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Tidak bisa masuk.");
        return;
      }

      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next?.startsWith("/accept-invitation") && !next.startsWith("//") ? next : "/workspaces");
      router.refresh();
    } catch {
      setError("Kesalahan jaringan. Coba lagi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">AffiliateOS</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-slate-400">
          Gunakan email dan password akun workspace Anda.
        </p>
      </header>

      <form
        className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5"
        onSubmit={handleSubmit}
      >
        <label className="text-sm text-slate-300">
          Email
          <input
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="owner@example.com"
          />
        </label>

        <label className="text-sm text-slate-300">
          Password
          <input
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <button
          className="mt-1 rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={busy}
        >
          {busy ? "Masuk…" : "Sign in"}
        </button>

        {error === null ? null : <p className="text-sm text-red-300">{error}</p>}
      </form>

      <p className="text-xs text-slate-500">
        Belum punya akun? Registrasi hanya terbuka untuk akun pertama. {" "}
        <Link className="text-slate-300 underline-offset-2 hover:underline" href="/register">
          Buat akun pertama
        </Link>
      </p>
    </main>
  );
}
