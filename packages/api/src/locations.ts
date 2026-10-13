import { PATH_SEPARATOR, splitLocationPath } from "@toyvault/shared";
import { sql } from "kysely";
import type { DB } from "./db.js";
import { badRequest } from "./errors.js";

const KIND_BY_DEPTH = ["site", "room", "zone"] as const;

/**
 * Resolve "Old House › Garage › Shelf A" to a location, creating missing levels.
 * Matching is case-insensitive per level; the first spelling used is kept.
 */
export async function resolveLocationPath(db: DB, rawPath: string) {
  const parts = splitLocationPath(rawPath);
  if (parts.length === 0) throw badRequest("location path is empty", [{ path: "path", message: "empty" }]);

  return db.transaction().execute(async (trx) => {
    let parentId: string | null = null;
    let parentPath = "";
    let created = false;
    let current: { id: string; path: string } | undefined;

    for (const [depth, name] of parts.entries()) {
      const path = parentPath ? `${parentPath}${PATH_SEPARATOR}${name}` : name;
      const kind = depth === 0 && parts.length === 1 && isVirtual(name) ? "virtual" : (KIND_BY_DEPTH[depth] ?? "bin");
      const inserted = await sql<{ id: string }>`
        INSERT INTO locations (parent_id, name, path, kind)
        VALUES (${parentId}, ${name}, ${path}, ${kind})
        ON CONFLICT DO NOTHING
        RETURNING id
      `.execute(trx);
      if (inserted.rows[0]) created = true;

      current = await trx
        .selectFrom("locations")
        .select(["id", "path"])
        .where(sql<boolean>`coalesce(parent_id, '') = ${parentId ?? ""}`)
        .where(sql<boolean>`lower(name) = lower(${name})`)
        .executeTakeFirstOrThrow();
      parentId = current.id;
      parentPath = current.path;
    }
    return { id: current!.id, path: current!.path, created };
  });
}

function isVirtual(name: string) {
  return ["in transit", "unknown", "disposed"].includes(name.toLowerCase());
}
