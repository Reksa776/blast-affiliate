"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type RoleOption = { key: string; label: string };

type MemberRoleSelectProps = {
  workspaceId: string;
  memberId: string;
  currentRole: string;
  roles: RoleOption[];
};

/**
 * Inline role dropdown (P1 MEDIUM #6, item 3d; closes Phase 2 TD-8-R7).
 *
 * Calls the existing PATCH /members/:memberId/role route with a fresh CSRF token.
 * That route refuses changing your own role and revokes every live session of the
 * target user, so the page refreshes after success instead of assuming the local
 * state is the whole story.
 */
export function MemberRoleSelect({
  workspaceId,
  memberId,
  currentRole,
  roles,
}: MemberRoleSelectProps) {
  const router = useRouter();
  const [value, setValue] = useState(currentRole);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeRole(next: string) {
    if (next === value) return;
    setBusy(true);
    setError(null);

    try {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const csrfBody = (await csrfResponse.json().catch(() => ({}))) as { csrfToken?: string };

      const response = await fetch(
        `/api/workspaces/${workspaceId}/members/${memberId}/role`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfBody.csrfToken ?? "",
          },
          body: JSON.stringify({ roleKey: next }),
        },
      );

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Role change failed.");
        return;
      }

      setValue(next);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <select
        className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-slate-500 disabled:opacity-50"
        value={value}
        disabled={busy}
        onChange={(event) => void changeRole(event.target.value)}
        aria-label="Member role"
      >
        {value === "" ? (
          <option value="" disabled>
            No role
          </option>
        ) : null}
        {roles.map((role) => (
          <option key={role.key} value={role.key}>
            {role.label}
          </option>
        ))}
      </select>
      {error === null ? null : <p className="mt-1 text-xs text-red-300">{error}</p>}
    </div>
  );
}
