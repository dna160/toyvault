import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { checkIntegrity } from "../src/integrity.js";
import {
  type TestContext,
  auth,
  extraction,
  intake,
  registerUploaded,
  resolveLocation,
  setup,
  teardown,
} from "./helpers.js";

let ctx: TestContext;
let shelfA: string;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));
beforeEach(async () => {
  shelfA = await resolveLocation(ctx, "Old House › Garage › Shelf A");
});

async function count(table: string): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(ctx.db);
  return Number(r.rows[0]!.n);
}

describe("auth", () => {
  it("rejects write routes without the connector token", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/intake-batches", payload: {} });
    expect(res.statusCode).toBe(401);
  });
  it("rejects a wrong token", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/photos",
      headers: { authorization: "Bearer nope" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
  it("serves /healthz without auth", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/healthz" });
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("photo registration", () => {
  it("is idempotent on SHA-256", async () => {
    const photo = {
      sha256: "a".repeat(64),
      phash: "00ff00ff00ff00ff",
      captured_at: "2026-10-13T09:00:00+07:00",
      source_folder: "2026-10-13",
      filename: "IMG_1.jpg",
      width: 100,
      height: 100,
    };
    const a = await ctx.app.inject({ method: "POST", url: "/v1/photos", headers: auth, payload: { photos: [photo] } });
    const b = await ctx.app.inject({ method: "POST", url: "/v1/photos", headers: auth, payload: { photos: [photo] } });
    expect(a.statusCode).toBe(200);
    expect(b.json().photos[0].id).toBe(a.json().photos[0].id);
  });
});

describe("intake batches", () => {
  it("lists every toy as a unit at the location with a RECEIPT movement", async () => {
    const [p1, p2, p3] = await registerUploaded(ctx, 3);
    const res = await intake(ctx, shelfA, [extraction([p1!, p2!]), extraction([p3!], { item_name: "Bone Shaker" })]);
    expect(res.statusCode).toBe(200);
    const receipt = res.json();
    expect(receipt.listed).toHaveLength(2);
    expect(receipt.listed[0].photo_ids).toEqual([p1, p2]); // two photos, one toy
    expect(receipt.location_path).toBe("Old House › Garage › Shelf A");

    const unit = await ctx.app.inject({ method: "GET", url: `/v1/units/${receipt.listed[0].unit_id}`, headers: auth });
    expect(unit.json().location.path).toBe("Old House › Garage › Shelf A");
    expect(unit.json().movements.map((m: { type: string }) => m.type)).toEqual(["RECEIPT"]);
    expect(unit.json().photos).toHaveLength(2);
    expect((await checkIntegrity(ctx.db)).ok).toBe(true);
  });

  it("returns the original receipt when the same batch is sent twice", async () => {
    const [p1] = await registerUploaded(ctx, 1);
    const client_key = randomUUID();
    const payload = { client_key, folder: "2026-10-13", location_id: shelfA, extractions: [extraction([p1!])] };
    const before = await count("units");
    const a = await ctx.app.inject({ method: "POST", url: "/v1/intake-batches", headers: auth, payload });
    const b = await ctx.app.inject({ method: "POST", url: "/v1/intake-batches", headers: auth, payload });
    expect(b.statusCode).toBe(200);
    expect(b.json().replayed).toBe(true);
    expect(b.json().batch_id).toBe(a.json().batch_id);
    expect(b.json().listed).toEqual(a.json().listed);
    expect((await count("units")) - before).toBe(1);
  });

  it("handles concurrent retries of the same batch without duplicates", async () => {
    const [p1] = await registerUploaded(ctx, 1);
    const payload = { client_key: randomUUID(), folder: "x", location_id: shelfA, extractions: [extraction([p1!])] };
    const before = await count("units");
    const results = await Promise.all(
      [1, 2, 3].map(() => ctx.app.inject({ method: "POST", url: "/v1/intake-batches", headers: auth, payload })),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().batch_id)).size).toBe(1);
    expect((await count("units")) - before).toBe(1);
  });

  it("never lists the same photo twice, even in a different batch", async () => {
    const [p1] = await registerUploaded(ctx, 1);
    const first = await intake(ctx, shelfA, [extraction([p1!])]);
    const second = await intake(ctx, shelfA, [extraction([p1!])]);
    expect(second.statusCode).toBe(200);
    expect(second.json().listed).toHaveLength(0);
    expect(second.json().skipped).toEqual([
      { photo_ids: [p1], reason: "already_listed", unit_id: first.json().listed[0].unit_id },
    ]);
  });

  it("makes one unit per toy in a group shot", async () => {
    const [group] = await registerUploaded(ctx, 1);
    const res = await intake(ctx, shelfA, [
      extraction([group!], { item_name: "Red car" }),
      extraction([group!], { item_name: "Blue car" }),
    ]);
    expect(res.json().listed).toHaveLength(2);
  });

  it("records same-shot skips in the receipt", async () => {
    const [p1, dup] = await registerUploaded(ctx, 2);
    const res = await intake(ctx, shelfA, [extraction([p1!])], { skipped_photo_ids: [dup] });
    expect(res.json().skipped).toEqual([{ photo_ids: [dup], reason: "same_shot", unit_id: null }]);
  });

  it("flags low-confidence identities and opens a review task", async () => {
    const [p1] = await registerUploaded(ctx, 1);
    const res = await intake(ctx, shelfA, [
      extraction([p1!], { identity_confidence: 0.4, needs_review: true, review_reason: "no readable text" }),
    ]);
    expect(res.json().flagged_count).toBe(1);
    const tasks = await ctx.db
      .selectFrom("review_tasks")
      .selectAll()
      .where("unit_id", "=", res.json().listed[0].unit_id)
      .execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.kind).toBe("uncertain_identity");
  });

  it("reuses a catalogue item when Claude passes its ID", async () => {
    const [p1, p2] = await registerUploaded(ctx, 2);
    const first = await intake(ctx, shelfA, [extraction([p1!])]);
    const catalogId = first.json().listed[0].catalog_item_id;
    const second = await intake(ctx, shelfA, [extraction([p2!], { catalog_item_id: catalogId })]);
    expect(second.json().listed[0].catalog_item_id).toBe(catalogId);
  });

  it("rejects invalid extractions with field-level errors", async () => {
    const [p1] = await registerUploaded(ctx, 1);
    const res = await intake(ctx, shelfA, [extraction([p1!], { category: "Spaceship", needs_review: true })]);
    expect(res.statusCode).toBe(400);
    const paths = res.json().issues.map((i: { path: string }) => i.path);
    expect(paths).toContain("extractions.0.category");
    expect(paths).toContain("extractions.0.review_reason");
  });

  it("rejects photos that were never registered or uploaded", async () => {
    const unknown = await intake(ctx, shelfA, [extraction(["PH-999999"])]);
    expect(unknown.statusCode).toBe(400);
    const reg = await ctx.app.inject({
      method: "POST",
      url: "/v1/photos",
      headers: auth,
      payload: {
        photos: [
          {
            sha256: "b".repeat(64),
            phash: "0000000000000000",
            captured_at: null,
            source_folder: "x",
            filename: "y.jpg",
            width: 1,
            height: 1,
          },
        ],
      },
    });
    const notUploaded = await intake(ctx, shelfA, [extraction([reg.json().photos[0].id])]);
    expect(notUploaded.statusCode).toBe(400);
    expect(notUploaded.json().message).toMatch(/not uploaded/);
  });

  it("is all-or-nothing: a bad extraction leaves nothing written", async () => {
    const [p1, p2] = await registerUploaded(ctx, 2);
    const units = await count("units");
    const batches = await count("batches");
    const movements = await count("movements");
    const res = await intake(ctx, shelfA, [extraction([p1!]), extraction([p2!], { catalog_item_id: "CAT-999999" })]);
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("extractions.1.catalog_item_id");
    expect(await count("units")).toBe(units);
    expect(await count("batches")).toBe(batches);
    expect(await count("movements")).toBe(movements);
  });

  it("uses a reserved label ID when the QR is decoded", async () => {
    await ctx.db.insertInto("id_reservations").values({ unit_id: "TV-900001", used_at: null }).execute();
    const [p1] = await registerUploaded(ctx, 1);
    const res = await intake(ctx, shelfA, [extraction([p1!], { qr: "TV-900001" })]);
    expect(res.json().listed[0].unit_id).toBe("TV-900001");
  });
});
