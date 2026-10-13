import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIntegrity } from "../src/integrity.js";
import {
  type TestContext,
  VIEWER_PASSWORD,
  auth,
  extraction,
  intake,
  registerUploaded,
  resolveLocation,
  setup,
  teardown,
} from "./helpers.js";

let ctx: TestContext;
let shelf: string;
let study: string;

beforeAll(async () => {
  ctx = await setup();
  shelf = await resolveLocation(ctx, "Old House › Garage › Shelf A");
  study = await resolveLocation(ctx, "New House › Study › Cabinet 2");
  const photos = await registerUploaded(ctx, 4);
  await intake(ctx, shelf, [
    extraction([photos[0]!], { item_name: "Night Comet", series: "Turbo Racers Series 3", brand: "Hot Wheels", model_number: "TR3-07" }),
    extraction([photos[1]!], {
      item_name: "Lightning",
      category: "Action figure",
      brand: "Square Enix",
      series: "Play Arts Kai Final Fantasy XIII",
      model_number: "PAK-FF13",
      ocr_text: ["PLAY ARTS KAI", "LIGHTNING"],
    }),
  ]);
  await intake(ctx, study, [
    extraction([photos[2]!], { item_name: "Plush Fox", category: "Plush", brand: "Plushie Pals", series: "", model_number: "", ocr_text: [] }),
    extraction([photos[3]!], {
      item_name: "Mystery carton",
      ocr_text: [],
      category: "Other",
      brand: "",
      series: "",
      model_number: "",
      identity_confidence: 0.3,
      needs_review: true,
      review_reason: "contents not visible",
    }),
  ]);
});
afterAll(async () => teardown(ctx));

const get = (url: string, headers: Record<string, string> = auth) => ctx.app.inject({ method: "GET", url, headers });

describe("search", () => {
  it("finds abbreviated, partial queries (turbo rac s3)", async () => {
    const res = await get("/v1/search?q=turbo%20rac%20s3");
    expect(res.statusCode).toBe(200);
    expect(res.json().hits.map((h: { item_name: string }) => h.item_name)).toEqual(["Night Comet"]);
    expect(res.json().hits[0].location_path).toBe("Old House › Garage › Shelf A");
    expect(res.json().hits[0].thumb_url).toBeTruthy();
  });

  it("searches OCR text and location path", async () => {
    expect((await get("/v1/search?q=lightning")).json().total).toBe(1);
    expect((await get("/v1/search?q=study%20cabinet")).json().total).toBe(2);
  });

  it("falls back to fuzzy matching for typos", async () => {
    const res = await get("/v1/search?q=lightnig");
    expect(res.json().hits.map((h: { item_name: string }) => h.item_name)).toContain("Lightning");
  });

  it("filters by category, location subtree and unverified, with facet counts", async () => {
    const byCat = (await get("/v1/search?category=Plush")).json();
    expect(byCat.total).toBe(1);
    expect(byCat.facets.category.length).toBeGreaterThan(1); // facets ignore chip filters

    const newHouse = (await get(`/v1/search?location=${(await resolveLocation(ctx, "New House"))}`)).json();
    expect(newHouse.total).toBe(2);

    const unverified = (await get("/v1/search?unverified=true")).json();
    expect(unverified.total).toBe(4); // none have a web source; one is also flagged
  });
});

describe("catalogue", () => {
  it("saves idempotently and finds by normalised model number", async () => {
    const body = {
      category: "Die-cast vehicle",
      brand: "INNO Models",
      series: "INNO64",
      item_name: "Liberty Walk F40",
      model_number: "IN64-LBWK-F40",
      source_url: "https://example.com/f40",
      client_key: "catalog:test:f40",
    };
    const a = await ctx.app.inject({ method: "POST", url: "/v1/catalog", headers: auth, payload: body });
    const b = await ctx.app.inject({ method: "POST", url: "/v1/catalog", headers: auth, payload: body });
    expect(a.json().created).toBe(true);
    expect(b.json()).toEqual({ id: a.json().id, created: false });

    const found = (await get("/v1/catalog?model=in64%20lbwk%20f40")).json();
    expect(found.items[0]).toMatchObject({ id: a.json().id, verified: true, matched_by: ["model"] });

    const byText = (await get("/v1/catalog?q=liberty%20walk")).json();
    expect(byText.items.map((i: { id: string }) => i.id)).toContain(a.json().id);
  });
});

describe("undo", () => {
  it("disposes the batch's units with compensating movements, frees photos, and replays", async () => {
    const [p] = await registerUploaded(ctx, 1);
    const listed = (await intake(ctx, shelf, [extraction([p!], { item_name: "Undo me" })])).json();
    const unitId = listed.listed[0].unit_id;

    const undo = await ctx.app.inject({ method: "POST", url: `/v1/batches/${listed.batch_id}/undo`, headers: auth });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({ reversed_movements: 1, disposed_units: [unitId], replayed: false });

    const again = await ctx.app.inject({ method: "POST", url: `/v1/batches/${listed.batch_id}/undo`, headers: auth });
    expect(again.json().replayed).toBe(true);

    const unit = (await get(`/v1/units/${unitId}`)).json();
    expect(unit.status).toBe("disposed");
    expect(unit.location.path).toBe("Disposed");
    expect(unit.movements.map((m: { type: string }) => m.type)).toEqual(["DISPOSE", "RECEIPT"]);

    // Not in active search results any more, but the photo can be listed again.
    expect((await get("/v1/search?q=undo%20me")).json().total).toBe(0);
    const redo = (await intake(ctx, shelf, [extraction([p!], { item_name: "Undo me" })])).json();
    expect(redo.listed).toHaveLength(1);
    expect((await checkIntegrity(ctx.db)).ok).toBe(true);
  });
});

describe("read models", () => {
  it("returns the location tree with counts and virtual locations pinned", async () => {
    const tree = (await get("/v1/locations/tree")).json();
    expect(tree.roots.slice(0, 2).map((r: { path: string }) => r.path)).toEqual(["In transit", "Unknown"]);
    const old = tree.roots.find((r: { path: string }) => r.path === "Old House");
    expect(old.subtree_count).toBeGreaterThanOrEqual(2);
  });

  it("lists batches with counts and thumbnails, newest first", async () => {
    const { batches } = (await get("/v1/batches")).json();
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.some((b: { status: string }) => b.status === "undone")).toBe(true);
    expect(batches.at(-1).counts.listed).toBe(2);
  });

  it("shows unit detail with other copies and stats", async () => {
    const [p1, p2] = await registerUploaded(ctx, 2);
    const first = (await intake(ctx, shelf, [extraction([p1!], { item_name: "Twin" })])).json().listed[0];
    await intake(ctx, study, [extraction([p2!], { item_name: "Twin", catalog_item_id: first.catalog_item_id })]);
    const unit = (await get(`/v1/units/${first.unit_id}`)).json();
    expect(unit.other_copies).toHaveLength(1);
    expect(unit.other_copies[0].location_path).toBe("New House › Study › Cabinet 2");
    expect(unit.photos[0].preview_url).toBeTruthy();
    const stats = (await get("/v1/stats")).json();
    expect(stats.open_reviews).toBe(1);
  });
});

describe("viewer auth boundary", () => {
  async function viewerCookie() {
    const res = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { password: VIEWER_PASSWORD } });
    expect(res.statusCode).toBe(200);
    return String(res.headers["set-cookie"]).split(";")[0]!;
  }

  it("rejects a wrong password", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { password: "nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("lets a viewer session read", async () => {
    const cookie = await viewerCookie();
    expect((await get("/v1/search?q=comet", { cookie })).statusCode).toBe(200);
    expect((await get("/auth/me", { cookie })).json()).toEqual({ principal: "viewer", scope: "read" });
  });

  it("rejects every write route for a viewer session", async () => {
    const cookie = await viewerCookie();
    const writes = [
      "/v1/photos",
      "/v1/photos/presign",
      "/v1/locations/resolve",
      "/v1/intake-batches",
      "/v1/catalog",
      "/v1/batches/B-0001/undo",
    ];
    for (const url of writes) {
      const res = await ctx.app.inject({ method: "POST", url, headers: { cookie }, payload: {} });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("rejects tampered or missing sessions", async () => {
    expect((await get("/v1/search")).statusCode).toBe(200);
    expect((await get("/v1/search", {})).statusCode).toBe(401);
    const cookie = await viewerCookie();
    const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await get("/v1/search", { cookie: tampered })).statusCode).toBe(401);
  });
});
