import { sql } from "kysely";
import type { DB } from "./db.js";

export interface IntegrityReport {
  ok: boolean;
  unitsWithoutPosition: string[];
  unitsWithoutResolvedLocation: string[];
  projectionMismatches: string[];
}

/**
 * Ledger invariants (master prompt §6): every unit has exactly one projection row, it
 * resolves to a location, and the projection equals a replay of the movement log.
 */
export async function checkIntegrity(db: DB): Promise<IntegrityReport> {
  const noPosition = await sql<{ id: string }>`
    SELECT u.id FROM units u
     WHERE NOT EXISTS (SELECT 1 FROM stock_position sp WHERE sp.subject_type = 'unit' AND sp.subject_id = u.id)
  `.execute(db);

  const unresolved = await sql<{ id: string }>`
    SELECT u.id FROM units u
     WHERE NOT EXISTS (SELECT 1 FROM unit_current_location ucl WHERE ucl.unit_id = u.id)
  `.execute(db);

  // Replay: the latest movement per subject must match the projection row.
  const mismatches = await sql<{ subject: string }>`
    WITH latest AS (
      SELECT DISTINCT ON (coalesce(unit_id, container_id))
             CASE WHEN unit_id IS NOT NULL THEN 'unit' ELSE 'container' END AS subject_type,
             coalesce(unit_id, container_id) AS subject_id,
             id, to_location_id, to_container_id
        FROM movements
       ORDER BY coalesce(unit_id, container_id), created_at DESC, id DESC
    )
    SELECT l.subject_type || ':' || l.subject_id AS subject
      FROM latest l
      LEFT JOIN stock_position sp ON sp.subject_type = l.subject_type AND sp.subject_id = l.subject_id
     WHERE sp.subject_id IS NULL
        OR sp.last_movement_id <> l.id
        OR sp.location_id IS DISTINCT FROM l.to_location_id
        OR sp.container_id IS DISTINCT FROM l.to_container_id
  `.execute(db);

  const report = {
    unitsWithoutPosition: noPosition.rows.map((r) => r.id),
    unitsWithoutResolvedLocation: unresolved.rows.map((r) => r.id),
    projectionMismatches: mismatches.rows.map((r) => r.subject),
  };
  return {
    ok: Object.values(report).every((v) => v.length === 0),
    ...report,
  };
}
