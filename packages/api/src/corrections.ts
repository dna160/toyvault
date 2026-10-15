import type { LocationCorrectRequest, LocationCorrectResult } from "@toyvault/shared";
import { sql } from "kysely";
import type { z } from "zod";
import type { DB } from "./db.js";
import { badRequest } from "./errors.js";
import { recordMovement } from "./ledger.js";

/**
 * Units were recorded at the wrong location (not physically moved). Each gets an ADJUST
 * movement with the reason, in one atomic "correction" batch that can be undone.
 * Idempotent on client_key: a replay returns the original result.
 */
export async function correctLocation(db: DB, req: z.output<typeof LocationCorrectRequest>): Promise<LocationCorrectResult> {
  if (req.from_location_id === req.to_location_id) throw badRequest("from and to are the same location");

  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${req.client_key}))`.execute(trx);
    const prior = await trx.selectFrom("batches").select("receipt").where("client_key", "=", req.client_key).executeTakeFirst();
    if (prior?.receipt) return { ...(prior.receipt as LocationCorrectResult), replayed: true };

    const [from, to] = await Promise.all(
      [req.from_location_id, req.to_location_id].map((id) =>
        trx.selectFrom("locations").select(["id", "path", "kind"]).where("id", "=", id).executeTakeFirst(),
      ),
    );
    if (!from) throw badRequest(`unknown location ${req.from_location_id}`, [{ path: "from_location_id", message: "not found" }]);
    if (!to) throw badRequest(`unknown location ${req.to_location_id}`, [{ path: "to_location_id", message: "not found" }]);
    if (to.kind === "virtual") throw badRequest(`use a real location, not "${to.path}"`, [{ path: "to_location_id", message: "virtual" }]);

    // Units recorded directly at the wrong location (units inside a carton move with the carton).
    const here = await trx
      .selectFrom("stock_position as sp")
      .innerJoin("units as u", "u.id", "sp.subject_id")
      .select("u.id")
      .where("sp.subject_type", "=", "unit")
      .where("sp.location_id", "=", from.id)
      .where("u.status", "=", "active")
      .orderBy("u.id")
      .execute();
    const atFrom = new Set(here.map((r) => r.id));
    const wanted = req.unit_ids ?? [...atFrom];
    const skipped = wanted.filter((id) => !atFrom.has(id)).map((unit_id) => ({ unit_id, reason: `not recorded at ${from.path}` }));
    const units = wanted.filter((id) => atFrom.has(id));
    if (units.length === 0) throw badRequest(`no active units are recorded at ${from.path}`);

    const batch = await trx
      .insertInto("batches")
      .values({
        mode: "correction",
        instruction: req.instruction,
        from_location_id: from.id,
        to_location_id: to.id,
        counts: JSON.stringify({ corrected: units.length, skipped: skipped.length }),
        client_key: req.client_key,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    for (const unitId of units) {
      await recordMovement(trx, {
        type: "ADJUST",
        unitId,
        toLocationId: to.id,
        batchId: batch.id,
        method: "manual",
        reason: req.reason,
        idempotencyKey: `correct:${req.client_key}:${unitId}`,
      });
    }

    const result: LocationCorrectResult = {
      batch_id: batch.id,
      from_path: from.path,
      to_path: to.path,
      corrected: units,
      skipped,
      replayed: false,
    };
    await trx.updateTable("batches").set({ receipt: JSON.stringify(result) }).where("id", "=", batch.id).execute();
    return result;
  });
}
