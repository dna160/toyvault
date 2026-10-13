import {
  type CatalogUpdateRequest,
  LOW_FIELD_CONFIDENCE,
  type ReviewItem,
  type ReviewList,
  type ReviewQuery,
  type ReviewSummary,
  type UnitReviewRequest,
  type UnitReviewResult,
} from "@toyvault/shared";
import { type RawBuilder, sql } from "kysely";
import type { z } from "zod";
import type { DB } from "./db.js";
import { badRequest, notFound } from "./errors.js";
import { recordMovement } from "./ledger.js";
import type { Storage } from "./storage.js";

// Review lists are views over the ledger. Nothing here decides anything: Claude (with the
// operator) decides in Claude Desktop, and these functions record the decision.

const FLAGGED = sql`u.status = 'active' AND u.needs_review`;
const UNVERIFIED = sql`NOT c.verified AND NOT c.operator_corrected
  AND EXISTS (SELECT 1 FROM units x WHERE x.catalog_item_id = c.id AND x.status = 'active')`;
// Products with two or more active copies and no QR label to tell them apart (labels arrive
// with labels_print). A to-do, not a problem: twins are interchangeable for counts.
const TWINS = sql`(SELECT count(*) FROM units x WHERE x.catalog_item_id = c.id AND x.status = 'active') >= 2
  AND NOT EXISTS (SELECT 1 FROM units x JOIN id_reservations r ON r.unit_id = x.id
                   WHERE x.catalog_item_id = c.id AND x.status = 'active')`;
const LOW_CONFIDENCE = sql`u.status = 'active' AND NOT u.needs_review AND u.reviewed_at IS NULL AND NOT c.operator_corrected
  AND EXISTS (SELECT 1 FROM jsonb_each_text(c.field_confidence) f
               WHERE f.value::numeric > 0 AND f.value::numeric < ${LOW_FIELD_CONFIDENCE})`;

export async function reviewSummary(db: DB): Promise<ReviewSummary> {
  const r = await sql<ReviewSummary>`
    SELECT
      (SELECT count(*) FROM units u WHERE ${FLAGGED})::int AS flagged,
      (SELECT count(*) FROM catalog_items c WHERE ${UNVERIFIED})::int AS unverified,
      (SELECT count(*) FROM units u JOIN catalog_items c ON c.id = u.catalog_item_id WHERE ${LOW_CONFIDENCE})::int AS low_confidence,
      (SELECT count(*) FROM catalog_items c WHERE ${TWINS})::int AS twins,
      (SELECT count(*) FROM review_tasks WHERE status = 'open' AND kind IN ('unmatched_move_photo','found_elsewhere'))::int AS ambiguous_moves,
      (SELECT count(*) FROM review_tasks WHERE status = 'open' AND kind = 'count_discrepancy')::int AS count_discrepancies
  `.execute(db);
  return r.rows[0]!;
}

interface Row {
  subject_id: string;
  review_id: string | null;
  unit_ids: string[];
  unit_count: number;
  catalog_item_id: string;
  category: string;
  brand: string;
  series: string;
  wave: string;
  item_name: string;
  model_number: string;
  scale: string;
  release_year: number | null;
  condition: string | null;
  field_confidence: Record<string, number>;
  location_paths: string[];
  thumb_key: string | null;
  reason: string | null;
  identity_confidence: string | null;
  created_at: Date;
  total: string;
}

const thumbOf = (unitRef: RawBuilder<unknown>) => sql`(
  SELECT p.thumb_key FROM unit_photos up JOIN photos p ON p.id = up.photo_id
   WHERE up.unit_id = ${unitRef} ORDER BY up.role = 'intake' DESC, up.created_at LIMIT 1)`;

export async function listReviews(db: DB, storage: Storage, q: z.output<typeof ReviewQuery>): Promise<ReviewList> {
  let query;
  if (q.kind === "unverified" || q.kind === "twins") {
    // One row per product: verifying it once covers every copy.
    query = sql<Row>`
      SELECT c.id AS subject_id, NULL AS review_id,
             (SELECT array_agg(id ORDER BY id) FROM (SELECT id FROM units WHERE catalog_item_id = c.id AND status = 'active' ORDER BY id LIMIT 8) s) AS unit_ids,
             (SELECT count(*) FROM units WHERE catalog_item_id = c.id AND status = 'active')::int AS unit_count,
             c.id AS catalog_item_id, c.category, c.brand, c.series, c.wave, c.item_name, c.model_number, c.scale, c.release_year,
             NULL AS condition, c.field_confidence,
             (SELECT array_agg(DISTINCT l.path) FROM units u JOIN unit_search s ON s.unit_id = u.id JOIN locations l ON l.id = s.location_id
               WHERE u.catalog_item_id = c.id AND u.status = 'active') AS location_paths,
             ${thumbOf(sql`(SELECT min(id) FROM units WHERE catalog_item_id = c.id AND status = 'active')`)} AS thumb_key,
             NULL AS reason, NULL AS identity_confidence, c.created_at,
             count(*) OVER () AS total
        FROM catalog_items c
       WHERE ${q.kind === "unverified" ? UNVERIFIED : TWINS}
       ORDER BY unit_count DESC, c.id
       LIMIT ${q.limit} OFFSET ${q.offset}
    `;
  } else {
    const where = q.kind === "flagged" ? FLAGGED : LOW_CONFIDENCE;
    query = sql<Row>`
      SELECT u.id AS subject_id,
             (SELECT r.id FROM review_tasks r WHERE r.unit_id = u.id AND r.status = 'open' ORDER BY r.created_at DESC LIMIT 1) AS review_id,
             ARRAY[u.id] AS unit_ids, 1 AS unit_count,
             c.id AS catalog_item_id, c.category, c.brand, c.series, c.wave, c.item_name, c.model_number, c.scale, c.release_year,
             u.condition, c.field_confidence,
             array_remove(ARRAY[l.path], NULL) AS location_paths,
             ${thumbOf(sql`u.id`)} AS thumb_key,
             u.review_reason AS reason, u.identity_confidence, u.created_at,
             count(*) OVER () AS total
        FROM units u
        JOIN catalog_items c ON c.id = u.catalog_item_id
        LEFT JOIN unit_search s ON s.unit_id = u.id
        LEFT JOIN locations l ON l.id = s.location_id
       WHERE ${where}
       ORDER BY u.created_at, u.id
       LIMIT ${q.limit} OFFSET ${q.offset}
    `;
  }

  const rows = (await query.execute(db)).rows;
  const photos = await photosFor(db, storage, rows, q.kind);
  const items: ReviewItem[] = await Promise.all(
    rows.map(async (r) => ({
      photos: photos.get(r.subject_id) ?? [],
      condition: r.condition,
      kind: q.kind,
      subject_id: r.subject_id,
      review_id: r.review_id,
      unit_ids: r.unit_ids ?? [],
      unit_count: r.unit_count,
      catalog_item_id: r.catalog_item_id,
      category: r.category,
      brand: r.brand,
      series: r.series,
      item_name: r.item_name,
      model_number: r.model_number,
      location_paths: r.location_paths ?? [],
      thumb_url: r.thumb_key ? await storage.presignGet(r.thumb_key) : null,
      reason: r.reason,
      identity_confidence: r.identity_confidence === null ? null : Number(r.identity_confidence),
      low_fields: lowFields(r),
      created_at: new Date(r.created_at).toISOString(),
    })),
  );
  return { kind: q.kind, total: Number(rows[0]?.total ?? 0), items };
}

/** A unit's own photos (up to 4), or for product queues the first photo of each copy. */
async function photosFor(db: DB, storage: Storage, rows: Row[], kind: string) {
  const perCopy = kind === "unverified" || kind === "twins";
  const pairs = rows.flatMap((r) => (r.unit_ids ?? []).slice(0, 4).map((u) => [r.subject_id, u] as const));
  const out = new Map<string, ReviewItem["photos"]>();
  if (pairs.length === 0) return out;
  const found = await sql<{ subject: string; unit_id: string; photo_id: string; thumb_key: string | null; preview_key: string | null; path: string | null; n: number }>`
    SELECT x.subject, up.unit_id, p.id AS photo_id, p.thumb_key, p.preview_key, l.path,
           row_number() OVER (PARTITION BY x.subject, up.unit_id ORDER BY up.role = 'intake' DESC, up.created_at, p.id)::int AS n
      FROM unnest(${pairs.map((p) => p[0])}::text[], ${pairs.map((p) => p[1])}::text[]) AS x(subject, unit_id)
      JOIN unit_photos up ON up.unit_id = x.unit_id
      JOIN photos p ON p.id = up.photo_id
      LEFT JOIN unit_search s ON s.unit_id = up.unit_id
      LEFT JOIN locations l ON l.id = s.location_id
  `.execute(db);
  for (const f of found.rows) {
    if (perCopy ? f.n > 1 : f.n > 4) continue;
    const list = out.get(f.subject) ?? [];
    list.push({
      unit_id: f.unit_id,
      photo_id: f.photo_id,
      thumb_url: f.thumb_key ? await storage.presignGet(f.thumb_key) : null,
      preview_url: f.preview_key ? await storage.presignGet(f.preview_key) : null,
      location_path: f.path ?? "",
    });
    out.set(f.subject, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.unit_id.localeCompare(b.unit_id) || a.photo_id.localeCompare(b.photo_id));
  return out;
}

function lowFields(r: Row) {
  const values: Record<string, string> = {
    category: r.category,
    brand: r.brand,
    series: r.series,
    wave: r.wave,
    item_name: r.item_name,
    model_number: r.model_number,
    scale: r.scale,
    release_year: r.release_year?.toString() ?? "",
    condition: r.condition ?? "",
  };
  return Object.entries(r.field_confidence ?? {})
    // 0 means "not read" (the field is simply absent), not "uncertain".
    .filter(([, c]) => Number(c) > 0 && Number(c) < LOW_FIELD_CONFIDENCE)
    .map(([field, c]) => ({ field, value: values[field] ?? "", confidence: Number(c) }))
    .sort((a, b) => a.confidence - b.confidence);
}

/**
 * Record the operator's review decision for one unit:
 * - confirm: the unit is right as listed;
 * - correct: relink it to another catalogue item and/or fix condition or notes;
 * - not_a_toy: dispose it (a DISPOSE movement to "Disposed", nothing deleted).
 * Any open review tasks for the unit are resolved. Repeating a decision is harmless.
 */
export async function reviewUnit(db: DB, unitId: string, req: z.output<typeof UnitReviewRequest>): Promise<UnitReviewResult> {
  return db.transaction().execute(async (trx) => {
    const unit = await trx
      .selectFrom("units")
      .select(["id", "status", "catalog_item_id", "condition", "notes", "needs_review"])
      .where("id", "=", unitId)
      .forUpdate()
      .executeTakeFirst();
    if (!unit) throw notFound(`unknown unit ${unitId}`);
    if (unit.status !== "active" && req.action !== "not_a_toy") {
      throw badRequest(`${unitId} is ${unit.status}; only active units can be reviewed`);
    }

    if (req.action === "correct") {
      if (req.catalog_item_id) {
        const exists = await trx.selectFrom("catalog_items").select("id").where("id", "=", req.catalog_item_id).executeTakeFirst();
        if (!exists) throw badRequest(`unknown catalogue item ${req.catalog_item_id}`, [{ path: "catalog_item_id", message: "not found" }]);
      }
      const after = {
        catalog_item_id: req.catalog_item_id ?? unit.catalog_item_id,
        condition: req.condition ?? unit.condition,
        notes: req.notes ?? unit.notes,
      };
      await trx
        .insertInto("edits")
        .values({
          subject_type: "unit",
          subject_id: unitId,
          before: JSON.stringify({ catalog_item_id: unit.catalog_item_id, condition: unit.condition, notes: unit.notes }),
          after: JSON.stringify(after),
          reason: req.reason ?? "review",
        })
        .execute();
      await trx.updateTable("units").set(after).where("id", "=", unitId).execute();
    }

    if (req.action === "not_a_toy" && unit.status === "active") {
      const disposed = await trx.selectFrom("locations").select("id").where("path", "=", "Disposed").executeTakeFirstOrThrow();
      await recordMovement(trx, {
        type: "DISPOSE",
        unitId,
        toLocationId: disposed.id,
        reason: req.reason!,
        method: "manual",
        idempotencyKey: `review:dispose:${unitId}`,
      });
      await trx.updateTable("units").set({ status: "disposed", status_reason: req.reason! }).where("id", "=", unitId).execute();
    }

    await trx.updateTable("units").set({ needs_review: false, reviewed_at: new Date() }).where("id", "=", unitId).execute();
    const resolved = await trx
      .updateTable("review_tasks")
      .set({ status: "resolved", resolved_at: new Date(), resolution: JSON.stringify(req) })
      .where("unit_id", "=", unitId)
      .where("status", "=", "open")
      .returning("id")
      .execute();
    await sql`SELECT refresh_unit_search(ARRAY[${unitId}]::text[])`.execute(trx);

    const final = await trx.selectFrom("units").select(["status", "catalog_item_id"]).where("id", "=", unitId).executeTakeFirstOrThrow();
    return {
      unit_id: unitId,
      action: req.action,
      status: final.status,
      catalog_item_id: final.catalog_item_id,
      resolved_reviews: resolved.map((r) => r.id),
    };
  });
}

/**
 * Correct or verify a catalogue item. Setting source_url marks it verified. A correction
 * the operator stated (by_operator) is protected: later updates without by_operator are
 * refused for that item. Every change is recorded in the edits log.
 */
export async function updateCatalog(db: DB, id: string, req: z.output<typeof CatalogUpdateRequest>) {
  return db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom("catalog_items").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
    if (!current) throw notFound(`unknown catalogue item ${id}`);
    if (current.operator_corrected && !req.by_operator) {
      throw badRequest(`${id} was corrected by the operator; only the operator can change it again`);
    }

    const { by_operator, reason, field_confidence, ...fields } = req;
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && (current as Record<string, unknown>)[k] !== v) changes[k] = v;
    }
    if (fields.source_url) changes.verified = true;
    if (by_operator) changes.operator_corrected = true;
    if (field_confidence) changes.field_confidence = JSON.stringify({ ...(current.field_confidence as object), ...field_confidence });

    if (Object.keys(changes).length > 0) {
      const before = Object.fromEntries(Object.keys(changes).map((k) => [k, (current as Record<string, unknown>)[k]]));
      await trx
        .insertInto("edits")
        .values({
          subject_type: "catalog_item",
          subject_id: id,
          before: JSON.stringify(before),
          after: JSON.stringify(changes),
          reason: reason ?? (by_operator ? "operator correction" : "web check"),
        })
        .execute();
      await trx.updateTable("catalog_items").set(changes).where("id", "=", id).execute();
      await sql`SELECT refresh_unit_search(coalesce(array_agg(id), '{}')) FROM units WHERE catalog_item_id = ${id}`.execute(trx);
    }
    const after = await trx.selectFrom("catalog_items").select(["id", "verified", "operator_corrected"]).where("id", "=", id).executeTakeFirstOrThrow();
    return { ...after, changed: Object.keys(changes) };
  });
}
