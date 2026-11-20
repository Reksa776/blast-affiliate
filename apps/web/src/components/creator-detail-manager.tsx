"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type Status = "NEW" | "CONTACTED" | "INVITED" | "ACCEPTED" | "COLLABORATING" | "COMPLETED" | "REJECTED" | "UNRESPONSIVE" | "BLACKLISTED";
type Creator = { id: string; username: string; displayName: string; avatarUrl: string | null; followerCount: number | null; status: Status; createdAt: string; updatedAt: string; profile: { bio: string | null; region: string | null; language: string | null; metrics: unknown; metricsCapturedAt: string | null } | null; notes: { id: string; body: string; createdAt: string; authorMemberId: string | null }[]; activities: { id: string; type: string; summary: string; occurredAt: string }[]; statusHistory: { id: string; fromStatus: Status | null; toStatus: Status; reason: string | null; changedAt: string }[]; blacklist: { reason: string; scope: string | null; createdAt: string; revokedAt: string | null } | null; assignments: { id: string; memberId: string; member: { user: { displayName: string } } }[]; tagAssignments: { tag: { id: string; label: string; color: string | null } }[] };
type MemberOption = { id: string; displayName: string; email: string; status: string };
const STATUSES: Status[] = ["NEW", "CONTACTED", "INVITED", "ACCEPTED", "COLLABORATING", "COMPLETED", "REJECTED", "UNRESPONSIVE"];
const labels: Record<Status, string> = { NEW: "Baru", CONTACTED: "Dihubungi", INVITED: "Diundang", ACCEPTED: "Diterima", COLLABORATING: "Kolaborasi", COMPLETED: "Selesai", REJECTED: "Ditolak", UNRESPONSIVE: "Tidak merespons", BLACKLISTED: "Blacklist" };
const inputClass = "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-violet-400";

export function CreatorDetailManager({ workspaceId, creatorId, canWrite, canBlacklist, canAssign }: { workspaceId: string; creatorId: string; canWrite: boolean; canBlacklist: boolean; canAssign: boolean }) {
  const [creator, setCreator] = useState<Creator | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [followers, setFollowers] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [selectedMember, setSelectedMember] = useState("");
  const [tagLabel, setTagLabel] = useState("");
  const base = `/api/workspaces/${workspaceId}/creators/${creatorId}`;
  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as Creator & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Kreator tidak ditemukan.");
      setCreator(data); setUsername(data.username); setDisplayName(data.displayName); setFollowers(data.followerCount?.toString() ?? ""); setBio(data.profile?.bio ?? ""); setError("");
      const assignment = data.assignments[0]; setSelectedMember(assignment?.memberId ?? "");
      if (canAssign) {
        const memberResponse = await fetch(`/api/workspaces/${workspaceId}/members`, { cache: "no-store" });
        const memberData = await memberResponse.json().catch(() => ({})) as { members?: MemberOption[]; error?: string };
        if (!memberResponse.ok) throw new Error(memberData.error ?? "Gagal memuat anggota tim.");
        setMembers((memberData.members ?? []).filter((item) => item.status === "ACTIVE"));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
  }, [base, canAssign, workspaceId]);
  useEffect(() => { void load(); }, [load]);
  async function csrf() { return fetch("/api/auth/csrf", { cache: "no-store" }).then((r) => r.json()).then((b) => (b as { csrfToken?: string }).csrfToken ?? "").catch(() => ""); }
  async function submit(url: string, method: string, payload: unknown, success: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json", "x-csrf-token": await csrf() }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Perubahan gagal disimpan.");
      setMessage(success); await load(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); return false; }
    finally { setBusy(false); }
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await submit(base, "PATCH", { username, displayName, followerCount: followers || null, bio }, "Profil kreator diperbarui.")) setEditing(false);
  }
  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (await submit(`${base}/notes`, "POST", { body: note }, "Catatan ditambahkan.")) setNote("");
  }
  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedMember) await submit(`${base}/assignment`, "PUT", { memberId: selectedMember }, "PIC kreator diperbarui.");
    else await submit(`${base}/assignment`, "DELETE", {}, "PIC kreator dilepas.");
  }
  async function addTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await submit(`${base}/tags`, "POST", { label: tagLabel }, "Tag ditambahkan.")) setTagLabel("");
  }
  async function removeTag(tagId: string) {
    await submit(`${base}/tags`, "DELETE", { tagId }, "Tag dihapus dari kreator.");
  }
  if (!creator) return <div className="flex flex-col gap-3"><Link href={`/workspaces/${workspaceId}/creators`} className="text-sm text-slate-400">← Semua kreator</Link>{error ? <p className="text-sm text-red-300">{error}</p> : <p className="text-sm text-slate-400">Memuat profil…</p>}</div>;
  return <div className="flex flex-col gap-6"><header><Link href={`/workspaces/${workspaceId}/creators`} className="text-sm text-slate-400 hover:text-slate-100">← Semua kreator</Link><div className="mt-3 flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-[0.2em] text-violet-300">Creator profile</p><h1 className="mt-1 text-3xl font-semibold">{creator.displayName}</h1><p className="mt-1 text-sm text-slate-400">@{creator.username} · {creator.followerCount?.toLocaleString("id-ID") ?? "Followers belum dicatat"}</p></div><span className="rounded-full border border-slate-700 px-3 py-1 text-xs">{labels[creator.status]}</span></div></header>
    {error ? <p className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">{error}</p> : null}{message ? <p className="text-sm text-emerald-300">{message}</p> : null}
    <div className="grid gap-4 lg:grid-cols-2"><section className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4"><div className="flex justify-between"><div><h2 className="font-semibold">Profil</h2><p className="mt-1 text-xs text-slate-400">Catatan profil manual sampai integrasi API tersedia.</p></div>{canWrite ? <button onClick={() => setEditing(!editing)} className="text-xs text-violet-300">{editing ? "Tutup" : "Edit"}</button> : null}</div>
      {editing ? <form className="flex flex-col gap-3" onSubmit={saveProfile}><label className="text-sm text-slate-300">Username<input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={96} /></label><label className="text-sm text-slate-300">Nama<input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={160} /></label><label className="text-sm text-slate-300">Followers<input className={inputClass} type="number" min="0" value={followers} onChange={(e) => setFollowers(e.target.value)} /></label><label className="text-sm text-slate-300">Bio / konteks<textarea className={inputClass} rows={3} maxLength={4000} value={bio} onChange={(e) => setBio(e.target.value)} /></label><button disabled={busy} className="rounded-md bg-violet-400 px-3 py-2 text-sm font-semibold text-slate-950">Simpan profil</button></form> : <div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-slate-500">Wilayah</p><p>{creator.profile?.region ?? "—"}</p></div><div><p className="text-xs text-slate-500">Bahasa</p><p>{creator.profile?.language ?? "—"}</p></div><div className="col-span-2"><p className="text-xs text-slate-500">Bio / konteks</p><p className="mt-1 whitespace-pre-wrap text-slate-300">{creator.profile?.bio ?? "Belum ada catatan profil."}</p></div></div>}
      {canWrite ? <label className="text-sm text-slate-300">Tahap hubungan<select className={inputClass} value={creator.status === "BLACKLISTED" ? "NEW" : creator.status} disabled={creator.status === "BLACKLISTED"} onChange={(e) => void submit(base, "PATCH", { status: e.target.value }, "Tahap kreator diperbarui.")}>{STATUSES.map((status) => <option key={status} value={status}>{labels[status]}</option>)}</select></label> : null}
      {canBlacklist ? <div className="border-t border-slate-800 pt-4">{creator.status === "BLACKLISTED" && creator.blacklist?.revokedAt === null ? <div><p className="text-sm text-red-300">Blacklist aktif: {creator.blacklist.reason}</p><button disabled={busy} className="mt-2 text-xs text-slate-300 underline" onClick={() => void submit(`${base}/blacklist`, "DELETE", {}, "Blacklist dicabut.")}>Cabut blacklist</button></div> : <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void submit(`${base}/blacklist`, "POST", { reason }, "Kreator masuk blacklist.").then((ok) => { if (ok) setReason(""); }); }}><label className="text-sm text-slate-300">Alasan blacklist<input className={inputClass} required maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Mis. tidak ingin menerima outreach" /></label><button disabled={busy} className="self-start rounded-md border border-red-900 px-3 py-2 text-xs text-red-200 disabled:opacity-50">Masukkan blacklist</button></form>}</div> : null}
    </section><section className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4"><div><h2 className="font-semibold">Catatan tim</h2><p className="mt-1 text-xs text-slate-400">Percakapan dan konteks yang perlu diketahui tim.</p></div>{canWrite ? <form onSubmit={addNote} className="flex flex-col gap-2"><textarea className={inputClass} required rows={3} maxLength={10000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tulis catatan…" /><button disabled={busy} className="self-start rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-950">Tambah catatan</button></form> : null}<div className="flex flex-col gap-2">{creator.notes.map((item) => <article key={item.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><p className="whitespace-pre-wrap text-sm text-slate-200">{item.body}</p><p className="mt-2 text-xs text-slate-500">{new Date(item.createdAt).toLocaleString("id-ID")}</p></article>)}{!creator.notes.length ? <p className="text-sm text-slate-500">Belum ada catatan.</p> : null}</div></section></div>
    <section className="grid gap-4 lg:grid-cols-2"><div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4"><h2 className="font-semibold">Tag</h2><div className="mt-3 flex flex-wrap gap-2">{creator.tagAssignments.map(({ tag }) => <span key={tag.id} className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs" style={{ backgroundColor: tag.color ?? "#334155" }}>{tag.label}{canWrite ? <button aria-label={`Hapus tag ${tag.label}`} onClick={() => void removeTag(tag.id)}>×</button> : null}</span>)}{!creator.tagAssignments.length ? <span className="text-sm text-slate-500">Belum ada tag.</span> : null}</div>{canWrite ? <form onSubmit={addTag} className="mt-4 flex gap-2"><input className={inputClass} value={tagLabel} onChange={(e) => setTagLabel(e.target.value)} maxLength={64} required placeholder="Tambah tag" /><button disabled={busy} className="shrink-0 rounded-md border border-slate-700 px-3 py-2 text-sm">Tambah</button></form> : null}</div>
      {canAssign ? <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4"><h2 className="font-semibold">PIC / BD owner</h2><p className="mt-1 text-xs text-slate-400">Satu anggota aktif bertanggung jawab untuk follow-up.</p><form onSubmit={assign} className="mt-3 flex gap-2"><select className={inputClass} value={selectedMember} onChange={(e) => setSelectedMember(e.target.value)}><option value="">Tidak ditugaskan</option>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName} · {member.email}</option>)}</select><button disabled={busy} className="shrink-0 rounded-md border border-slate-700 px-3 py-2 text-sm">Simpan</button></form></div> : null}</section>
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4"><h2 className="font-semibold">Riwayat tahap</h2><div className="mt-3 flex flex-col gap-2">{creator.statusHistory.map((item) => <div key={item.id} className="flex flex-wrap justify-between gap-2 border-t border-slate-800 py-2 text-sm"><span>{item.fromStatus ? labels[item.fromStatus] : "Dibuat"} → {labels[item.toStatus]}</span><span className="text-xs text-slate-500">{new Date(item.changedAt).toLocaleString("id-ID")}{item.reason ? ` · ${item.reason}` : ""}</span></div>)}{!creator.statusHistory.length ? <p className="text-sm text-slate-500">Belum ada riwayat.</p> : null}</div></section>
  </div>;
}
