import { type Kysely, sql } from "kysely";

// Location corrections ("these were recorded at the wrong place") are their own batch mode,
// so a whole correction can be listed in Batches and undone in one step.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE batches DROP CONSTRAINT batches_mode_check;
    ALTER TABLE batches ADD CONSTRAINT batches_mode_check CHECK (mode IN ('intake','move','pack','count','correction'));
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("ToyVault migrations are forward-only");
}
