"use client";

import { useState, type FormEvent } from "react";

const inputClass = "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-violet-400";

function slugFromName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function WorkspaceCreateForm() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const csrfBody = await csrfResponse.json().catch(() => ({})) as { csrfToken?: string };
      if (!csrfResponse.ok || !csrfBody.csrfToken) throw new Error("Token keamanan tidak tersedia. Muat ulang halaman lalu coba lagi.");

      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfBody.csrfToken },
        body: JSON.stringify({ name, slug }),
      });
      const body = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok) {
        if (response.status === 409) throw new Error("Slug sudah dipakai. Coba nama workspace atau slug lain.");
        if (response.status === 401) throw new Error("Sesi login sudah berakhir. Masuk lagi lalu coba buat workspace.");
        throw new Error(body.error ?? "Workspace belum berhasil dibuat.");
      }
      if (!body.id) throw new Error("Workspace dibuat, tetapi halaman berikutnya tidak dapat dibuka. Muat ulang halaman ini.");
      window.location.assign(`/workspaces/${body.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Koneksi bermasalah. Coba lagi.");
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className="mt-5 flex max-w-xl flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
    <label className="text-sm text-slate-300">Nama workspace
      <input className={inputClass} required minLength={1} maxLength={150} value={name} onChange={(event) => { const value = event.target.value; setName(value); if (!slugEdited) setSlug(slugFromName(value)); }} placeholder="Contoh: Brand Nusantara" />
    </label>
    <label className="text-sm text-slate-300">Slug
      <input className={inputClass} required minLength={1} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => { setSlugEdited(true); setSlug(event.target.value.toLowerCase()); }} placeholder="brand-nusantara" />
      <span className="mt-1 block text-xs text-slate-500">Dipakai di alamat workspace; huruf kecil, angka, dan tanda hubung.</span>
    </label>
    {error ? <p role="alert" className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">{error}</p> : null}
    <button disabled={busy} className="w-fit rounded-md bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">
      {busy ? "Membuat workspace…" : "Buat workspace"}
    </button>
  </form>;
}
