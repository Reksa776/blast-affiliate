"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

type Account = { id: string; email: string; name: string };
export function InvitationAcceptance({ token }: { token: string }) {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => response.ok ? await response.json() as Account : null).then((data) => { if (active) { setAccount(data); setChecked(true); } }).catch(() => { if (active) setChecked(true); });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const csrf = await fetch("/api/auth/csrf", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { csrfToken?: string };
      const response = await fetch(account ? "/api/invitations/accept" : "/api/invitations/register", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken ?? "" }, body: JSON.stringify(account ? { token } : { token, name, password }) });
      const data = await response.json().catch(() => ({})) as { workspaceId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Undangan tidak dapat diterima.");
      router.push(data.workspaceId ? `/workspaces/${data.workspaceId}` : "/workspaces");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }

  const signInHref = `/sign-in?next=${encodeURIComponent(`/accept-invitation?token=${token}`)}`;
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12"><header><p className="text-xs font-medium uppercase tracking-[0.2em] text-violet-300">AffiliateOS · Workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Terima undangan</h1><p className="mt-2 text-sm text-slate-400">Undangan ini berlaku terbatas dan hanya bisa digunakan sekali.</p></header>
    {!checked ? <p className="text-sm text-slate-400">Memeriksa sesi…</p> : !token ? <p className="rounded-md border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">Link undangan tidak memiliki token.</p> : <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      {account ? <><p className="text-sm text-slate-300">Masuk sebagai <strong>{account.email}</strong>. Terima undangan workspace ini?</p><button disabled={busy} className="rounded-md bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950">{busy ? "Memproses…" : "Terima undangan"}</button></> : <><p className="text-sm text-slate-300">Buat akun dengan email yang menerima undangan. Email ditentukan oleh link undangan.</p><label className="text-sm text-slate-300">Nama<input className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label><label className="text-sm text-slate-300">Password<input className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2" required type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /><span className="mt-1 block text-xs text-slate-500">Minimal 12 karakter.</span></label><button disabled={busy} className="rounded-md bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950">{busy ? "Membuat akun…" : "Buat akun dan terima"}</button><p className="text-xs text-slate-400">Sudah punya akun? <Link className="text-slate-200 underline" href={signInHref}>Masuk lalu lanjutkan undangan</Link></p></>}
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
    </form>}
    <p className="text-xs text-slate-500">Jika link ini tidak diharapkan, tutup halaman dan hubungi administrator workspace.</p>
  </main>;
}
