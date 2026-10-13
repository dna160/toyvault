import { timingSafeEqual } from "node:crypto";
import {
  CandidatesQuery,
  IntakeBatchRequest,
  LocationResolveRequest,
  PhotoRegisterRequest,
  PresignRequest,
  formatIssues,
} from "@toyvault/shared";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { sql } from "kysely";
import { ZodError, type z } from "zod";
import { findCandidates } from "./candidates.js";
import { type DB, phashToBits } from "./db.js";
import { HttpError } from "./errors.js";
import { commitIntakeBatch } from "./intake.js";
import { resolveLocationPath } from "./locations.js";
import { type Storage, photoKeys } from "./storage.js";
import { getUnitDetail } from "./units.js";

export interface AppOptions {
  db: DB;
  storage: Storage;
  connectorToken: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db, storage } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_request", message: "request failed validation", issues: formatIssues(err) });
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: "invalid_request", message: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  app.get("/healthz", async () => {
    await sql`SELECT 1`.execute(db);
    return { ok: true };
  });

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(LANDING_HTML);
  });

  // Everything under /v1 is connector-only in Phase 1 (viewer sessions arrive in Phase 2,
  // with a read-only scope that write routes reject).
  await app.register(
    async (v1) => {
      v1.addHook("onRequest", async (req) => requireConnector(req, opts.connectorToken));

      v1.post("/photos", async (req) => {
        const body = parse(PhotoRegisterRequest, req.body);
        const results = [];
        for (const p of body.photos) {
          const row = await sql<{ id: string; upload_status: "registered" | "uploaded" }>`
            INSERT INTO photos (sha256, phash, captured_at, source_folder, filename, width, height)
            VALUES (${p.sha256}, ${phashToBits(p.phash)}::bit(64), ${p.captured_at}, ${p.source_folder}, ${p.filename}, ${p.width}, ${p.height})
            ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
            RETURNING id, upload_status
          `.execute(db);
          const photo = row.rows[0]!;
          const active = await db
            .selectFrom("unit_photos")
            .innerJoin("units", "units.id", "unit_photos.unit_id")
            .select("unit_photos.unit_id")
            .where("unit_photos.photo_id", "=", photo.id)
            .where("unit_photos.role", "=", "intake")
            .where("units.status", "=", "active")
            .execute();
          results.push({
            id: photo.id,
            sha256: p.sha256,
            upload_status: photo.upload_status,
            active_units: active.map((a) => a.unit_id),
          });
        }
        return { photos: results };
      });

      v1.post("/photos/presign", async (req) => {
        const body = parse(PresignRequest, req.body);
        const out = [];
        for (const p of body.photos) {
          const keys = photoKeys(p.photo_id, p.original_content_type);
          const updated = await db
            .updateTable("photos")
            .set({
              original_key: keys.original,
              preview_key: keys.preview,
              thumb_key: keys.thumb,
              original_content_type: p.original_content_type,
            })
            .where("id", "=", p.photo_id)
            .returning("id")
            .executeTakeFirst();
          if (!updated) throw new HttpError(400, "invalid_request", `unknown photo ${p.photo_id}`);
          const [original, preview, thumb] = await Promise.all([
            storage.presignPut(keys.original, p.original_content_type),
            storage.presignPut(keys.preview, "image/jpeg"),
            storage.presignPut(keys.thumb, "image/jpeg"),
          ]);
          out.push({
            photo_id: p.photo_id,
            original: { key: keys.original, url: original },
            preview: { key: keys.preview, url: preview },
            thumb: { key: keys.thumb, url: thumb },
          });
        }
        return { photos: out };
      });

      v1.post("/locations/resolve", async (req) => {
        const body = parse(LocationResolveRequest, req.body);
        return resolveLocationPath(db, body.path);
      });

      v1.post("/intake-batches", async (req) => {
        const body = parse(IntakeBatchRequest, req.body);
        return commitIntakeBatch(db, storage, body);
      });

      v1.get("/candidates", async (req) => {
        const query = parse(CandidatesQuery, req.query);
        return findCandidates(db, storage, query);
      });

      v1.get<{ Params: { id: string } }>("/units/:id", async (req) => getUnitDetail(db, storage, req.params.id));
    },
    { prefix: "/v1" },
  );

  return app;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
}

function requireConnector(req: FastifyRequest, token: string) {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, "unauthorized", "a valid connector token is required");
  }
}

const LANDING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ToyVault</title>
<style>
  :root { --bg:#f7f4ee; --ink:#161513; --muted:#6b665d; --accent:#ff5a1f; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 "IBM Plex Sans", system-ui, sans-serif; }
  main { max-width:560px; margin:12vh auto; padding:0 16px; }
  h1 { font-size:28px; margin:0 0 8px; } h1 span { color:var(--accent); }
  p { color:var(--muted); margin:0 0 12px; }
  code { font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:14px; }
</style></head>
<body><main>
  <h1>Toy<span>Vault</span></h1>
  <p>The ledger API is running. Data enters only through Claude Desktop.</p>
  <p>The read-only viewer arrives in Phase 2. Health: <code><a href="/healthz">/healthz</a></code></p>
</main></body></html>`;
