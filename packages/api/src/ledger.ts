import { type Transaction, sql } from "kysely";
import type { Database, MovementsTable } from "./db.js";
import { badRequest } from "./errors.js";

type Trx = Transaction<Database>;

export interface MovementInput {
  type: MovementsTable["type"];
  unitId?: string;
  containerId?: string;
  toLocationId?: string;
  toContainerId?: string;
  batchId?: string;
  evidencePhotoId?: string;
  confidence?: number;
  method?: MovementsTable["method"];
  reason?: string;
  idempotencyKey: string;
  /** Set on compensating movements written by undo. */
  compensatesMovementId?: string;
}

/**
 * Append one movement and update the stock_position projection in the same transaction.
 * Replaying the same idempotency key returns the original movement and changes nothing.
 */
export async function recordMovement(trx: Trx, m: MovementInput): Promise<{ id: string; replayed: boolean }> {
  if (!m.unitId === !m.containerId) throw badRequest("a movement needs exactly one of unit or container");
  if (!m.toLocationId === !m.toContainerId) throw badRequest("a movement needs exactly one destination");

  const existing = await trx
    .selectFrom("movements")
    .select("id")
    .where("idempotency_key", "=", m.idempotencyKey)
    .executeTakeFirst();
  if (existing) return { id: existing.id, replayed: true };

  const subjectType = m.unitId ? "unit" : "container";
  const subjectId = (m.unitId ?? m.containerId)!;

  if (m.toContainerId) await assertNoContainerCycle(trx, subjectType, subjectId, m.toContainerId);

  // Lock the projection row so concurrent moves of the same subject serialize.
  const current = await trx
    .selectFrom("stock_position")
    .select(["location_id", "container_id"])
    .where("subject_type", "=", subjectType)
    .where("subject_id", "=", subjectId)
    .forUpdate()
    .executeTakeFirst();

  const inserted = await trx
    .insertInto("movements")
    .values({
      type: m.type,
      unit_id: m.unitId ?? null,
      container_id: m.containerId ?? null,
      from_location_id: current?.location_id ?? null,
      from_container_id: current?.container_id ?? null,
      to_location_id: m.toLocationId ?? null,
      to_container_id: m.toContainerId ?? null,
      batch_id: m.batchId ?? null,
      evidence_photo_id: m.evidencePhotoId ?? null,
      confidence: m.confidence ?? null,
      method: m.method ?? null,
      reason: m.reason ?? null,
      idempotency_key: m.idempotencyKey,
      compensates_movement_id: m.compensatesMovementId ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await trx
    .insertInto("stock_position")
    .values({
      subject_type: subjectType,
      subject_id: subjectId,
      location_id: m.toLocationId ?? null,
      container_id: m.toContainerId ?? null,
      last_movement_id: inserted.id,
    })
    .onConflict((oc) =>
      oc.columns(["subject_type", "subject_id"]).doUpdateSet({
        location_id: m.toLocationId ?? null,
        container_id: m.toContainerId ?? null,
        last_movement_id: inserted.id,
        updated_at: sql`now()`,
      }),
    )
    .execute();

  await refreshSearchFor(trx, subjectType, subjectId);
  return { id: inserted.id, replayed: false };
}

/** Keep the search document (which includes the location path) in step with the move. */
async function refreshSearchFor(trx: Trx, subjectType: "unit" | "container", subjectId: string) {
  if (subjectType === "unit") {
    await sql`SELECT refresh_unit_search(ARRAY[${subjectId}]::text[])`.execute(trx);
    return;
  }
  await sql`
    WITH RECURSIVE inside AS (
      SELECT subject_type, subject_id FROM stock_position WHERE container_id = ${subjectId}
      UNION
      SELECT sp.subject_type, sp.subject_id FROM stock_position sp
        JOIN inside i ON i.subject_type = 'container' AND sp.container_id = i.subject_id
    )
    SELECT refresh_unit_search(coalesce(array_agg(subject_id) FILTER (WHERE subject_type = 'unit'), '{}'))
      FROM inside
  `.execute(trx);
}

/** Reject putting a container inside itself or inside one of its own descendants. */
async function assertNoContainerCycle(trx: Trx, subjectType: string, subjectId: string, target: string) {
  if (subjectType !== "container") return;
  if (subjectId === target) throw badRequest(`container ${subjectId} cannot contain itself`);
  const result = await sql<{ hit: boolean }>`
    WITH RECURSIVE ancestors AS (
      SELECT container_id FROM stock_position WHERE subject_type = 'container' AND subject_id = ${target}
      UNION
      SELECT sp.container_id FROM ancestors a
        JOIN stock_position sp ON sp.subject_type = 'container' AND sp.subject_id = a.container_id
       WHERE a.container_id IS NOT NULL
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE container_id = ${subjectId}) AS hit
  `.execute(trx);
  if (result.rows[0]?.hit) throw badRequest(`moving ${subjectId} into ${target} would create a container cycle`);
}
