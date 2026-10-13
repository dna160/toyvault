import type { UnitDetail } from "@toyvault/shared";
import type { DB } from "./db.js";
import { notFound } from "./errors.js";
import type { Storage } from "./storage.js";

export async function getUnitDetail(db: DB, storage: Storage, id: string): Promise<UnitDetail> {
  const unit = await db
    .selectFrom("units")
    .innerJoin("catalog_items as c", "c.id", "units.catalog_item_id")
    .leftJoin("unit_current_location as ucl", "ucl.unit_id", "units.id")
    .leftJoin("locations as l", "l.id", "ucl.location_id")
    .select([
      "units.id",
      "units.status",
      "units.identity",
      "units.condition",
      "units.needs_review",
      "units.review_reason",
      "c.id as catalog_id",
      "c.category",
      "c.brand",
      "c.franchise",
      "c.series",
      "c.wave",
      "c.item_name",
      "c.model_number",
      "c.verified",
      "c.source_url",
      "l.id as location_id",
      "l.path as location_path",
    ])
    .where("units.id", "=", id)
    .executeTakeFirst();
  if (!unit) throw notFound(`unknown unit ${id}`);

  const photos = await db
    .selectFrom("unit_photos")
    .innerJoin("photos", "photos.id", "unit_photos.photo_id")
    .select(["photos.id", "unit_photos.role", "photos.thumb_key"])
    .where("unit_photos.unit_id", "=", id)
    .orderBy("unit_photos.created_at")
    .execute();

  const movements = await db
    .selectFrom("movements as m")
    .leftJoin("locations as f", "f.id", "m.from_location_id")
    .leftJoin("locations as t", "t.id", "m.to_location_id")
    .select(["m.id", "m.type", "f.path as from_path", "t.path as to_path", "m.created_at"])
    .where("m.unit_id", "=", id)
    .orderBy("m.created_at")
    .orderBy("m.id")
    .execute();

  return {
    id: unit.id,
    status: unit.status,
    identity: unit.identity,
    condition: unit.condition,
    needs_review: unit.needs_review,
    review_reason: unit.review_reason,
    catalog: {
      id: unit.catalog_id,
      category: unit.category,
      brand: unit.brand,
      franchise: unit.franchise,
      series: unit.series,
      wave: unit.wave,
      item_name: unit.item_name,
      model_number: unit.model_number,
      verified: unit.verified,
      source_url: unit.source_url,
    },
    location: { id: unit.location_id ?? "", path: unit.location_path ?? "" },
    photos: await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        role: p.role,
        thumb_url: p.thumb_key ? await storage.presignGet(p.thumb_key) : null,
      })),
    ),
    movements: movements.map((m) => ({
      id: m.id,
      type: m.type,
      from_path: m.from_path,
      to_path: m.to_path,
      created_at: new Date(m.created_at).toISOString(),
    })),
  };
}
