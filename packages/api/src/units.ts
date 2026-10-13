import type { UnitDetail } from "@toyvault/shared";
import type { DB } from "./db.js";
import { notFound } from "./errors.js";
import type { Storage } from "./storage.js";

const sign = (storage: Storage, key: string | null) => (key ? storage.presignGet(key) : Promise.resolve(null));
const num = (v: string | number | null) => (v === null ? null : Number(v));

export async function getUnitDetail(db: DB, storage: Storage, id: string): Promise<UnitDetail> {
  const unit = await db
    .selectFrom("units as u")
    .innerJoin("catalog_items as c", "c.id", "u.catalog_item_id")
    .leftJoin("unit_current_location as ucl", "ucl.unit_id", "u.id")
    .leftJoin("locations as l", "l.id", "ucl.location_id")
    .leftJoin("stock_position as sp", (j) => j.onRef("sp.subject_id", "=", "u.id").on("sp.subject_type", "=", "unit"))
    .select([
      "u.id",
      "u.status",
      "u.status_reason",
      "u.identity",
      "u.condition",
      "u.notes",
      "u.needs_review",
      "u.review_reason",
      "u.identity_confidence",
      "u.created_at",
      "u.created_batch_id",
      "c.id as catalog_id",
      "c.category",
      "c.brand",
      "c.franchise",
      "c.series",
      "c.wave",
      "c.item_name",
      "c.model_number",
      "c.barcode",
      "c.scale",
      "c.release_year",
      "c.release_year_source",
      "c.verified",
      "c.source_url",
      "c.field_confidence",
      "l.id as location_id",
      "l.path as location_path",
      "sp.container_id",
    ])
    .where("u.id", "=", id)
    .executeTakeFirst();
  if (!unit) throw notFound(`unknown unit ${id}`);

  const [photos, movements, copies] = await Promise.all([
    db
      .selectFrom("unit_photos as up")
      .innerJoin("photos as p", "p.id", "up.photo_id")
      .select(["p.id", "up.role", "p.captured_at", "p.thumb_key", "p.preview_key", "p.ocr_text"])
      .where("up.unit_id", "=", id)
      .orderBy("up.created_at")
      .orderBy("p.id")
      .execute(),
    db
      .selectFrom("movements as m")
      .leftJoin("locations as f", "f.id", "m.from_location_id")
      .leftJoin("locations as t", "t.id", "m.to_location_id")
      .select([
        "m.id",
        "m.type",
        "f.path as from_path",
        "t.path as to_path",
        "m.to_container_id",
        "m.batch_id",
        "m.method",
        "m.confidence",
        "m.reason",
        "m.created_at",
      ])
      .where("m.unit_id", "=", id)
      .orderBy("m.created_at", "desc")
      .orderBy("m.id", "desc")
      .execute(),
    db
      .selectFrom("units as o")
      .leftJoin("unit_current_location as ucl", "ucl.unit_id", "o.id")
      .leftJoin("locations as l", "l.id", "ucl.location_id")
      .select([
        "o.id",
        "o.condition",
        "l.path as location_path",
        (eb) =>
          eb
            .selectFrom("unit_photos as up")
            .innerJoin("photos as p", "p.id", "up.photo_id")
            .select("p.thumb_key")
            .whereRef("up.unit_id", "=", "o.id")
            .orderBy("up.created_at")
            .limit(1)
            .as("thumb_key"),
      ])
      .where("o.catalog_item_id", "=", unit.catalog_id)
      .where("o.id", "!=", id)
      .where("o.status", "=", "active")
      .orderBy("o.id")
      .limit(24)
      .execute(),
  ]);

  return {
    id: unit.id,
    status: unit.status,
    status_reason: unit.status_reason,
    identity: unit.identity,
    condition: unit.condition,
    notes: unit.notes,
    needs_review: unit.needs_review,
    review_reason: unit.review_reason,
    identity_confidence: num(unit.identity_confidence),
    created_at: new Date(unit.created_at).toISOString(),
    created_batch_id: unit.created_batch_id,
    catalog: {
      id: unit.catalog_id,
      category: unit.category,
      brand: unit.brand,
      franchise: unit.franchise,
      series: unit.series,
      wave: unit.wave,
      item_name: unit.item_name,
      model_number: unit.model_number,
      barcode: unit.barcode,
      scale: unit.scale,
      release_year: unit.release_year,
      release_year_source: unit.release_year_source,
      verified: unit.verified,
      source_url: unit.source_url,
      field_confidence: (unit.field_confidence ?? {}) as Record<string, number>,
    },
    location: { id: unit.location_id ?? "", path: unit.location_path ?? "" },
    container_id: unit.container_id ?? null,
    photos: await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        role: p.role,
        captured_at: p.captured_at ? new Date(p.captured_at).toISOString() : null,
        thumb_url: await sign(storage, p.thumb_key),
        preview_url: await sign(storage, p.preview_key),
        ocr_text: p.ocr_text,
      })),
    ),
    movements: movements.map((m) => ({
      id: m.id,
      type: m.type,
      from_path: m.from_path,
      to_path: m.to_path,
      to_container_id: m.to_container_id,
      batch_id: m.batch_id,
      method: m.method,
      confidence: num(m.confidence),
      reason: m.reason,
      created_at: new Date(m.created_at).toISOString(),
    })),
    other_copies: await Promise.all(
      copies.map(async (c) => ({
        id: c.id,
        condition: c.condition,
        location_path: c.location_path ?? "",
        thumb_url: await sign(storage, c.thumb_key ?? null),
      })),
    ),
  };
}
