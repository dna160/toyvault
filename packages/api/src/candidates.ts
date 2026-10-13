import { type Candidate, type CandidatesResponse, CandidatesQuery, IMAGE_DEFAULTS, ID_PATTERNS } from "@toyvault/shared";
import { sql } from "kysely";
import type { z } from "zod";
import { type DB, phashToBits } from "./db.js";
import { notFound } from "./errors.js";
import type { Storage } from "./storage.js";

type Query = z.output<typeof CandidatesQuery>;

interface Row {
  unit_id: string;
  catalog_item_id: string;
  item_name: string;
  brand: string;
  series: string;
  model_number: string;
  condition: string;
  identity: "distinct" | "fungible";
  location_id: string;
  location_path: string;
  thumb_key: string | null;
  phash_distance: number | null;
  catalog_hit: boolean;
  qr_hit: boolean;
}

/**
 * Shortlist inputs for move matching (plain lookups, no judgement):
 * - at_source: active units at the stated location (including inside cartons there),
 *   ordered by QR, catalogue/model hit, then image-hash distance.
 * - elsewhere: active units at other locations that share the catalogue item, model number,
 *   QR, or a close image hash. Claude may only raise these as review questions.
 */
export async function findCandidates(db: DB, storage: Storage, q: Query): Promise<CandidatesResponse> {
  const loc = await db.selectFrom("locations").select("id").where("id", "=", q.location).executeTakeFirst();
  if (!loc) throw notFound(`unknown location ${q.location}`);

  const catalogIds = (q.catalog ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ID_PATTERNS.catalog.test(s));
  const model = q.model?.trim().toLowerCase() || null;
  const qr = q.qr?.trim() || null;
  const bits = q.phash ? phashToBits(q.phash) : null;

  const base = (atSource: boolean) => sql<Row>`
    WITH RECURSIVE sub AS (
      SELECT id FROM locations WHERE id = ${q.location}
      UNION SELECT l.id FROM locations l JOIN sub ON l.parent_id = sub.id
    ),
    thumbs AS (
      SELECT DISTINCT ON (up.unit_id) up.unit_id, p.thumb_key, p.phash
        FROM unit_photos up JOIN photos p ON p.id = up.photo_id
       WHERE up.role = 'intake'
       ORDER BY up.unit_id, up.created_at
    ),
    scored AS (
      SELECT u.id AS unit_id, c.id AS catalog_item_id, c.item_name, c.brand, c.series, c.model_number,
             u.condition, u.identity, l.id AS location_id, l.path AS location_path, t.thumb_key,
             CASE WHEN ${bits}::text IS NULL OR t.phash IS NULL THEN NULL
                  ELSE bit_count(t.phash # ${bits}::bit(64))::int END AS phash_distance,
             (c.id = ANY(${catalogIds}::text[]) OR (${model}::text IS NOT NULL AND lower(c.model_number) = ${model})) AS catalog_hit,
             (u.id = ${qr}) AS qr_hit,
             (ucl.location_id IN (SELECT id FROM sub)) AS at_source
        FROM units u
        JOIN catalog_items c ON c.id = u.catalog_item_id
        JOIN unit_current_location ucl ON ucl.unit_id = u.id
        JOIN locations l ON l.id = ucl.location_id
        LEFT JOIN thumbs t ON t.unit_id = u.id
       WHERE u.status = 'active'
    )
    SELECT * FROM scored
     WHERE at_source = ${atSource}
       AND (${atSource} OR qr_hit OR catalog_hit OR phash_distance <= ${IMAGE_DEFAULTS.similarMaxDistance})
     ORDER BY qr_hit DESC, catalog_hit DESC, phash_distance ASC NULLS LAST, unit_id
     LIMIT ${q.limit}
  `;

  const [source, elsewhere] = await Promise.all([base(true).execute(db), base(false).execute(db)]);
  return {
    at_source: await Promise.all(source.rows.map((r) => toCandidate(storage, r, "location"))),
    elsewhere: await Promise.all(elsewhere.rows.slice(0, 8).map((r) => toCandidate(storage, r, null))),
  };
}

async function toCandidate(storage: Storage, r: Row, base: "location" | null): Promise<Candidate> {
  const matched: Candidate["matched_by"] = [];
  if (r.qr_hit) matched.push("qr");
  if (r.catalog_hit) matched.push("catalog");
  if (r.phash_distance !== null && r.phash_distance <= IMAGE_DEFAULTS.similarMaxDistance) matched.push("phash");
  if (base) matched.push(base);
  return {
    unit_id: r.unit_id,
    catalog_item_id: r.catalog_item_id,
    item_name: r.item_name,
    brand: r.brand,
    series: r.series,
    model_number: r.model_number,
    condition: r.condition,
    identity: r.identity,
    location_id: r.location_id,
    location_path: r.location_path,
    thumb_url: r.thumb_key ? await storage.presignGet(r.thumb_key) : null,
    phash_distance: r.phash_distance,
    matched_by: matched,
  };
}
