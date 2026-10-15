import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIntegrity } from "../src/integrity.js";
import { type TestContext, VIEWER_PASSWORD, auth, extraction, intake, registerUploaded, resolveLocation, setup, teardown } from "./helpers.js";

let ctx: TestContext;
let wrong: string;
let right: string;
let unitIds: string[];

beforeAll(async () => {
  ctx = await setup();
  wrong = await resolveLocation(ctx, "Mirae › Office");
  right = await resolveLocation(ctx, "Green Garden › Mirae");
  const photos = await registerUploaded(ctx, 3);
  const res = (await intake(ctx, wrong, photos.map((p, i) => extraction([p], { item_name: `Toy ${i}`, ocr_text: [] })))).json();
  unitIds = res.listed.map((l: { unit_id: string }) => l.unit_id);
});
afterAll(async () => teardown(ctx));

const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
  ctx.app.inject({ method: "POST", url, headers, payload });
const get = (url: string) => ctx.app.inject({ method: "GET", url, headers: auth });

describe("location corrections", () => {
  it("moves every unit recorded at the wrong place with ADJUST movements, idempotently", async () => {
    const body = { client_key: randomUUID(), from_location_id: wrong, to_location_id: right, reason: "recorded at the wrong location" };
    const a = await post("/v1/locations/correct", body);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ from_path: "Mirae › Office", to_path: "Green Garden › Mirae", corrected: unitIds, skipped: [] });
    const b = await post("/v1/locations/correct", body);
    expect(b.json()).toMatchObject({ batch_id: a.json().batch_id, replayed: true });

    const unit = (await get(`/v1/units/${unitIds[0]}`)).json();
    expect(unit.location.path).toBe("Green Garden › Mirae");
    expect(unit.movements[0]).toMatchObject({ type: "ADJUST", reason: "recorded at the wrong location", from_path: "Mirae › Office" });
    expect((await get("/v1/search?q=green%20garden")).json().total).toBe(3); // search follows the location
    expect((await checkIntegrity(ctx.db)).ok).toBe(true);
  });

  it("can be undone as one batch", async () => {
    const res = (
      await post("/v1/locations/correct", { client_key: randomUUID(), from_location_id: right, to_location_id: wrong, unit_ids: [unitIds[1]], reason: "test" })
    ).json();
    const undo = await post(`/v1/batches/${res.batch_id}/undo`, {});
    expect(undo.json()).toMatchObject({ reversed_movements: 1, disposed_units: [] });
    expect((await get(`/v1/units/${unitIds[1]}`)).json().location.path).toBe("Green Garden › Mirae");
    expect((await checkIntegrity(ctx.db)).ok).toBe(true);
  });

  it("reports units that are not at the source, and refuses virtual targets and viewers", async () => {
    const partial = (
      await post("/v1/locations/correct", {
        client_key: randomUUID(),
        from_location_id: right,
        to_location_id: wrong,
        unit_ids: [unitIds[0], "TV-999999"],
        reason: "test",
      })
    ).json();
    expect(partial.skipped).toEqual([{ unit_id: "TV-999999", reason: "not recorded at Green Garden › Mirae" }]);

    const transit = (await ctx.db.selectFrom("locations").select("id").where("path", "=", "In transit").executeTakeFirstOrThrow()).id;
    const virtual = await post("/v1/locations/correct", { client_key: randomUUID(), from_location_id: wrong, to_location_id: transit, reason: "x x" });
    expect(virtual.statusCode).toBe(400);

    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { password: VIEWER_PASSWORD } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect((await post("/v1/locations/correct", {}, { cookie })).statusCode).toBe(403);
  });
});
