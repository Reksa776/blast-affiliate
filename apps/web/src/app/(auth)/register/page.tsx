"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

export default function BootstrapRegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const csrf = await fetch("/api/auth/csrf", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { csrfToken?: string };
      const response = await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken ?? "" }, body: JSON.stringify({ name, email, password }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(response.status === 403 ? "Pendaftaran bootstrap sudah ditutup. Masuk dengan akun yang sudah dibuat." : body.error ?? "Akun tidak dapat dibuat.");
      setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12"><header><p className="text-xs font-medium uppercase tracking-[0.2em] text-violet-300">AffiliateOS · Setup</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Buat akun pertama</h1><p className="mt-2 text-sm text-slate-400">Akun ini untuk pemilik platform. Registrasi akan otomatis ditutup setelah akun pertama dibuat.</p></header>
    {done ? <section className="rounded-xl border border-emerald-900/70 bg-emerald-950/30 p-5"><h2 className="font-semibold text-emerald-200">Akun berhasil dibuat</h2><p className="mt-2 text-sm text-slate-300">Silakan masuk, lalu buat workspace untuk mulai mengelola kreator.</p><Link className="mt-4 inline-block rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950" href="/sign-in">Masuk</Link></section> : <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5"><label className="text-sm text-slate-300">Nama<input className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label><label className="text-sm text-slate-300">Email<input className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" required type="email" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label><label className="text-sm text-slate-300">Password<input className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" required type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /><span className="mt-1 block text-xs text-slate-500">Minimal 12 karakter.</span></label>{error ? <p className="text-sm text-red-300">{error}</p> : null}<button disabled={busy} className="rounded-md bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{busy ? "Membuat akun…" : "Buat akun pertama"}</button></form>}
    <p className="text-xs text-slate-500">Sudah punya akun? <Link className="text-slate-300 underline-offset-2 hover:underline" href="/sign-in">Sign in</Link></p>
  </main>;
}
