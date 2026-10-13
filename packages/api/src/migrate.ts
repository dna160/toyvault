import { type Migration, type MigrationProvider, Migrator } from "kysely";
import type { DB } from "./db.js";
import * as m0001 from "./migrations/0001_init.js";
import * as m0002 from "./migrations/0002_search_catalog_undo.js";

// Migrations are compiled into the bundle (no filesystem scanning), so the same code
// runs in tests, locally and on Railway.
const migrations: Record<string, Migration> = {
  "0001_init": m0001,
  "0002_search_catalog_undo": m0002,
};

class StaticProvider implements MigrationProvider {
  async getMigrations() {
    return migrations;
  }
}

export async function migrateToLatest(db: DB): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
