import type { SearchHit, SearchQuery, SearchResponse } from "@toyvault/shared";
import { type RawBuilder, sql } from "kysely";
import type { z } from "zod";
import type { DB } from "./db.js";
import type { Storage } from "./storage.js";

type Query = z.output<typeof SearchQuery>;

/** Lower-case alphanumeric tokens; each becomes a prefix term ("rac" matches "racers"). */
export function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * Full-text search over the unit search document (name, series, brand, franchise, model
 * number, OCR text, notes, location path) with prefix matching and series/wave short
 * forms ("turbo rac s3"). If the text matches nothing, misspelled words are corrected
 * against the indexed vocabulary and the search runs once more.
 */
export async function searchUnits(db: DB, storage: Storage, q: Query): Promise<SearchResponse> {
  const started = performance.now();
  let tokens = tokenize(q.q);
  let result = await runSearch(db, q, tokens);

  if (tokens.length > 0 && result.matched === 0) {
    const corrected = await correctTokens(db, tokens);
    if (corrected.join(" ") !== tokens.join(" ")) {
      tokens = corrected;
      result = await runSearch(db, q, tokens);
    }
  }

  const hits: SearchHit[] = await Promise.all(
    result.hits.map(async (r) => ({
      unit_id: r.id,
      catalog_item_id: r.catalog_item_id,
      category: r.category,
      brand: r.brand,
      series: r.series,
      wave: r.wave,
      item_name: r.item_name,
      model_number: r.model_number,
      condition: r.condition,
      needs_review: r.needs_review,
      verified: r.verified,
      status: r.status,
      location_id: r.location_id,
      location_path: r.location_path ?? "",
      thumb_url: r.thumb_key ? await storage.presignGet(r.thumb_key) : null,
      created_at: new Date(r.created_at).toISOString(),
      group:
        r.group_count && r.group_count > 1
          ? {
              series: r.series,
              count: r.group_count,
              flagged: r.group_flagged ?? 0,
              thumb_urls: await Promise.all((r.group_thumbs ?? []).map((k) => (k ? storage.presignGet(k) : null))),
              location_paths: r.group_paths ?? [],
            }
          : null,
    })),
  );

  return {
    total: Number(result.hits[0]?.total ?? 0),
    unit_total: Number(result.hits[0]?.unit_total ?? 0),
    took_ms: Math.round(performance.now() - started),
    hits,
    facets: result.facets,
  };
}

async function runSearch(db: DB, q: Query, tokens: string[]) {
  const tsquery = tokens.map((t) => `${t}:*`).join(" & ");
  const match: RawBuilder<boolean> = tokens.length ? sql`s.tsv @@ to_tsquery('simple', ${tsquery})` : sql`true`;
  const rank = tokens.length ? sql`ts_rank(s.tsv, to_tsquery('simple', ${tsquery}))` : sql`0`;

  const scope = sql`
    ${match}
    ${q.status === "active" ? sql`AND u.status = 'active'` : sql``}
    ${q.location ? sql`AND s.location_id IN (SELECT id FROM subtree)` : sql``}
    ${q.in_transit ? sql`AND s.location_id IN (SELECT id FROM transit)` : sql``}
    ${q.unverified ? sql`AND (NOT c.verified OR u.needs_review)` : sql``}
  `;
  const chips = sql`
    ${q.category.length ? sql`AND category = ANY(${q.category}::text[])` : sql``}
    ${q.brand.length ? sql`AND brand = ANY(${q.brand}::text[])` : sql``}
    ${q.series.length ? sql`AND series = ANY(${q.series}::text[])` : sql``}
    ${q.condition.length ? sql`AND condition = ANY(${q.condition}::text[])` : sql``}
  `;
  const order =
    q.sort === "newest"
      ? sql`created_at DESC, id DESC`
      : q.sort === "name"
        ? sql`lower(item_name), id`
        : sql`rank DESC, created_at DESC, id DESC`;

  const ctes = sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM locations WHERE id = ${q.location ?? ""}
      UNION SELECT l.id FROM locations l JOIN subtree ON l.parent_id = subtree.id
    ),
    transit AS (
      SELECT id FROM locations WHERE path = 'In transit'
      UNION SELECT l.id FROM locations l JOIN transit ON l.parent_id = transit.id
    ),
    matched AS MATERIALIZED (
      SELECT u.id, u.status, u.condition, u.needs_review, u.created_at, u.catalog_item_id,
             c.category, c.brand, c.series, c.wave, c.item_name, c.model_number, c.verified,
             s.location_id, ${rank} AS rank
        FROM unit_search s
        JOIN units u ON u.id = s.unit_id
        JOIN catalog_items c ON c.id = u.catalog_item_id
       WHERE ${scope}
    )
  `;

  // Facets ignore the chip filters so every chip shows what selecting it would give.
  const facetsQuery = sql<{ facet: string; value: string; count: number }>`
    ${ctes}
    SELECT 'category' AS facet, category AS value, count(*)::int AS count FROM matched GROUP BY category
    UNION ALL SELECT 'brand', brand, count(*)::int FROM matched WHERE brand <> '' GROUP BY brand
    UNION ALL SELECT 'series', series, count(*)::int FROM matched WHERE series <> '' GROUP BY series
    UNION ALL SELECT 'condition', condition, count(*)::int FROM matched GROUP BY condition
  `;
  const thumbFor = (unitRef: RawBuilder<unknown>) => sql`(
    SELECT p.thumb_key FROM unit_photos up JOIN photos p ON p.id = up.photo_id
     WHERE up.unit_id = ${unitRef} ORDER BY up.role = 'intake' DESC, up.created_at LIMIT 1)`;

  const hitsQuery =
    q.group === "series"
      ? // One result per series; units without a series stay single. The representative
        // unit is the first by name, and the card shows up to four photos.
        sql<HitRow>`
    ${ctes},
    filtered AS (SELECT * FROM matched WHERE true ${chips}),
    groups AS (
      SELECT CASE WHEN series <> '' THEN 's:' || series ELSE 'u:' || id END AS gkey,
             count(*)::int AS group_count,
             max(rank) AS grank,
             max(created_at) AS gcreated,
             min(lower(item_name)) AS gname,
             (array_agg(id ORDER BY lower(item_name), id))[1:4] AS sample_ids,
             array_agg(DISTINCT location_id) FILTER (WHERE location_id IS NOT NULL) AS loc_ids,
             count(*) FILTER (WHERE needs_review)::int AS group_flagged
        FROM filtered GROUP BY 1
    ),
    gpage AS (
      SELECT *, count(*) OVER () AS total, sum(group_count) OVER () AS unit_total FROM groups
       ORDER BY ${q.sort === "newest" ? sql`gcreated DESC, gkey` : q.sort === "name" ? sql`gname, gkey` : sql`grank DESC, gcreated DESC, gkey`}
       LIMIT ${q.limit} OFFSET ${q.offset}
    )
    SELECT f.*, g.total, g.unit_total, g.group_count, g.group_flagged, g.grank, g.gcreated, g.gname, g.gkey,
           l.path AS location_path, ${thumbFor(sql`f.id`)} AS thumb_key,
           (SELECT array_agg(path ORDER BY path) FROM locations WHERE id = ANY(g.loc_ids)) AS group_paths,
           (SELECT array_agg(${thumbFor(sql`s.uid`)} ORDER BY s.ord) FROM unnest(g.sample_ids) WITH ORDINALITY AS s(uid, ord)) AS group_thumbs
      FROM gpage g
      JOIN filtered f ON f.id = g.sample_ids[1]
      LEFT JOIN locations l ON l.id = f.location_id
     ORDER BY ${q.sort === "newest" ? sql`g.gcreated DESC, g.gkey` : q.sort === "name" ? sql`g.gname, g.gkey` : sql`g.grank DESC, g.gcreated DESC, g.gkey`}
  `
      : sql<HitRow>`
    ${ctes},
    page AS (
      SELECT *, count(*) OVER () AS total FROM matched
       WHERE true ${chips}
       ORDER BY ${order}
       LIMIT ${q.limit} OFFSET ${q.offset}
    )
    SELECT page.*, page.total AS unit_total, l.path AS location_path, ${thumbFor(sql`page.id`)} AS thumb_key
      FROM page
      LEFT JOIN locations l ON l.id = page.location_id
     ORDER BY ${order}
  `;

  const [hits, facetRows] = await Promise.all([hitsQuery.execute(db), facetsQuery.execute(db)]);

  const facets: SearchResponse["facets"] = { category: [], brand: [], series: [], condition: [] };
  for (const f of facetRows.rows) facets[f.facet as keyof typeof facets].push({ value: f.value, count: f.count });
  for (const list of Object.values(facets)) list.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  facets.brand = facets.brand.slice(0, 30);
  facets.series = facets.series.slice(0, 30);
  const matched = facets.category.reduce((n, f) => n + f.count, 0);

  return { hits: hits.rows, facets, matched };
}

/** Replace words that prefix-match nothing with the closest indexed word, if close enough. */
async function correctTokens(db: DB, tokens: string[]): Promise<string[]> {
  const rows = await sql<{ token: string; fixed: string | null }>`
    SELECT t.token,
           CASE WHEN EXISTS (SELECT 1 FROM search_words w WHERE w.word LIKE replace(replace(t.token, '%', ''), '_', '\\_') || '%')
                THEN t.token
                ELSE (SELECT w.word FROM search_words w
                       WHERE w.word % t.token
                       ORDER BY similarity(w.word, t.token) DESC, length(w.word)
                       LIMIT 1)
           END AS fixed
      FROM unnest(${tokens}::text[]) WITH ORDINALITY AS t(token, n)
     ORDER BY t.n
  `.execute(db);
  return rows.rows.map((r) => r.fixed ?? r.token);
}

interface HitRow {
  id: string;
  status: string;
  condition: string;
  needs_review: boolean;
  created_at: Date;
  catalog_item_id: string;
  category: string;
  brand: string;
  series: string;
  wave: string;
  item_name: string;
  model_number: string;
  verified: boolean;
  location_id: string | null;
  location_path: string | null;
  thumb_key: string | null;
  total: string;
  unit_total: string;
  group_count?: number;
  group_flagged?: number;
  group_thumbs?: (string | null)[] | null;
  group_paths?: string[] | null;
}
