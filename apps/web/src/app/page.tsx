export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
        Phase 2 · Workspace &amp; member management
      </p>
      <h1 className="text-4xl font-semibold tracking-tight">AffiliateOS</h1>
      <p className="text-slate-300">
        Fondasi aplikasi berdiri: autentikasi, RBAC, isolasi tenant, audit, dan pengelolaan
        workspace/member. Modul absensi GPS, foto, dan revisi kehadiran belum dikerjakan.
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          className="w-fit rounded-md border border-slate-700 px-4 py-2 text-sm hover:border-slate-500"
          href="/sign-in"
        >
          Sign in →
        </a>
        <a
          className="w-fit rounded-md border border-slate-700 px-4 py-2 text-sm hover:border-slate-500"
          href="/workspaces"
        >
          Open workspaces →
        </a>
      </div>
      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5 text-sm">
        <div>
          <dt className="text-slate-400">Database</dt>
          <dd className="font-mono text-slate-100">affiliateos</dd>
        </div>
        <div>
          <dt className="text-slate-400">Prisma</dt>
          <dd className="font-mono text-slate-100">7.10.1</dd>
        </div>
      </dl>
    </main>
  );
}
