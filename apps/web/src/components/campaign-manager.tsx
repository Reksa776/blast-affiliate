"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

type CampaignStatus = "DRAFT" | "SCHEDULED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
type CampaignRow = { id: string; name: string; shopName: string | null; status: CampaignStatus; startsAt: string; endsAt: string | null; budget: string | number | null; currency: string; createdAt: string; _count: { creators: number } };
const STATUSES: CampaignStatus[] = ["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"];
const labels: Record<CampaignStatus, string> = { DRAFT: "Draft", SCHEDULED: "Terjadwal", ACTIVE: "Aktif", PAUSED: "Jeda", COMPLETED: "Selesai", CANCELLED: "Dibatalkan" };
const inputClass = "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-violet-400";

export function CampaignManager({ workspaceId, canWrite, canDelete }: { workspaceId: string; canWrite: boolean; canDelete: boolean }) {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [budget, setBudget] = useState("");
  const [editing, setEditing] = useState<CampaignRow | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { campaigns?: CampaignRow[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Gagal memuat campaign.");
      setCampaigns(body.campaigns ?? []); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  async function csrfToken() {
    return fetch("/api/auth/csrf", { cache: "no-store" }).then((response) => response.json()).then((body) => (body as { csrfToken?: string }).csrfToken ?? "").catch(() => "");
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() }, body: JSON.stringify({ name, shopName, startsAt, endsAt: endsAt || null, budget: budget || null }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Gagal membuat campaign.");
      setOpen(false); setName(""); setShopName(""); setStartsAt(""); setEndsAt(""); setBudget(""); setMessage("Campaign berhasil dibuat sebagai draft."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }

  function startEdit(item: CampaignRow) {
    setEditing(item); setName(item.name); setShopName(item.shopName ?? "");
    setStartsAt(item.startsAt.slice(0, 10)); setEndsAt(item.endsAt?.slice(0, 10) ?? "");
    setBudget(item.budget === null ? "" : String(item.budget)); setOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    if (!editing) return create(event);
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns/${editing.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() }, body: JSON.stringify({ name, shopName, startsAt, endsAt: endsAt || null, budget: budget || null }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Gagal memperbarui campaign.");
      setOpen(false); setEditing(null); setMessage("Campaign berhasil diperbarui."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }

  async function archive(item: CampaignRow) {
    if (!window.confirm(`Arsipkan campaign “${item.name}”?`)) return;
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns/${item.id}`, { method: "DELETE", headers: { "x-csrf-token": await csrfToken() } });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Gagal mengarsipkan campaign.");
      setMessage("Campaign diarsipkan."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
  }

  async function changeStatus(id: string, status: CampaignStatus) {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() }, body: JSON.stringify({ status }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Gagal mengubah status.");
      setCampaigns((rows) => rows.map((row) => row.id === id ? { ...row, status } : row)); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
  }

  const activeCount = campaigns.filter((item) => item.status === "ACTIVE").length;
  return <div className="flex flex-col gap-5">
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[["Total campaign", campaigns.length], ["Aktif", activeCount], ["Draft", campaigns.filter((item) => item.status === "DRAFT").length], ["Kreator terlibat", campaigns.reduce((sum, item) => sum + item._count.creators, 0)]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p></div>)}</section>
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div><h2 className="font-medium">Rencana campaign</h2><p className="mt-1 text-xs text-slate-400">Campaign tersimpan lokal. Belum dipublikasikan ke TikTok.</p></div>{canWrite ? <button className="rounded-md bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950" onClick={() => setOpen(true)}>+ Buat campaign</button> : null}</section>
    {message ? <p className="text-sm text-emerald-300">{message}</p> : null}{error ? <p className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">{error}</p> : null}
    <section className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40"><table className="w-full min-w-[700px] border-collapse text-left text-sm"><thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">Campaign</th><th className="px-4 py-3">Jadwal</th><th className="px-4 py-3">Anggaran</th><th className="px-4 py-3">Kreator</th><th className="px-4 py-3">Status</th></tr></thead><tbody>
      {campaigns.map((item) => <tr key={item.id} className="border-t border-slate-800"><td className="px-4 py-4"><Link href={`/workspaces/${workspaceId}/campaigns/${item.id}`} className="font-medium text-slate-100 hover:text-violet-300">{item.name}</Link><p className="mt-1 text-xs text-slate-400">{item.shopName || "Belum ditautkan ke toko"}</p></td><td className="px-4 py-4 text-slate-300">{new Date(item.startsAt).toLocaleDateString("id-ID")}{item.endsAt ? ` – ${new Date(item.endsAt).toLocaleDateString("id-ID")}` : ""}</td><td className="px-4 py-4 text-slate-300">{item.budget === null ? "—" : new Intl.NumberFormat("id-ID", { style: "currency", currency: item.currency, maximumFractionDigits: 0 }).format(Number(item.budget))}</td><td className="px-4 py-4 text-slate-300">{item._count.creators}</td><td className="px-4 py-4">{canWrite ? <select aria-label={`Status ${item.name}`} className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 text-xs" value={item.status} onChange={(event) => void changeStatus(item.id, event.target.value as CampaignStatus)}>{STATUSES.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select> : <span>{labels[item.status]}</span>}{canWrite ? <button className="ml-2 text-xs text-violet-300" onClick={() => startEdit(item)}>Edit</button> : null}{canDelete ? <button className="ml-2 text-xs text-red-300" onClick={() => void archive(item)}>Arsipkan</button> : null}</td></tr>)}
      {campaigns.length === 0 ? <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-400">Belum ada campaign. Buat campaign pertama untuk mulai mengatur brief dan kreator.</td></tr> : null}
    </tbody></table></section>
    {open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"><form onSubmit={save} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5"><div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{editing ? "Edit campaign" : "Buat campaign"}</h2><p className="mt-1 text-xs text-slate-400">Campaign dimulai sebagai draft dan bisa diperbarui.</p></div><button type="button" className="text-slate-400" onClick={() => { setOpen(false); setEditing(null); }}>Tutup</button></div>
      <label className="mt-4 block text-sm text-slate-300">Nama campaign<input className={inputClass} required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} placeholder="Campaign Ramadan 2027" /></label>
      <label className="mt-3 block text-sm text-slate-300">Nama toko (opsional)<input className={inputClass} maxLength={160} value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="Nama brand atau toko" /></label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm text-slate-300">Mulai<input className={inputClass} required type="date" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><label className="text-sm text-slate-300">Selesai (opsional)<input className={inputClass} type="date" min={startsAt || undefined} value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label></div>
      <label className="mt-3 block text-sm text-slate-300">Anggaran (IDR, opsional)<input className={inputClass} type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="0" /></label>
      <button disabled={busy} className="mt-5 w-full rounded-md bg-violet-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">{busy ? "Menyimpan…" : editing ? "Simpan perubahan" : "Simpan draft"}</button></form></div> : null}
  </div>;
}
