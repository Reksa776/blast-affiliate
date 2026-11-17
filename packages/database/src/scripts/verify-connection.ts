// Checkpoint 6A connectivity proof — READ ONLY.
//
// Executes exactly two SELECT statements through Prisma Client + the MariaDB
// adapter. No DDL, no DML, no migration, no second database.
//
// The environment is loaded BEFORE `../client.js` is imported: the client opens
// its pool at module-evaluation time, so a static import here would evaluate it
// before DATABASE_URL exists (this failed once and is recorded in the report).

import { loadRepoEnv } from "../env.js";

type IdentityRow = {
  version: string;
  database_name: string | null;
};

type UserRow = {
  cu: string;
  su: string;
};

const envPath = loadRepoEnv();
const { prisma, disconnectPrisma } = await import("../client.js");

async function main(): Promise<void> {
  // Report only the location, never the contents.
  console.log(`env_loaded_from=${envPath.replace(process.env.HOME ?? "", "~")}`);

  const [identity] = await prisma.$queryRaw<IdentityRow[]>`
    SELECT VERSION() AS version, DATABASE() AS database_name
  `;

  // Aliases must avoid reserved words (`current_user` is one; it failed once).
  const [account] = await prisma.$queryRaw<UserRow[]>`
    SELECT CURRENT_USER() AS cu, SESSION_USER() AS su
  `;

  console.log(`version=${identity?.version ?? "UNKNOWN"}`);
  console.log(`database_name=${identity?.database_name ?? "NULL"}`);
  console.log(`current_user=${account?.cu ?? "UNKNOWN"}`);
  console.log(`session_user=${account?.su ?? "UNKNOWN"}`);
}

main()
  .then(async () => {
    await disconnectPrisma();
    console.log("result=OK");
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Driver messages can embed connection details; redact anything URL-shaped.
    const safe = message.replace(/mysql:\/\/\S+/g, "mysql://<redacted>");
    console.error(`result=FAIL reason_class=${error instanceof Error ? error.name : "unknown"}`);
    console.error(safe);
    await disconnectPrisma().catch(() => undefined);
    process.exitCode = 1;
  });
