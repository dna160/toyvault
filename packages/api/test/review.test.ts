import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIntegrity } from "../src/integrity.js";
import { type TestContext, VIEWER_PASSWORD, auth, extraction, intake, registerUploaded, resolveLocation, setup, teardown } from "./helpers.js";

let ctx: TestContext;
let office: string;
let units: { carton: string; lowConf: string; good: string; verifiedProduct: string };

beforeAll(async () => {
  ctx = await setup();
  office = await resolveLocation(ctx, "Mirae › Office");
  const p = await registerUploaded(ctx, 4);
  const res = (
    await intake(ctx, office, [
      extraction([p[0]!], { item_name: "Shipping carton", category: "Other", identity_confidence: 0.3, needs_review: true, review_reason: "contents not visible", ocr_text: [] }),
      extraction([p[1]!], { item_name: "Noctis", category: "Action figure", field_confidence: { release_year: 0.5, series: 0.95 }, release_year: 2016, ocr_text: [] }),
      extraction([p[2]!], { item_name: "Lightning", category: "Action figure", field_confidence: { series: 0.95 }, ocr_text: [] }),
      extraction([p[3]!], { item_name: "Ferrari SP3", category: "Building set", web_source_url: "https://example.com/42143", ocr_text: [] }),
    ])
  ).json();
  const ids = res.listed.map((l: { unit_id: string }) => l.unit_id);
  units = { carton: ids[0], lowConf: ids[1], good: ids[2], verifiedProduct: ids[3] };
});
afterAll(async () => teardown(ctx));

const get = (url: string) => ctx.app.inject({ method: "GET", url, headers: auth });
const post = (url: string, payload: unknown) => ctx.app.inject({ method: "POST", url, headers: auth, payload });

describe("review lists", () => {
  it("summarises each review queue", async () => {
    expect((await get("/v1/reviews/summary")).json()).toEqual({
      flagged: 1,
      unverified: 3, // every product without a web source
      low_confidence: 1, // the flagged unit is listed under flagged only
      ambiguous_moves: 0,
      count_discrepancies: 0,
    });
  });

  it("lists flagged units with their reason and open review ID", async () => {
    const list = (await get("/v1/reviews?kind=flagged")).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ subject_id: units.carton, reason: "contents not visible", location_paths: ["Mirae › Office"] });
    expect(list.items[0].review_id).toMatch(/^RV-/);
  });

  it("lists unverified products once with their units, and low-confidence fields by unit", async () => {
    const unverified = (await get("/v1/reviews?kind=unverified")).json();
    expect(unverified.items.every((i: { subject_id: string }) => i.subject_id.startsWith("CAT-"))).toBe(true);
    const low = (await get("/v1/reviews?kind=low_confidence")).json();
    expect(low.items[0]).toMatchObject({ subject_id: units.lowConf, low_fields: [{ field: "release_year", value: "2016", confidence: 0.5 }] });
  });
});

describe("resolving", () => {
  it("disposes a unit that is not a toy and resolves its review", async () => {
    const res = await post(`/v1/units/${units.carton}/review`, { action: "not_a_toy", reason: "empty shipping carton" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "disposed", resolved_reviews: [expect.stringMatching(/^RV-/)] });
    const again = await post(`/v1/units/${units.carton}/review`, { action: "not_a_toy", reason: "empty shipping carton" });
    expect(again.json().status).toBe("disposed");
    const unit = (await get(`/v1/units/${units.carton}`)).json();
    expect(unit.location.path).toBe("Disposed");
    expect(unit.movements[0]).toMatchObject({ type: "DISPOSE", reason: "empty shipping carton" });
    expect((await get("/v1/reviews/summary")).json().flagged).toBe(0);
    expect((await checkIntegrity(ctx.db)).ok).toBe(true);
  });

  it("confirms a low-confidence unit so it leaves the queue", async () => {
    await post(`/v1/units/${units.lowConf}/review`, { action: "confirm" });
    expect((await get("/v1/reviews?kind=low_confidence")).json().total).toBe(0);
  });

  it("corrects a unit onto another catalogue item and logs the edit", async () => {
    const target = (await get(`/v1/units/${units.verifiedProduct}`)).json().catalog.id;
    const res = await post(`/v1/units/${units.good}/review`, { action: "correct", catalog_item_id: target, condition: "Opened" });
    expect(res.json()).toMatchObject({ catalog_item_id: target, status: "active" });
    const edits = await ctx.db.selectFrom("edits").selectAll().where("subject_id", "=", units.good).execute();
    expect(edits).toHaveLength(1);
    expect(await post(`/v1/units/${units.good}/review`, { action: "correct" }).then((r) => r.statusCode)).toBe(400);
  });

  it("verifies a product with a web source, and protects operator corrections", async () => {
    const product = (await get(`/v1/units/${units.lowConf}`)).json().catalog.id;
    const verified = await post(`/v1/catalog/${product}`, { series: "Play Arts Kai", source_url: "https://example.com/noctis" });
    expect(verified.json()).toMatchObject({ verified: true, changed: expect.arrayContaining(["series", "source_url", "verified"]) });
    expect((await get("/v1/search?q=play%20arts%20kai")).json().total).toBe(1); // search index refreshed

    await post(`/v1/catalog/${product}`, { release_year: 2017, by_operator: true });
    const blocked = await post(`/v1/catalog/${product}`, { release_year: 2016 });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toMatch(/corrected by the operator/);
  });

  it("rejects review writes from a viewer session", async () => {
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { password: VIEWER_PASSWORD } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    for (const url of [`/v1/units/${units.good}/review`, "/v1/catalog/CAT-000001"]) {
      const res = await ctx.app.inject({ method: "POST", url, headers: { cookie }, payload: { action: "confirm" } });
      expect(res.statusCode, url).toBe(403);
    }
    expect((await ctx.app.inject({ method: "GET", url: "/v1/reviews/summary", headers: { cookie } })).statusCode).toBe(200);
  });
});
