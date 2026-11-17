"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export type OfficeFormValues = {
  name: string;
  address: string;
  timezone: string;
  workStart: string;
  workEnd: string;
};

type OfficeSettingsFormProps = {
  workspaceId: string;
  initial: OfficeFormValues;
};

/** PATCHes the office-settings endpoint with a fresh double-submit CSRF token. */
export function OfficeSettingsForm({ workspaceId, initial }: OfficeSettingsFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<OfficeFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function update<K extends keyof OfficeFormValues>(field: K, value: OfficeFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const csrfBody = (await csrfResponse.json().catch(() => ({}))) as { csrfToken?: string };

      const response = await fetch(`/api/workspaces/${workspaceId}/office`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfBody.csrfToken ?? "",
        },
        body: JSON.stringify({
          name: values.name,
          address: values.address.trim() === "" ? null : values.address,
          timezone: values.timezone,
          workStart: values.workStart,
          workEnd: values.workEnd,
        }),
      });

      const body = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? "Could not save office settings.");
        return;
      }

      setMessage("Office settings saved.");
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5"
      onSubmit={handleSubmit}
    >
      <label className="text-sm text-slate-300">
        Office name
        <input
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
          value={values.name}
          onChange={(event) => update("name", event.target.value)}
          maxLength={150}
          required
        />
      </label>

      <label className="text-sm text-slate-300">
        Address
        <textarea
          className="mt-1 min-h-20 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
          value={values.address}
          onChange={(event) => update("address", event.target.value)}
          maxLength={255}
          placeholder="Street, city, province"
        />
      </label>

      <label className="text-sm text-slate-300">
        Timezone (IANA)
        <input
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 outline-none focus:border-slate-500"
          value={values.timezone}
          onChange={(event) => update("timezone", event.target.value)}
          maxLength={64}
          placeholder="Asia/Jakarta"
          required
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-slate-300">
          Work start
          <input
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
            type="time"
            value={values.workStart}
            onChange={(event) => update("workStart", event.target.value)}
            required
          />
        </label>
        <label className="text-sm text-slate-300">
          Work end
          <input
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
            type="time"
            value={values.workEnd}
            onChange={(event) => update("workEnd", event.target.value)}
            required
          />
        </label>
      </div>

      <button
        className="mt-1 rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        {busy ? "Saving…" : "Save settings"}
      </button>

      {error === null ? null : <p className="text-sm text-red-300">{error}</p>}
      {message === null ? null : <p className="text-sm text-emerald-300">{message}</p>}
    </form>
  );
}
