import { type Extraction, type IntakeReceipt, ID_PATTERNS, IntakeBatchRequest } from "@toyvault/shared";
import { sql } from "kysely";
import type { z } from "zod";
import type { DB } from "./db.js";
import { badRequest } from "./errors.js";
import { recordMovement } from "./ledger.js";
import type { Storage } from "./storage.js";

type Request = z.output<typeof IntakeBatchRequest>;

/**
 * Commit one intake batch: every extraction becomes a unit with a RECEIPT movement,
 * atomically. Replaying the same client_key returns the original receipt.
 *
 * The server never decides anything: it only skips photos that are already linked to an
 * active unit (the idempotency rule) and records what Claude sent.
 */
export async function commitIntakeBatch(db: DB, storage: Storage, req: Request): Promise<IntakeReceipt> {
  const replay = await findReceipt(db, req.client_key);
  if (replay) return replay;

  const photoIds = unique([...req.extractions.flatMap((e) => e.photo_ids), ...req.skipped_photo_ids]);
  if (photoIds.length === 0) throw badRequest("the batch has no photos");
  await assertPhotosUploaded(db, storage, photoIds);

  return db.transaction().execute(async (trx) => {
    // Serialize concurrent retries of the same batch.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${req.client_key}))`.execute(trx);
    const again = await findReceipt(trx, req.client_key);
    if (again) return again;

    const location = await trx
      .selectFrom("locations")
      .select(["id", "path"])
      .where("id", "=", req.location_id)
      .executeTakeFirst();
    if (!location) throw badRequest(`unknown location ${req.location_id}`, [{ path: "location_id", message: "not found" }]);

    // Photos already on an active unit before this batch are never listed again.
    const alreadyLinked = await trx
      .selectFrom("unit_photos")
      .innerJoin("units", "units.id", "unit_photos.unit_id")
      .select(["unit_photos.photo_id", "unit_photos.unit_id"])
      .where("unit_photos.photo_id", "in", photoIds)
      .where("unit_photos.role", "=", "intake")
      .where("units.status", "=", "active")
      .execute();
    const linkedTo = new Map(alreadyLinked.map((r) => [r.photo_id, r.unit_id]));

    const batch = await trx
      .insertInto("batches")
      .values({
        mode: "intake",
        folder: req.folder,
        instruction: req.instruction,
        to_location_id: location.id,
        counts: JSON.stringify({}),
        client_key: req.client_key,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const receipt: IntakeReceipt = {
      batch_id: batch.id,
      location_id: location.id,
      location_path: location.path,
      listed: [],
      flagged_count: 0,
      skipped: [],
      replayed: false,
    };

    for (const [index, extraction] of req.extractions.entries()) {
      const linked = extraction.photo_ids.map((p) => linkedTo.get(p)).find(Boolean);
      if (linked) {
        receipt.skipped.push({ photo_ids: extraction.photo_ids, reason: "already_listed", unit_id: linked });
        continue;
      }

      const qrUnit = await qrUnitId(trx, extraction.qr);
      if (qrUnit?.active) {
        receipt.skipped.push({ photo_ids: extraction.photo_ids, reason: "already_listed", unit_id: qrUnit.id });
        continue;
      }

      const catalogItemId = extraction.catalog_item_id ?? (await createCatalogItem(trx, extraction));
      if (extraction.catalog_item_id) {
        const exists = await trx
          .selectFrom("catalog_items")
          .select("id")
          .where("id", "=", extraction.catalog_item_id)
          .executeTakeFirst();
        if (!exists) {
          throw badRequest(`unknown catalogue item ${extraction.catalog_item_id}`, [
            { path: `extractions.${index}.catalog_item_id`, message: "not found; use an ID from catalog_find or null" },
          ]);
        }
      }

      const unit = await trx
        .insertInto("units")
        .values({
          ...(qrUnit?.reserved ? { id: qrUnit.id } : {}),
          catalog_item_id: catalogItemId,
          condition: extraction.condition,
          notes: extraction.notes,
          needs_review: extraction.needs_review,
          review_reason: extraction.review_reason,
          identity_confidence: extraction.identity_confidence,
          created_batch_id: batch.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (qrUnit?.reserved) {
        await trx.updateTable("id_reservations").set({ used_at: new Date() }).where("unit_id", "=", unit.id).execute();
      }

      await trx
        .insertInto("unit_photos")
        .values(
          extraction.photo_ids.map((photoId) => ({
            unit_id: unit.id,
            photo_id: photoId,
            role: "intake" as const,
            extraction: JSON.stringify(extraction),
            batch_id: batch.id,
          })),
        )
        .execute();

      if (extraction.ocr_text.length > 0) {
        await trx
          .updateTable("photos")
          .set({
            ocr_text: sql`(SELECT array_agg(DISTINCT t) FROM unnest(ocr_text || ${extraction.ocr_text}::text[]) AS t)`,
          })
          .where("id", "in", extraction.photo_ids)
          .execute();
      }

      await recordMovement(trx, {
        type: "RECEIPT",
        unitId: unit.id,
        toLocationId: location.id,
        batchId: batch.id,
        evidencePhotoId: extraction.photo_ids[0],
        confidence: extraction.identity_confidence,
        method: qrUnit?.reserved ? "qr" : "visual",
        idempotencyKey: `intake:${req.client_key}:${index}`,
      });

      if (extraction.needs_review) {
        await trx
          .insertInto("review_tasks")
          .values({
            kind: "uncertain_identity",
            unit_id: unit.id,
            photo_id: extraction.photo_ids[0] ?? null,
            batch_id: batch.id,
            candidates: JSON.stringify([]),
            reason: extraction.review_reason,
          })
          .execute();
        receipt.flagged_count++;
      }

      receipt.listed.push({
        unit_id: unit.id,
        catalog_item_id: catalogItemId,
        photo_ids: extraction.photo_ids,
        item_name: extraction.item_name,
        flagged: extraction.needs_review,
      });
    }

    const covered = new Set(req.extractions.flatMap((e) => e.photo_ids));
    const sameShot = req.skipped_photo_ids.filter((p) => !covered.has(p));
    if (sameShot.length > 0) receipt.skipped.push({ photo_ids: sameShot, reason: "same_shot", unit_id: null });

    await trx
      .updateTable("batches")
      .set({
        counts: JSON.stringify({
          photos: photoIds.length,
          listed: receipt.listed.length,
          flagged: receipt.flagged_count,
          skipped: receipt.skipped.reduce((n, s) => n + s.photo_ids.length, 0),
        }),
        receipt: JSON.stringify(receipt),
      })
      .where("id", "=", batch.id)
      .execute();

    return receipt;
  });
}

async function findReceipt(db: Pick<DB, "selectFrom">, clientKey: string): Promise<IntakeReceipt | null> {
  const row = await db.selectFrom("batches").select("receipt").where("client_key", "=", clientKey).executeTakeFirst();
  if (!row?.receipt) return null;
  return { ...(row.receipt as IntakeReceipt), replayed: true };
}

async function assertPhotosUploaded(db: DB, storage: Storage, photoIds: string[]) {
  const rows = await db
    .selectFrom("photos")
    .select(["id", "upload_status", "original_key", "preview_key", "thumb_key"])
    .where("id", "in", photoIds)
    .execute();
  const found = new Map(rows.map((r) => [r.id, r]));
  const missing = photoIds.filter((p) => !found.has(p));
  if (missing.length > 0) {
    throw badRequest(
      "unknown photo IDs",
      missing.map((p) => ({ path: "photo_ids", message: `${p} was not registered; use IDs from inbox_next_batch` })),
    );
  }

  const pending = rows.filter((r) => r.upload_status !== "uploaded");
  const notUploaded: string[] = [];
  await Promise.all(
    pending.map(async (r) => {
      const keys = [r.original_key, r.preview_key, r.thumb_key];
      const ok = keys.every(Boolean) && (await Promise.all(keys.map((k) => storage.exists(k!)))).every(Boolean);
      if (!ok) notUploaded.push(r.id);
    }),
  );
  if (notUploaded.length > 0) {
    throw badRequest(
      "photos are not uploaded yet",
      notUploaded.map((p) => ({ path: "photo_ids", message: `${p} has no uploaded files` })),
    );
  }
  if (pending.length > 0) {
    await db
      .updateTable("photos")
      .set({ upload_status: "uploaded" })
      .where(
        "id",
        "in",
        pending.map((r) => r.id),
      )
      .execute();
  }
}

/** A decoded QR that is a ToyVault unit ID: either an existing unit or a reserved label. */
async function qrUnitId(db: Pick<DB, "selectFrom">, qr: string | null) {
  const value = qr?.trim();
  if (!value || !ID_PATTERNS.unit.test(value)) return null;
  const unit = await db.selectFrom("units").select(["id", "status"]).where("id", "=", value).executeTakeFirst();
  if (unit) return { id: unit.id, active: unit.status === "active", reserved: false };
  const reservation = await db
    .selectFrom("id_reservations")
    .select(["unit_id", "used_at"])
    .where("unit_id", "=", value)
    .executeTakeFirst();
  if (reservation && !reservation.used_at) return { id: value, active: false, reserved: true };
  return null;
}

async function createCatalogItem(db: Pick<DB, "insertInto">, e: Extraction): Promise<string> {
  const row = await db
    .insertInto("catalog_items")
    .values({
      category: e.category,
      brand: e.brand,
      franchise: e.franchise,
      series: e.series,
      wave: e.wave,
      item_name: e.item_name,
      model_number: e.model_number,
      barcode: e.barcode ?? "",
      scale: e.scale,
      release_year: e.release_year,
      release_year_source: e.release_year_source,
      source_url: e.web_source_url,
      verified: e.web_source_url !== null,
      field_confidence: JSON.stringify(e.field_confidence),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
