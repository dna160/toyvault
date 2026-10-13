import { type Kysely, sql } from "kysely";

// Review: corrections made through Claude Desktop are recorded in an audit log, and a
// product the operator corrected by hand is protected from later web data.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE edits (
      id            bigserial PRIMARY KEY,
      subject_type  text NOT NULL CHECK (subject_type IN ('unit','catalog_item')),
      subject_id    text NOT NULL,
      before        jsonb NOT NULL,
      after         jsonb NOT NULL,
      reason        text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX edits_subject ON edits (subject_type, subject_id, created_at);

    ALTER TABLE catalog_items ADD COLUMN operator_corrected boolean NOT NULL DEFAULT false;
    ALTER TABLE units ADD COLUMN reviewed_at timestamptz;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("ToyVault migrations are forward-only");
}
