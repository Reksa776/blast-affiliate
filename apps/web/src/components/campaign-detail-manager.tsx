"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type CreatorOption = { id: string; username: string; displayName: string; followerCount: number | null; previousInviteError?: string | null; inviteAttempts?: number };
type Campaign = { id: string; name: string; shopName: string | null; status: string; startsAt: string; endsAt: string | null; budget: string | number | null; currency: string; creators: { id: string; status: string; invitedAt: string; inviteAttempts: number; inviteError: string | null; creator: CreatorOption }[]; contents: { id: string; kind: string; version: number; title: string; body: string; createdAt: string }[] };
const inputClass = "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-violet-400";

export function CampaignDetailManager({ workspaceId, campaignId, canWrite }: { workspaceId: string; campaignId: string; canWrite: boolean }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [available, setAvailable] = useState<CreatorOption[]>([]);
  const [selectedCreatorIds, setSelectedCreatorIds] = useState<string[]>([]);
  const [messageTemplate, setMessageTemplate] = useState("Halo {{nama}}, aku ingin mengajak kamu ikut campaign {{campaign}}. Kalau tertarik, kabari aku ya!");
  const [manualCopyText, setManualCopyText] = useState("");
  const [confirmSent, setConfirmSent] = useState(false);
  const [confirmFailure, setConfirmFailure] = useState(false);
  const [failureReason, setFailureReason] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const base = `/api/workspaces/${workspaceId}/campaigns/${campaignId}`;
      const [campaignResponse, creatorResponse] = await Promise.all([fetch(base, { cache: "no-store" }), fetch(`${base}/creators`, { cache: "no-store" })]);
      const campaignBody = await campaignResponse.json().catch(() => ({})) as Campaign & { error?: string };
      const creatorBody = await creatorResponse.json().catch(() => ({})) as { available?: CreatorOption[]; error?: string };
      if (!campaignResponse.ok) throw new Error(campaignBody.error ?? "Campaign tidak ditemukan.");
      if (!creatorResponse.ok) throw new Error(creatorBody.error ?? "Gagal memuat daftar kreator.");
      setCampaign(campaignBody); setAvailable(creatorBody.available ?? []); setSelectedCreatorIds((ids) => ids.filter((id) => (creatorBody.available ?? []).some((item) => item.id === id))); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
  }, [workspaceId, campaignId]);
  useEffect(() => { void load(); }, [load]);

  async function csrfToken() { return fetch("/api/auth/csrf", { cache: "no-store" }).then((response) => response.json()).then((data) => (data as { csrfToken?: string }).csrfToken ?? "").catch(() => ""); }
  const selectedCreators = available.filter((creator) => selectedCreatorIds.includes(creator.id));

  function personalizeMessage(creator: CreatorOption) {
    return messageTemplate
      .replaceAll("{{nama}}", creator.displayName)
      .replaceAll("{{username}}", `@${creator.username}`)
      .replaceAll("{{campaign}}", campaign?.name ?? "campaign ini")
      .replaceAll("{{brand}}", campaign?.shopName ?? "brand kami");
  }

  function toggleCreator(id: string, checked: boolean) {
    setError("");
    if (checked && !selectedCreatorIds.includes(id) && selectedCreatorIds.length >= 100) {
      setError("Maksimal 100 kreator per batch.");
      return;
    }
    setSelectedCreatorIds((current) => checked
      ? current.includes(id) ? current : [...current, id]
      : current.filter((creatorId) => creatorId !== id));
    setConfirmSent(false);
    setConfirmFailure(false);
    setManualCopyText("");
  }

  function toggleFirstBatch() {
    const firstBatch = available.slice(0, 100).map((creator) => creator.id);
    const alreadySelected = firstBatch.length > 0 && firstBatch.every((id) => selectedCreatorIds.includes(id));
    setSelectedCreatorIds(alreadySelected ? [] : firstBatch);
    setConfirmSent(false);
    setConfirmFailure(false);
    setManualCopyText("");
    setError("");
  }

  async function copyInviteMessages() {
    if (!selectedCreators.length) return;
    const text = selectedCreators.map((creator) => `${creator.displayName} (@${creator.username})\n${personalizeMessage(creator)}`).join("\n\n──────────\n\n");
    setManualCopyText(text);
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`${selectedCreators.length} pesan personal disalin. Kirim pesannya satu per satu lewat channel pilihanmu.`);
      setError("");
    } catch {
      setError("Clipboard tidak tersedia. Izinkan akses clipboard di browser atau salin pesan dari preview.");
    }
  }

  async function recordInviteOutcome(outcome: "SENT" | "FAILED") {
    if (!selectedCreators.length || (outcome === "SENT" && !confirmSent) || (outcome === "FAILED" && !confirmFailure)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns/${campaignId}/creators/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() },
        body: JSON.stringify({ creatorIds: selectedCreators.map((creator) => creator.id), outcome, failureReason }),
      });
      const data = await response.json().catch(() => ({})) as { recorded?: number; alreadyAdded?: number; skipped?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Gagal mencatat undangan.");
      setMessage(outcome === "FAILED"
        ? `${data.recorded ?? 0} undangan dicatat gagal${data.alreadyAdded ? `, ${data.alreadyAdded} sudah di tahap berikutnya` : ""}${data.skipped ? `, ${data.skipped} dilewati` : ""}. Pilih lagi kreator gagal itu untuk mencoba ulang.`
        : `${data.recorded ?? 0} undangan berhasil dicatat${data.alreadyAdded ? `, ${data.alreadyAdded} sudah ada` : ""}${data.skipped ? `, ${data.skipped} dilewati` : ""}.`);
      setSelectedCreatorIds([]); setConfirmSent(false); setConfirmFailure(false); setFailureReason(""); setManualCopyText(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }
  async function removeCreator(id: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns/${campaignId}/creators`, { method: "DELETE", headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() }, body: JSON.stringify({ creatorId: id }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok && response.status !== 204) throw new Error(data.error ?? "Gagal menghapus kreator.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }
  async function addBrief(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/campaigns/${campaignId}/brief`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() }, body: JSON.stringify({ title, body }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Gagal menyimpan brief.");
      setTitle(""); setBody(""); setMessage("Brief baru tersimpan sebagai versi berikutnya."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koneksi bermasalah."); }
    finally { setBusy(false); }
  }
  if (!campaign) return <div className="flex flex-col gap-4"><Link href={`/workspaces/${workspaceId}/campaigns`} className="text-sm text-slate-400 hover:text-slate-100">← Semua campaign</Link>{error ? <p className="text-sm text-red-300">{error}</p> : <p className="text-sm text-slate-400">Memuat campaign…</p>}</div>;

  return <div className="flex flex-col gap-6"><header><Link href={`/workspaces/${workspaceId}/campaigns`} className="text-sm text-slate-400 hover:text-slate-100">← Semua campaign</Link><div className="mt-3 flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-[0.2em] text-violet-300">Campaign · {campaign.status}</p><h1 className="mt-1 text-3xl font-semibold">{campaign.name}</h1><p className="mt-2 text-sm text-slate-400">{campaign.shopName || "Belum ditautkan ke toko"} · {new Date(campaign.startsAt).toLocaleDateString("id-ID")}{campaign.endsAt ? ` – ${new Date(campaign.endsAt).toLocaleDateString("id-ID")}` : ""}</p></div><span className="rounded-full border border-amber-800/70 bg-amber-950/30 px-3 py-1 text-xs text-amber-200">Lokal · belum tersinkron</span></div></header>
    {error ? <p className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">{error}</p> : null}{message ? <p className="text-sm text-emerald-300">{message}</p> : null}
    <section className="grid gap-4 lg:grid-cols-2"><div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4"><div><h2 className="text-lg font-semibold">Undangan affiliate</h2><p className="mt-1 text-xs text-slate-400">Pilih sampai 100 kreator, salin pesan personal, lalu kirim satu per satu lewat channel pilihanmu. Aplikasi belum mengirim pesan otomatis.</p></div>
      {canWrite ? <>
        <div className="flex items-center justify-between gap-3"><p className="text-sm text-slate-300">Kreator tersedia: {available.length}{available.length === 200 ? "+" : ""} · dipilih: {selectedCreatorIds.length}/100</p><button type="button" onClick={toggleFirstBatch} disabled={!available.length || busy} className="text-xs text-violet-300 hover:text-violet-200 disabled:opacity-50">{available.slice(0, 100).length > 0 && available.slice(0, 100).every((item) => selectedCreatorIds.includes(item.id)) ? "Batal pilih" : "Pilih 100 pertama"}</button></div>
        <div className="max-h-52 divide-y divide-slate-800 overflow-y-auto rounded-md border border-slate-800 px-3">
          {available.map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-3 py-2 text-sm">
            <input type="checkbox" checked={selectedCreatorIds.includes(item.id)} disabled={busy || (!selectedCreatorIds.includes(item.id) && selectedCreatorIds.length >= 100)} onChange={(event) => toggleCreator(item.id, event.target.checked)} />
            <span className="min-w-0"><span className="block truncate text-slate-200">{item.displayName}</span><span className="text-xs text-slate-500">@{item.username}</span>{item.previousInviteError ? <span className="block text-xs text-amber-300">Undangan gagal sebelumnya · {item.previousInviteError}</span> : null}</span>
          </label>)}
          {!available.length ? <p className="py-4 text-sm text-slate-500">Belum ada kreator yang bisa diundang. Tambahkan kreator ke CRM terlebih dulu.</p> : null}
        </div>
        <label className="text-sm text-slate-300">Template pesan
          <textarea className={inputClass} rows={4} maxLength={4000} value={messageTemplate} onChange={(event) => { setMessageTemplate(event.target.value); setManualCopyText(""); }} placeholder="Tulis pesan undangan" />
          <span className="mt-1 block text-xs text-slate-500">Variabel: {"{{nama}}"}, {"{{username}}"}, {"{{campaign}}"}, {"{{brand}}"}.</span>
        </label>
        {selectedCreators.length > 0 ? <details className="rounded-md border border-slate-800 bg-slate-950/50 p-3"><summary className="cursor-pointer text-xs text-slate-300">Preview dan salin manual ({selectedCreators.length} pesan)</summary><p className="mt-2 text-xs text-slate-500">Kalau clipboard tidak tersedia, pilih dan salin teks berikut.</p><textarea readOnly className={inputClass} rows={8} value={manualCopyText || selectedCreators.map((creator) => `${creator.displayName} (@${creator.username})\n${personalizeMessage(creator)}`).join("\n\n──────────\n\n")} /></details> : null}
        <label className="text-sm text-slate-300">Catatan error (opsional)<input className={inputClass} maxLength={255} value={failureReason} onChange={(event) => setFailureReason(event.target.value)} placeholder="Contoh: pesan tidak terkirim di channel pilihan" /></label>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={!selectedCreators.length || busy} onClick={() => void copyInviteMessages()} className="rounded-md border border-slate-700 px-3 py-2 text-sm hover:border-violet-400 disabled:opacity-50">Salin semua pesan</button><button type="button" disabled={!selectedCreators.length || !confirmSent || busy} onClick={() => void recordInviteOutcome("SENT")} className="rounded-md bg-violet-400 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{busy ? "Mencatat…" : "Catat undangan terkirim"}</button><button type="button" disabled={!selectedCreators.length || !confirmFailure || busy} onClick={() => void recordInviteOutcome("FAILED")} className="rounded-md border border-red-800 px-3 py-2 text-sm text-red-200 hover:border-red-600 disabled:opacity-50">Catat gagal</button></div>
        <label className="flex items-start gap-2 text-xs text-slate-400"><input type="checkbox" checked={confirmSent} onChange={(event) => setConfirmSent(event.target.checked)} disabled={!selectedCreators.length || busy} /><span>Saya sudah mengirim pesan ke kreator terpilih di luar aplikasi.</span></label>
        <label className="flex items-start gap-2 text-xs text-slate-400"><input type="checkbox" checked={confirmFailure} onChange={(event) => setConfirmFailure(event.target.checked)} disabled={!selectedCreators.length || busy} /><span>Saya sudah mencoba mengirim pesan dan pengiriman gagal.</span></label>
      </> : null}
      <div><h3 className="text-sm font-medium text-slate-200">Kreator campaign ({campaign.creators.length})</h3><p className="text-xs text-slate-500">Status undangan yang sudah dicatat.</p></div>
      <div className="divide-y divide-slate-800">{campaign.creators.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{item.creator.displayName}</p><p className="text-xs text-slate-400">@{item.creator.username} · {item.status === "INVITE_FAILED" ? "Gagal diundang" : item.status} · {item.inviteAttempts} percobaan</p>{item.inviteError ? <p className="mt-1 text-xs text-red-300">{item.inviteError}</p> : null}</div>{canWrite ? <button disabled={busy} onClick={() => void removeCreator(item.creator.id)} className="text-xs text-slate-400 hover:text-red-300">Hapus</button> : null}</div>)}{!campaign.creators.length ? <p className="py-5 text-sm text-slate-500">Belum ada kreator ditautkan.</p> : null}</div>
    </div><div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4"><div><h2 className="text-lg font-semibold">Brief campaign</h2><p className="text-xs text-slate-400">Setiap simpan membuat versi baru agar riwayat brief tetap ada.</p></div>
      {canWrite ? <form className="flex flex-col gap-3" onSubmit={addBrief}><input className={inputClass} required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Judul brief" /><textarea className={inputClass} required maxLength={30000} rows={5} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Pesan utama, deliverables, CTA, timeline…" /><button disabled={busy} className="self-start rounded-md border border-slate-700 px-3 py-2 text-sm hover:border-violet-400 disabled:opacity-50">Simpan versi brief</button></form> : null}
      <div className="flex flex-col gap-3">{campaign.contents.filter((item) => item.kind === "BRIEF").map((item) => <article key={item.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><div className="flex justify-between gap-3"><h3 className="text-sm font-medium">{item.title}</h3><span className="text-xs text-slate-500">v{item.version}</span></div><p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{item.body}</p></article>)}{!campaign.contents.some((item) => item.kind === "BRIEF") ? <p className="text-sm text-slate-500">Belum ada brief.</p> : null}</div>
    </div></section></div>;
}
