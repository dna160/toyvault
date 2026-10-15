import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import {
  CandidatesQuery,
  CatalogFindQuery,
  CatalogSaveRequest,
  CatalogUpdateRequest,
  IntakeBatchRequest,
  LocationCorrectRequest,
  LocationResolveRequest,
  PhotoRegisterRequest,
  PresignRequest,
  ReviewQuery,
  SearchQuery,
  UnitReviewRequest,
  formatIssues,
} from "@toyvault/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { ZodError, z } from "zod";
import {
  type AuthConfig,
  LoginLimiter,
  checkPassword,
  clearSession,
  issueSession,
  principalOf,
  requireReader,
  requireWriter,
} from "./auth.js";
import { findCandidates } from "./candidates.js";
import { correctLocation } from "./corrections.js";
import { findCatalog, saveCatalog } from "./catalog.js";
import { type DB, phashToBits } from "./db.js";
import { HttpError } from "./errors.js";
import { commitIntakeBatch } from "./intake.js";
import { resolveLocationPath } from "./locations.js";
import { getBatchReceipt, listBatches, locationTree, stats } from "./reads.js";
import { listReviews, reviewSummary, reviewUnit, updateCatalog } from "./review.js";
import { searchUnits } from "./search.js";
import { type Storage, photoKeys } from "./storage.js";
import { undoBatch } from "./undo.js";
import { getUnitDetail } from "./units.js";

export interface AppOptions {
  db: DB;
  storage: Storage;
  connectorToken: string;
  viewerPassword?: string;
  sessionSecret?: string;
  secureCookies?: boolean;
  /** Built viewer (packages/viewer/dist). Served at / when present. */
  viewerDist?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db, storage } = opts;
  const auth: AuthConfig = {
    connectorToken: opts.connectorToken,
    viewerPassword: opts.viewerPassword,
    sessionSecret: opts.sessionSecret,
    secureCookies: opts.secureCookies,
  };
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024, trustProxy: true });

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

  // ---------- Viewer session ----------
  const limiter = new LoginLimiter();
  app.post("/auth/login", async (req, reply) => {
    if (!limiter.allow(req.ip)) throw new HttpError(429, "too_many_attempts", "too many attempts; try again in 15 minutes");
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    if (!checkPassword(password, auth)) throw new HttpError(401, "unauthorized", "wrong password");
    issueSession(reply, auth);
    return { ok: true, scope: "read" };
  });
  app.post("/auth/logout", async (_req, reply) => {
    clearSession(reply, auth);
    return { ok: true };
  });
  app.get("/auth/me", async (req) => {
    const p = principalOf(req, auth);
    if (!p) throw new HttpError(401, "unauthorized", "not signed in");
    return { principal: p, scope: p === "viewer" ? "read" : "write" };
  });

  // ---------- API ----------
  await app.register(
    async (v1) => {
      // Every route declares whether it reads or writes; writes reject viewer sessions.
      v1.addHook("onRequest", async (req) => {
        if (req.method === "GET" || req.method === "HEAD") requireReader(req, auth);
        else requireWriter(req, auth);
      });

      // Writes (connector only)
      v1.post("/photos", async (req) => {
        const body = PhotoRegisterRequest.parse(req.body);
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
        const body = PresignRequest.parse(req.body);
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
        const body = LocationResolveRequest.parse(req.body);
        return resolveLocationPath(db, body.path, body.create);
      });
      v1.post("/locations/correct", async (req) => correctLocation(db, LocationCorrectRequest.parse(req.body)));
      v1.post("/intake-batches", async (req) => commitIntakeBatch(db, storage, IntakeBatchRequest.parse(req.body)));
      v1.post("/catalog", async (req) => saveCatalog(db, CatalogSaveRequest.parse(req.body)));
      v1.post<{ Params: { id: string } }>("/batches/:id/undo", async (req) => undoBatch(db, req.params.id));
      v1.post<{ Params: { id: string } }>("/units/:id/review", async (req) =>
        reviewUnit(db, req.params.id, UnitReviewRequest.parse(req.body)),
      );
      v1.post<{ Params: { id: string } }>("/reviews/:id/resolve", async (req) => {
        const task = await db.selectFrom("review_tasks").select("unit_id").where("id", "=", req.params.id).executeTakeFirst();
        if (!task?.unit_id) throw new HttpError(404, "not_found", `unknown review ${req.params.id}`);
        return reviewUnit(db, task.unit_id, UnitReviewRequest.parse(req.body));
      });
      v1.post<{ Params: { id: string } }>("/catalog/:id", async (req) =>
        updateCatalog(db, req.params.id, CatalogUpdateRequest.parse(req.body)),
      );

      // Reads (connector or viewer)
      v1.get("/search", async (req) => searchUnits(db, storage, SearchQuery.parse(req.query)));
      v1.get("/catalog", async (req) => findCatalog(db, CatalogFindQuery.parse(req.query)));
      v1.get("/candidates", async (req) => findCandidates(db, storage, CandidatesQuery.parse(req.query)));
      v1.get<{ Params: { id: string } }>("/units/:id", async (req) => getUnitDetail(db, storage, req.params.id));
      v1.get("/locations/tree", async () => locationTree(db));
      v1.get("/batches", async (req) => {
        const q = z
          .object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) })
          .parse(req.query);
        return listBatches(db, storage, q.limit, q.offset);
      });
      v1.get<{ Params: { id: string } }>("/batches/:id", async (req) => getBatchReceipt(db, req.params.id));
      v1.get("/stats", async () => stats(db));
      v1.get("/reviews/summary", async () => reviewSummary(db));
      v1.get("/reviews", async (req) => listReviews(db, storage, ReviewQuery.parse(req.query)));
    },
    { prefix: "/v1" },
  );

  // ---------- Viewer (static, read-only) ----------
  const dist = opts.viewerDist;
  if (dist && existsSync(join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, index: ["index.html"] });
    // Client-side routes fall back to index.html; API and auth paths keep their 404s.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !/^\/(v1|auth|healthz)(\/|$)/.test(req.url)) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found", message: `no route for ${req.method} ${req.url}` });
    });
  } else {
    app.get("/", async (_req, reply) => reply.type("text/html").send(LANDING_HTML));
  }

  return app;
}

const LANDING_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ToyVault</title></head>
<body style="font:16px system-ui;background:#f7f4ee;color:#161513;padding:12vh 16px;max-width:560px;margin:auto">
<h1>ToyVault</h1><p>The ledger API is running. The viewer build was not found on this server.</p></body></html>`;
