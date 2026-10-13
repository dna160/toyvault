import type { UndoResult } from "@toyvault/shared";
import { sql } from "kysely";
import type { DB } from "./db.js";
import { HttpError, notFound } from "./errors.js";
import { recordMovement } from "./ledger.js";

/**
 * Reverse a whole batch with compensating movements. Nothing is deleted:
 * - a RECEIPT is compensated by a DISPOSE to the virtual "Disposed" location, and the
 *   unit is marked disposed with reason "undo" (its photos may then be listed again);
 * - any other movement is compensated by moving the subject back where it came from.
 * Undoing an already undone batch returns the original result.
 */
export async function undoBatch(db: DB, batchId: string): Promise<UndoResult> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`undo:${batchId}`}))`.execute(trx);
    const batch = await trx
      .selectFrom("batches")
      .select(["id", "status", "undo_receipt"])
      .where("id", "=", batchId)
      .forUpdate()
      .executeTakeFirst();
    if (!batch) throw notFound(`unknown batch ${batchId}`);
    if (batch.status === "undone") return { ...(batch.undo_receipt as UndoResult), replayed: true };

    const disposed = await trx
      .selectFrom("locations")
      .select("id")
      .where("path", "=", "Disposed")
      .executeTakeFirstOrThrow();

    // Newest first, so chained moves unwind in reverse order.
    const movements = await trx
      .selectFrom("movements")
      .selectAll()
      .where("batch_id", "=", batchId)
      .where("compensates_movement_id", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();

    const disposedUnits: string[] = [];
    let reversed = 0;
    for (const m of movements) {
      // Only reverse a movement that is still the subject's latest; otherwise a later
      // batch has moved it and blindly reversing would corrupt that history.
      const subjectType = m.unit_id ? "unit" : "container";
      const subjectId = (m.unit_id ?? m.container_id)!;
      const position = await trx
        .selectFrom("stock_position")
        .select("last_movement_id")
        .where("subject_type", "=", subjectType)
        .where("subject_id", "=", subjectId)
        .executeTakeFirst();
      if (position?.last_movement_id !== m.id) {
        throw new HttpError(
          409,
          "conflict",
          `${subjectId} has moved since batch ${batchId}; undo the later batch first`,
        );
      }

      if (m.type === "RECEIPT") {
        await recordMovement(trx, {
          type: "DISPOSE",
          unitId: m.unit_id!,
          toLocationId: disposed.id,
          batchId,
          reason: "undo",
          method: "manual",
          idempotencyKey: `undo:${m.id}`,
          compensatesMovementId: m.id,
        });
        await trx
          .updateTable("units")
          .set({ status: "disposed", status_reason: "undo" })
          .where("id", "=", m.unit_id!)
          .execute();
        await trx
          .updateTable("review_tasks")
          .set({ status: "resolved", resolution: JSON.stringify({ by: "undo" }), resolved_at: new Date() })
          .where("unit_id", "=", m.unit_id!)
          .where("status", "=", "open")
          .execute();
        disposedUnits.push(m.unit_id!);
      } else {
        await recordMovement(trx, {
          type: m.from_container_id ? "PACK" : "TRANSFER",
          unitId: m.unit_id ?? undefined,
          containerId: m.container_id ?? undefined,
          toLocationId: m.from_location_id ?? (m.from_container_id ? undefined : disposed.id),
          toContainerId: m.from_container_id ?? undefined,
          batchId,
          reason: "undo",
          method: "manual",
          idempotencyKey: `undo:${m.id}`,
          compensatesMovementId: m.id,
        });
      }
      reversed++;
    }

    const result: UndoResult = { batch_id: batchId, reversed_movements: reversed, disposed_units: disposedUnits, replayed: false };
    await trx
      .updateTable("batches")
      .set({ status: "undone", undone_at: new Date(), undo_receipt: JSON.stringify(result) })
      .where("id", "=", batchId)
      .execute();
    return result;
  });
}
