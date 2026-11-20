"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

type CreatorStatus = "NEW" | "CONTACTED" | "INVITED" | "ACCEPTED" | "COLLABORATING" | "COMPLETED" | "REJECTED" | "UNRESPONSIVE" | "BLACKLISTED";
type CreatorRow = { id: string; username: string; displayName: string; avatarUrl: string | null; followerCount: number | null; status: CreatorStatus; createdAt: string; blacklist: { reason: string; revokedAt: string | null } | null; assignments: { member: { user: { displayName: string } } }[]; tagAssignments: { tag: { id: string; label: string; color: string | null } }[] };
type ListResponse = { rows: CreatorRow[]; total: number; page: number; pageSize: number; statusCounts: Record<string, number> };
type ImportResponse = { created: number; updated: number; failed: number; errors: { row: number; error: string }[] };
const STATUSES: CreatorStatus[] = ["NEW", "CONTACTED", "INVITED", "ACCEPTED", "COLLABORATING", "COMPLETED", "REJECTED", "UNRESPONSIVE", "BLACKLISTED"];
const labels: Record<CreatorStatus, string> = { NEW: "Baru", CONTACTED: "Dihubungi", INVITED: "Diundang", ACCEPTED: "Diterima", COLLABORATING: "Kolaborasi", COMPLETED: "Selesai", REJECTED: "Ditolak", UNRESPONSIVE: "Tidak merespons", BLACKLISTED: "Blacklist" };
const inputClass = "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-violet-400";

export function CreatorManager({ workspaceId, canWrite, canExport }: { workspaceId: string; canWrite: boolean; canExport: boolean }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [followers, setFollowers] = useState("");
  const [bio, setBio] = useState("");
  const [importReport, setImportReport] = useState<ImportResponse | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      params.set("page", String(page));
      const response = await fetch(`/api/workspaces/${workspaceId}/creators?${params}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Gagal memuat kreator.");
      setData(body as ListResponse);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
  }, [workspaceId, q, status, page]);

  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const csrf = await fetch("/api/auth/csrf", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { csrfToken?: string };
      const response = await fetch(`/api/workspaces/${workspaceId}/creators`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken ?? "" }, body: JSON.stringify({ username, displayName, followerCount: followers || null, bio }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Gagal menyimpan kreator.");
      setUsername(""); setDisplayName(""); setFollowers(""); setBio(""); setOpen(false); setMessage("Kreator berhasil ditambahkan."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }

  async function updateStatus(creatorId: string, nextStatus: CreatorStatus) {
    setError("");
    try {
      const csrf = await fetch("/api/auth/csrf", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { csrfToken?: string };
      const response = await fetch(`/api/workspaces/${workspaceId}/creators/${creatorId}`, { method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken ?? "" }, body: JSON.stringify({ status: nextStatus }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Gagal mengubah tahap kreator.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(""); setImportReport(null);
    try {
      const csrf = await fetch("/api/auth/csrf", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { csrfToken?: string };
      const response = await fetch(`/api/workspaces/${workspaceId}/creators/import`, { method: "POST", headers: { "content-type": "text/csv; charset=utf-8", "x-csrf-token": csrf.csrfToken ?? "" }, body: await file.text() });
      const result = await response.json().catch(() => ({})) as ImportResponse & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Impor gagal.");
      setImportReport(result); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }

  const count = (key: string) => data?.statusCounts[key] ?? 0;
  return <div className="flex flex-col gap-5">
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-5">
      {[["Total kreator", String(data?.total ?? "—")], ["Baru", String(count("NEW"))], ["Dihubungi", String(count("CONTACTED"))], ["Kolaborasi", String(count("COLLABORATING"))], ["Blacklist", String(count("BLACKLISTED"))]].map(([label, value]) => <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4" key={label}><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p></div>)}
    </section>
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 sm:flex-row sm:items-end">
      <label className="flex-1 text-xs text-slate-400">Cari username atau nama<input className={inputClass} value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="mis. @creator" /></label>
      <label className="text-xs text-slate-400">Tahap<select className={inputClass} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">Semua tahap</option>{STATUSES.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
      <div className="flex flex-wrap gap-2">{canExport ? <a className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-slate-500" href={`/api/workspaces/${workspaceId}/creators/export`}>Export CSV</a> : null}{canWrite ? <><label className="cursor-pointer rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-slate-500">{busy ? "Mengimpor…" : "Import CSV"}<input className="hidden" type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { void importFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label><button className="rounded-md bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-violet-300" onClick={() => setOpen(true)}>+ Tambah kreator</button></> : null}</div>
    </section>
    {message ? <p className="text-sm text-emerald-300">{message}</p> : null}{error ? <p className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">{error}</p> : null}
    {importReport ? <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-sm"><p>Impor selesai: {importReport.created} baru, {importReport.updated} diperbarui, {importReport.failed} gagal.</p>{importReport.errors.length ? <ul className="mt-2 max-h-40 list-inside list-disc overflow-y-auto text-xs text-amber-200">{importReport.errors.slice(0, 30).map((item) => <li key={`${item.row}-${item.error}`}>Baris {item.row}: {item.error}</li>)}</ul> : null}<p className="mt-2 text-xs text-slate-500">CSV perlu kolom username dan displayName. followerCount dan bio opsional; maksimal 500 baris.</p></section> : null}
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse text-left text-sm"><thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">Kreator</th><th className="px-4 py-3">Followers</th><th className="px-4 py-3">Tahap</th><th className="px-4 py-3">PIC</th><th className="px-4 py-3">Tag</th></tr></thead><tbody>
        {data?.rows.map((row) => <tr key={row.id} className="border-t border-slate-800"><td className="px-4 py-3"><Link href={`/workspaces/${workspaceId}/creators/${row.id}`} className="font-medium text-slate-100 hover:text-violet-300">{row.displayName}</Link><p className="text-xs text-slate-400">@{row.username}</p></td><td className="px-4 py-3 text-slate-300">{row.followerCount?.toLocaleString("id-ID") ?? "—"}</td><td className="px-4 py-3">{canWrite && row.status !== "BLACKLISTED" ? <select aria-label={`Tahap ${row.displayName}`} className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 text-xs" value={row.status} onChange={(event) => void updateStatus(row.id, event.target.value as CreatorStatus)}>{STATUSES.filter((value) => value !== "BLACKLISTED").map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select> : <span className={`rounded-full border px-2 py-1 text-xs ${row.status === "BLACKLISTED" ? "border-red-900 text-red-200" : "border-slate-700"}`}>{labels[row.status]}</span>}{row.blacklist && !row.blacklist.revokedAt ? <p className="mt-1 text-xs text-red-300">Diblokir · {row.blacklist.reason}</p> : null}</td><td className="px-4 py-3 text-slate-300">{row.assignments[0]?.member.user.displayName ?? "Belum ditugaskan"}</td><td className="px-4 py-3"><div className="flex flex-wrap gap-1">{row.tagAssignments.map(({ tag }) => <span key={tag.id} className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: tag.color ?? "#334155" }}>{tag.label}</span>)}{row.tagAssignments.length === 0 ? <span className="text-slate-500">—</span> : null}</div></td></tr>)}
        {data && data.rows.length === 0 ? <tr><td className="px-4 py-12 text-center text-slate-400" colSpan={5}>Belum ada kreator yang cocok. Tambahkan kreator pertama untuk mulai membangun CRM.</td></tr> : null}
      </tbody></table></div>
    </section>
    {data && data.total > data.pageSize ? <div className="flex items-center justify-between text-xs text-slate-400"><span>Menampilkan {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} dari {data.total}</span><div className="flex gap-2"><button className="rounded border border-slate-700 px-3 py-1.5 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Sebelumnya</button><button className="rounded border border-slate-700 px-3 py-1.5 disabled:opacity-40" disabled={page * data.pageSize >= data.total} onClick={() => setPage((value) => value + 1)}>Berikutnya</button></div></div> : null}
    {open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"><form onSubmit={create} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5"><div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">Tambah kreator</h2><p className="mt-1 text-xs text-slate-400">Data disimpan khusus di workspace ini.</p></div><button type="button" onClick={() => setOpen(false)} className="text-slate-400">Tutup</button></div>
      <label className="mt-4 block text-sm text-slate-300">Username TikTok<input className={inputClass} required maxLength={96} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="@username" /></label>
      <label className="mt-3 block text-sm text-slate-300">Nama tampilan<input className={inputClass} required maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Nama kreator" /></label>
      <label className="mt-3 block text-sm text-slate-300">Jumlah followers<input className={inputClass} type="number" min={0} max={4294967295} value={followers} onChange={(event) => setFollowers(event.target.value)} placeholder="Opsional" /></label>
      <label className="mt-3 block text-sm text-slate-300">Catatan profil<textarea className={inputClass} rows={3} maxLength={4000} value={bio} onChange={(event) => setBio(event.target.value)} placeholder="Niche, lokasi, atau konteks awal" /></label>
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}<button disabled={busy} className="mt-5 w-full rounded-md bg-violet-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">{busy ? "Menyimpan…" : "Simpan kreator"}</button>
    </form></div> : null}
  </div>;
}
