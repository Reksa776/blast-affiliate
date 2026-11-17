"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

type WorkspaceOption = { id: string; name: string; slug: string };

/**
 * Header workspace switcher (P1 MEDIUM #6, item 3b).
 *
 * The list comes from GET /api/workspaces, i.e. from the same membership-scoped
 * endpoint the workspace page uses — the header never invents its own query. The
 * create modal POSTs the same endpoint and navigates to the new workspace; that
 * response also rotates the session cookie, which the browser stores automatically.
 */
export function WorkspaceSwitcher({ currentWorkspaceId }: { currentWorkspaceId: string }) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/workspaces", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { workspaces?: WorkspaceOption[] };
        if (!cancelled) setWorkspaces(body.workspaces ?? []);
      } catch {
        // The switcher keeps showing the current workspace; navigation still works.
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const current = workspaces.find((workspace) => workspace.id === currentWorkspaceId);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const csrfBody = (await csrfResponse.json().catch(() => ({}))) as { csrfToken?: string };

      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfBody.csrfToken ?? "",
        },
        body: JSON.stringify({ name, slug }),
      });

      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || body.id === undefined) {
        setError(body.error ?? "Could not create workspace.");
        return;
      }

      setOpen(false);
      setName("");
      setSlug("");
      router.push(`/workspaces/${body.id}`);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="workspace-switcher">
        Workspace
      </label>
      <select
        id="workspace-switcher"
        className="max-w-52 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
        value={current?.id ?? ""}
        onChange={(event) => {
          if (event.target.value !== "") router.push(`/workspaces/${event.target.value}`);
        }}
      >
        <option value="">{current?.name ?? "Switch workspace"}</option>
        {workspaces
          .filter((workspace) => workspace.id !== currentWorkspaceId)
          .map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
      </select>

      <button
        className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:border-slate-500"
        type="button"
        onClick={() => setOpen(true)}
      >
        + New
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4">
          <form
            className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-5"
            onSubmit={createWorkspace}
          >
            <h2 className="text-lg font-semibold">Create workspace</h2>
            <p className="mt-1 text-xs text-slate-400">
              Anda menjadi Workspace Owner pada workspace baru.
            </p>

            <label className="mt-4 block text-sm text-slate-300">
              Name
              <input
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={150}
                required
                placeholder="Jakarta HQ"
              />
            </label>

            <label className="mt-3 block text-sm text-slate-300">
              Slug
              <input
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 outline-none focus:border-slate-500"
                value={slug}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={64}
                required
                placeholder="jakarta-hq"
              />
            </label>

            {error === null ? null : <p className="mt-3 text-sm text-red-300">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200"
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-950 disabled:opacity-50"
                type="submit"
                disabled={busy}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
