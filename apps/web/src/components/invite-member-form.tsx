"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export type RoleOption = { key: string; label: string };

type InviteMemberFormProps = {
  workspaceId: string;
  roles: RoleOption[];
};

/**
 * Posts to the existing invite endpoint. It mints a fresh CSRF token first because
 * the double-submit cookie is readable by the browser by design.
 */
export function InviteMemberForm({ workspaceId, roles }: InviteMemberFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? "VIEWER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [invitationLink, setInvitationLink] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const csrfBody = (await csrfResponse.json().catch(() => ({}))) as { csrfToken?: string };

      const response = await fetch(`/api/workspaces/${workspaceId}/members`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfBody.csrfToken ?? "",
        },
        body: JSON.stringify({ email, roleKey }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        devToken?: string;
      };

      if (!response.ok) {
        setError(body.error ?? "Invitation failed.");
        return;
      }

      setEmail("");
      if (body.devToken !== undefined) {
        setInvitationLink(`${window.location.origin}/accept-invitation?token=${encodeURIComponent(body.devToken)}`);
        setMessage("Undangan dibuat. Bagikan link ini secara pribadi kepada penerima.");
      } else {
        setInvitationLink(null);
        setMessage("Undangan tercatat, tetapi email belum dikonfigurasi sehingga link belum terkirim.");
      }
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5"
      onSubmit={handleSubmit}
    >
      <h2 className="text-lg font-semibold">Invite a member</h2>

      <label className="text-sm text-slate-300">
        Email
        <input
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="new.member@example.com"
        />
      </label>

      <label className="text-sm text-slate-300">
        Role
        <select
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
          value={roleKey}
          onChange={(event) => setRoleKey(event.target.value)}
        >
          {roles.map((role) => (
            <option key={role.key} value={role.key}>
              {role.label}
            </option>
          ))}
        </select>
      </label>

      <button
        className="mt-1 rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        {busy ? "Sending…" : "Send invitation"}
      </button>

      {error === null ? null : <p className="text-sm text-red-300">{error}</p>}
      {message === null ? null : <p className="text-sm text-emerald-300">{message}</p>}
      {invitationLink ? (
        <div className="rounded-md border border-slate-700 bg-slate-950 p-3">
          <label className="text-xs text-slate-400">Link undangan (token rahasia)</label>
          <div className="mt-1 flex gap-2">
            <input className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-200" readOnly value={invitationLink} />
            <button className="rounded border border-slate-700 px-2 text-xs" type="button" onClick={() => void navigator.clipboard.writeText(invitationLink).catch(() => setError("Browser tidak bisa menyalin link. Salin teksnya manual."))}>Salin</button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
