import type { BatchSummary, LocationNode, Stats } from "@toyvault/shared";
import { sql } from "kysely";
import type { DB } from "./db.js";
import { notFound } from "./errors.js";
import type { Storage } from "./storage.js";

/** Location tree with direct and subtree unit counts; virtual locations pinned first. */
export async function locationTree(db: DB): Promise<{ roots: LocationNode[] }> {
  const rows = await sql<{ id: string; parent_id: string | null; name: string; path: string; kind: string; n: number }>`
    SELECT l.id, l.parent_id, l.name, l.path, l.kind,
           (SELECT count(*) FROM unit_current_location ucl JOIN units u ON u.id = ucl.unit_id
             WHERE ucl.location_id = l.id AND u.status = 'active')::int AS n
      FROM locations l
     ORDER BY l.path
  `.execute(db);

  const nodes = new Map<string, LocationNode & { parent_id: string | null }>();
  for (const r of rows.rows) {
    nodes.set(r.id, { ...r, unit_count: r.n, subtree_count: 0, children: [] });
  }
  const roots: LocationNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const total = (n: LocationNode): number => (n.subtree_count = n.unit_count + n.children.reduce((s, c) => s + total(c), 0));
  roots.forEach(total);

  const pinned = ["In transit", "Unknown"];
  roots.sort((a, b) => {
    const pa = pinned.indexOf(a.path);
    const pb = pinned.indexOf(b.path);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    if (a.path === "Disposed") return 1;
    if (b.path === "Disposed") return -1;
    return a.name.localeCompare(b.name);
  });
  const strip = (n: LocationNode & { parent_id?: string | null }): LocationNode => {
    const { parent_id: _p, ...rest } = n;
    return { ...rest, children: rest.children.map(strip) };
  };
  return { roots: roots.map(strip) };
}

export async function listBatches(db: DB, storage: Storage, limit = 50, offset = 0): Promise<{ batches: BatchSummary[] }> {
  const rows = await db
    .selectFrom("batches as b")
    .leftJoin("locations as l", "l.id", "b.to_location_id")
    .select(["b.id", "b.mode", "b.folder", "b.instruction", "b.status", "b.counts", "b.created_at", "b.undone_at", "l.path as to_path"])
    .orderBy("b.created_at", "desc")
    .orderBy("b.id", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  const batches = await Promise.all(
    rows.map(async (b) => {
      const thumbs = await sql<{ unit_id: string; thumb_key: string | null }>`
        SELECT DISTINCT ON (u.id) u.id AS unit_id, p.thumb_key
          FROM units u
          JOIN unit_photos up ON up.unit_id = u.id
          JOIN photos p ON p.id = up.photo_id
         WHERE u.created_batch_id = ${b.id}
         ORDER BY u.id, up.created_at
         LIMIT 12
      `.execute(db);
      return {
        id: b.id,
        mode: b.mode,
        folder: b.folder,
        instruction: b.instruction,
        status: b.status,
        to_location_path: b.to_path,
        counts: (b.counts ?? {}) as Record<string, number>,
        created_at: new Date(b.created_at).toISOString(),
        undone_at: b.undone_at ? new Date(b.undone_at).toISOString() : null,
        thumbs: await Promise.all(
          thumbs.rows.map(async (t) => ({
            unit_id: t.unit_id,
            thumb_url: t.thumb_key ? await storage.presignGet(t.thumb_key) : null,
          })),
        ),
      };
    }),
  );
  return { batches };
}

export async function getBatchReceipt(db: DB, id: string) {
  const b = await db
    .selectFrom("batches")
    .select(["id", "receipt", "undo_receipt", "status"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!b) throw notFound(`unknown batch ${id}`);
  return { id: b.id, status: b.status, receipt: b.receipt, undo: b.undo_receipt };
}

export async function stats(db: DB): Promise<Stats> {
  const r = await sql<{ units: number; photos: number; open_reviews: number; catalog_items: number }>`
    SELECT (SELECT count(*) FROM units WHERE status = 'active')::int AS units,
           (SELECT count(DISTINCT up.photo_id) FROM unit_photos up JOIN units u ON u.id = up.unit_id
             WHERE u.status = 'active')::int AS photos,
           (SELECT count(*) FROM review_tasks WHERE status = 'open')::int AS open_reviews,
           (SELECT count(*) FROM catalog_items)::int AS catalog_items
  `.execute(db);
  return r.rows[0]!;
}
