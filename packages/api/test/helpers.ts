import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { buildApp } from "../src/app.js";
import { type DB, createDb } from "../src/db.js";
import { migrateToLatest } from "../src/migrate.js";
import type { Storage } from "../src/storage.js";

export const TOKEN = "test-connector-token-0123456789abcdef";
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://toyvault:toyvault@localhost:55432/toyvault";

/** In-memory stand-in for the bucket. `put` simulates the connector's presigned upload. */
export class MemoryStorage implements Storage {
  objects = new Map<string, Buffer>();
  async presignPut(key: string) {
    return `memory://put/${key}`;
  }
  async presignGet(key: string) {
    return `memory://get/${key}`;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  put(key: string, body = Buffer.from("x")) {
    this.objects.set(key, body);
  }
}

export interface TestContext {
  db: DB;
  app: FastifyInstance;
  storage: MemoryStorage;
}

export const VIEWER_PASSWORD = "viewer-password-for-tests";
export const SESSION_SECRET = "session-secret-for-tests-0123456789abcdef";

export async function setup(storage: Storage = new MemoryStorage()): Promise<TestContext> {
  const db = createDb(TEST_DATABASE_URL);
  await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`.execute(db);
  await migrateToLatest(db);
  const app = await buildApp({
    db,
    storage,
    connectorToken: TOKEN,
    viewerPassword: VIEWER_PASSWORD,
    sessionSecret: SESSION_SECRET,
  });
  return { db, app, storage: storage as MemoryStorage };
}

export async function teardown(ctx: TestContext) {
  await ctx.app.close();
  await ctx.db.destroy();
}

export const auth = { authorization: `Bearer ${TOKEN}` };

let shaCounter = 0;
export function fakeSha(): string {
  shaCounter++;
  return shaCounter.toString(16).padStart(64, "0");
}

/** Register photos and mark their files uploaded; returns PH ids. */
export async function registerUploaded(ctx: TestContext, n: number, phashes?: string[]): Promise<string[]> {
  const photos = Array.from({ length: n }, (_, i) => ({
    sha256: fakeSha(),
    phash: phashes?.[i] ?? "0f0f0f0f0f0f0f0f",
    captured_at: null,
    source_folder: "2026-10-13",
    filename: `IMG_${i}.jpg`,
    width: 4032,
    height: 3024,
  }));
  const reg = await ctx.app.inject({ method: "POST", url: "/v1/photos", headers: auth, payload: { photos } });
  const ids: string[] = reg.json().photos.map((p: { id: string }) => p.id);
  const presign = await ctx.app.inject({
    method: "POST",
    url: "/v1/photos/presign",
    headers: auth,
    payload: { photos: ids.map((photo_id) => ({ photo_id, original_content_type: "image/jpeg" })) },
  });
  for (const p of presign.json().photos) {
    ctx.storage.put(p.original.key);
    ctx.storage.put(p.preview.key);
    ctx.storage.put(p.thumb.key);
  }
  return ids;
}

export async function resolveLocation(ctx: TestContext, path: string): Promise<string> {
  const res = await ctx.app.inject({ method: "POST", url: "/v1/locations/resolve", headers: auth, payload: { path } });
  return res.json().id;
}

export function extraction(photoIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    photo_ids: photoIds,
    ocr_text: ["TURBO RACERS", "SERIES 3"],
    category: "Die-cast vehicle",
    brand: "Hot Wheels",
    series: "Turbo Racers Series 3",
    item_name: "Night Shifter",
    model_number: "GTB12",
    condition: "Sealed",
    identity_confidence: 0.93,
    ...overrides,
  };
}

export async function intake(
  ctx: TestContext,
  locationId: string,
  extractions: unknown[],
  extra: Record<string, unknown> = {},
) {
  return ctx.app.inject({
    method: "POST",
    url: "/v1/intake-batches",
    headers: auth,
    payload: { client_key: randomUUID(), folder: "2026-10-13", location_id: locationId, extractions, ...extra },
  });
}
