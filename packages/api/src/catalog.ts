import type { CatalogFindQuery, CatalogItem, CatalogSaveRequest } from "@toyvault/shared";
import { sql } from "kysely";
import type { z } from "zod";
import type { DB } from "./db.js";
import { badRequest } from "./errors.js";

type FindQuery = z.output<typeof CatalogFindQuery>;
type SaveRequest = z.output<typeof CatalogSaveRequest>;

/**
 * Catalogue lookup for catalog_find: exact model number or barcode first, then text.
 * Plain lookups; Claude decides whether any result is the toy in the photo.
 */
export async function findCatalog(db: DB, q: FindQuery): Promise<{ items: CatalogItem[] }> {
  const model = normaliseCode(q.model);
  const barcode = q.barcode?.replace(/\D/g, "") || null;
  const text = q.q?.trim() || null;
  if (!model && !barcode && !text) throw badRequest("give at least one of model, barcode or q");

  const tokens = (text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => `${t}:*`)
    .join(" & ");

  const rows = await sql<CatalogRow>`
    SELECT c.*, (SELECT count(*) FROM units u WHERE u.catalog_item_id = c.id AND u.status = 'active')::int AS unit_count,
           (${model}::text IS NOT NULL AND regexp_replace(lower(c.model_number), '[^a-z0-9]', '', 'g') = ${model}) AS model_hit,
           (${barcode}::text IS NOT NULL AND c.barcode = ${barcode}) AS barcode_hit,
           (${tokens} <> '' AND c.search_vector @@ to_tsquery('simple', nullif(${tokens}, ''))) AS text_hit,
           CASE WHEN ${text}::text IS NULL THEN 0
                ELSE word_similarity(lower(${text ?? ""}), lower(c.item_name || ' ' || c.series || ' ' || c.brand || ' ' || c.model_number))
           END AS sim
      FROM catalog_items c
     WHERE (${model}::text IS NOT NULL AND regexp_replace(lower(c.model_number), '[^a-z0-9]', '', 'g') = ${model})
        OR (${barcode}::text IS NOT NULL AND c.barcode = ${barcode})
        OR (${tokens} <> '' AND c.search_vector @@ to_tsquery('simple', nullif(${tokens}, '')))
        OR (${text}::text IS NOT NULL AND word_similarity(lower(${text ?? ""}), lower(c.item_name || ' ' || c.series || ' ' || c.brand || ' ' || c.model_number)) > 0.5)
     ORDER BY model_hit DESC, barcode_hit DESC, text_hit DESC, sim DESC, unit_count DESC, c.id
     LIMIT ${q.limit}
  `.execute(db);

  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      category: r.category,
      brand: r.brand,
      franchise: r.franchise,
      series: r.series,
      wave: r.wave,
      item_name: r.item_name,
      model_number: r.model_number,
      barcode: r.barcode,
      scale: r.scale,
      release_year: r.release_year,
      verified: r.verified,
      source_url: r.source_url,
      unit_count: r.unit_count,
      matched_by: [
        ...(r.model_hit ? (["model"] as const) : []),
        ...(r.barcode_hit ? (["barcode"] as const) : []),
        ...(r.text_hit || r.sim > 0.5 ? (["text"] as const) : []),
      ],
    })),
  };
}

/** catalog_save: create a catalogue item Claude identified. Idempotent on client_key. */
export async function saveCatalog(db: DB, body: SaveRequest): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insertInto("catalog_items")
    .values({
      category: body.category,
      brand: body.brand,
      franchise: body.franchise,
      series: body.series,
      wave: body.wave,
      item_name: body.item_name,
      model_number: body.model_number,
      barcode: body.barcode.replace(/\D/g, ""),
      scale: body.scale,
      release_year: body.release_year,
      release_year_source: body.release_year_source,
      source_url: body.source_url,
      verified: body.source_url !== null,
      field_confidence: JSON.stringify(body.field_confidence),
      client_key: body.client_key,
    })
    .onConflict((oc) => oc.column("client_key").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return { id: inserted.id, created: true };
  const existing = await db
    .selectFrom("catalog_items")
    .select("id")
    .where("client_key", "=", body.client_key)
    .executeTakeFirstOrThrow();
  return { id: existing.id, created: false };
}

function normaliseCode(v: string | undefined): string | null {
  const n = v?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n || null;
}

interface CatalogRow {
  id: string;
  category: string;
  brand: string;
  franchise: string;
  series: string;
  wave: string;
  item_name: string;
  model_number: string;
  barcode: string;
  scale: string;
  release_year: number | null;
  verified: boolean;
  source_url: string | null;
  unit_count: number;
  model_hit: boolean;
  barcode_hit: boolean;
  text_hit: boolean;
  sim: number;
}
