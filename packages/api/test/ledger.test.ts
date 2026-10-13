import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { checkIntegrity } from "../src/integrity.js";
import { recordMovement } from "../src/ledger.js";
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

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));

async function newUnit(locationId: string, overrides: Record<string, unknown> = {}, phash?: string) {
  const [p] = await registerUploaded(ctx, 1, phash ? [phash] : undefined);
  const res = await intake(ctx, locationId, [extraction([p!], overrides)]);
  return res.json().listed[0] as { unit_id: string; catalog_item_id: string };
}

describe("locations", () => {
  it("creates missing levels and reuses existing ones case-insensitively", async () => {
    const a = await ctx.app.inject({
      method: "POST",
      url: "/v1/locations/resolve",
      headers: auth,
      payload: { path: "New House > Study > Cabinet 2" },
    });
    expect(a.json()).toMatchObject({ path: "New House › Study › Cabinet 2", created: true });
    const b = await ctx.app.inject({
      method: "POST",
      url: "/v1/locations/resolve",
      headers: auth,
      payload: { path: "new house › study › cabinet 2" },
    });
    expect(b.json()).toEqual({ id: a.json().id, path: "New House › Study › Cabinet 2", created: false });
  });

  it("seeds the virtual locations", async () => {
    const rows = await ctx.db.selectFrom("locations").select("path").where("kind", "=", "virtual").execute();
    expect(rows.map((r) => r.path).sort()).toEqual(["Disposed", "In transit", "Unknown"]);
  });
});

describe("ledger invariants", () => {
  it("refuses to update or delete movements", async () => {
    const shelf = await resolveLocation(ctx, "Old House › Garage › Shelf B");
    await newUnit(shelf);
    await expect(sql`UPDATE movements SET reason = 'x'`.execute(ctx.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM movements`.execute(ctx.db)).rejects.toThrow(/append-only/);
  });

  it("keeps the projection equal to a replay of movements, including containers", async () => {
    const shelf = await resolveLocation(ctx, "Old House › Garage › Shelf C");
    const newHouse = await resolveLocation(ctx, "New House › Garage");
    const { unit_id } = await newUnit(shelf);
    const carton = await ctx.db.insertInto("containers").values({ label: "C-test" }).returning("id").executeTakeFirstOrThrow();

    await ctx.db.transaction().execute(async (trx) => {
      await recordMovement(trx, { type: "TRANSFER", containerId: carton.id, toLocationId: shelf, idempotencyKey: "c1" });
      await recordMovement(trx, { type: "PACK", unitId: unit_id, toContainerId: carton.id, idempotencyKey: "p1" });
      await recordMovement(trx, { type: "TRANSFER", containerId: carton.id, toLocationId: newHouse, idempotencyKey: "c2" });
    });

    const loc = await ctx.db
      .selectFrom("unit_current_location")
      .select("location_id")
      .where("unit_id", "=", unit_id)
      .executeTakeFirstOrThrow();
    expect(loc.location_id).toBe(newHouse); // unit resolves through its carton
    expect(await checkIntegrity(ctx.db)).toMatchObject({ ok: true });
  });

  it("returns the original movement for a replayed idempotency key", async () => {
    const shelf = await resolveLocation(ctx, "Old House › Garage › Shelf D");
    const other = await resolveLocation(ctx, "Old House › Garage › Shelf E");
    const { unit_id } = await newUnit(shelf);
    const [a, b] = await ctx.db.transaction().execute(async (trx) => [
      await recordMovement(trx, { type: "TRANSFER", unitId: unit_id, toLocationId: other, idempotencyKey: "same" }),
      await recordMovement(trx, { type: "TRANSFER", unitId: unit_id, toLocationId: other, idempotencyKey: "same" }),
    ]);
    expect(b).toEqual({ id: a!.id, replayed: true });
  });

  it("rejects container cycles", async () => {
    const shelf = await resolveLocation(ctx, "Old House › Attic");
    const [outer, inner] = await Promise.all(
      ["outer", "inner"].map((label) =>
        ctx.db.insertInto("containers").values({ label }).returning("id").executeTakeFirstOrThrow(),
      ),
    );
    await ctx.db.transaction().execute(async (trx) => {
      await recordMovement(trx, { type: "TRANSFER", containerId: outer!.id, toLocationId: shelf, idempotencyKey: "o1" });
      await recordMovement(trx, { type: "PACK", containerId: inner!.id, toContainerId: outer!.id, idempotencyKey: "i1" });
    });
    await expect(
      ctx.db.transaction().execute((trx) =>
        recordMovement(trx, { type: "PACK", containerId: outer!.id, toContainerId: inner!.id, idempotencyKey: "o2" }),
      ),
    ).rejects.toThrow(/cycle/);
    await expect(
      ctx.db.transaction().execute((trx) =>
        recordMovement(trx, { type: "PACK", containerId: outer!.id, toContainerId: outer!.id, idempotencyKey: "o3" }),
      ),
    ).rejects.toThrow(/itself/);
  });
});

describe("candidates", () => {
  it("shortlists units at the source and close matches elsewhere", async () => {
    const source = await resolveLocation(ctx, "Candidate House › Shelf 1");
    const other = await resolveLocation(ctx, "Candidate House › Shelf 2");
    const here = await newUnit(source, { model_number: "ZZ-1" }, "ffff0000ffff0000");
    await newUnit(source, { model_number: "QQ-9", item_name: "Other" }, "0000000000000000");
    const there = await newUnit(other, { model_number: "ZZ-1" }, "ffff0000ffff0001");
    await newUnit(other, { model_number: "NOPE" }, "123456789abcdef0");

    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/candidates?location=${source}&model=zz-1&phash=ffff0000ffff0000`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.at_source).toHaveLength(2);
    expect(body.at_source[0].unit_id).toBe(here.unit_id);
    expect(body.at_source[0].matched_by).toEqual(["catalog", "phash", "location"]);
    expect(body.at_source[0].thumb_url).toMatch(/^memory:\/\/get\//);
    expect(body.elsewhere.map((c: { unit_id: string }) => c.unit_id)).toEqual([there.unit_id]);
  });
});
