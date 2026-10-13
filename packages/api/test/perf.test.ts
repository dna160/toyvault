import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestContext, auth, resolveLocation, setup, teardown } from "./helpers.js";

// Master prompt §10: search p95 < 300 ms at 10,000 units (and ~15,000 photos).
let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
  const shelves = await Promise.all(
    ["Old House › Garage › Shelf A", "Old House › Garage › Shelf B", "Old House › Study", "New House › Study › Cabinet 2"].map((p) =>
      resolveLocation(ctx, p),
    ),
  );
  await sql`
    INSERT INTO batches (mode, client_key, counts) VALUES ('intake', 'perf-seed', '{}');
    INSERT INTO catalog_items (category, brand, series, wave, item_name, model_number)
    SELECT (ARRAY['Die-cast vehicle','Action figure','Model kit','Plush','Blind box'])[1 + i % 5],
           (ARRAY['Hot Wheels','Bandai','Banpresto','Square Enix','LEGO','Good Smile'])[1 + i % 6],
           (ARRAY['Turbo Racers Series ','Mecha Guardians Wave ','J Stars WCF Vol. ','Play Arts Kai ','Blind Box Garden S'])[1 + i % 5] || (1 + i % 9),
           '', 'Item ' || i || ' ' || md5(i::text), 'M-' || i
      FROM generate_series(1, 3000) i;
    INSERT INTO units (catalog_item_id, condition, created_batch_id)
    SELECT tv_id('CAT', 1 + (i % 3000), 6), (ARRAY['Sealed','Opened','Loose complete'])[1 + i % 3], 'B-0001'
      FROM generate_series(1, 10000) i;
    INSERT INTO photos (sha256, phash, thumb_key, ocr_text)
    SELECT md5(i::text) || md5((i * 7)::text), (floor(random() * 9e15)::bigint)::bit(64), 'photos/x/thumb.jpg',
           ARRAY['PACKAGING LINE ' || i, 'COLLECT THEM ALL']
      FROM generate_series(1, 15000) i;
    INSERT INTO unit_photos (unit_id, photo_id, role, batch_id)
    SELECT tv_id('TV', 1 + (i % 10000), 6), tv_id('PH', i, 6), 'intake', 'B-0001' FROM generate_series(1, 15000) i;
  `.execute(ctx.db);
  await sql`
    INSERT INTO movements (type, unit_id, to_location_id, batch_id, idempotency_key)
    SELECT 'RECEIPT', u.id, (${sql.val(shelves)}::text[])[1 + (row_number() OVER () % 4)::int], 'B-0001', 'perf:' || u.id
      FROM units u
  `.execute(ctx.db);
  await sql`
    INSERT INTO stock_position (subject_type, subject_id, location_id, last_movement_id)
    SELECT 'unit', unit_id, to_location_id, id FROM movements;
    SELECT refresh_unit_search(array_agg(id)) FROM units;
    ANALYZE;
  `.execute(ctx.db);
}, 120_000);
afterAll(async () => teardown(ctx));

describe("search performance at 10,000 units", () => {
  it("keeps p95 under 300 ms", async () => {
    const queries = [
      "turbo rac s3",
      "bandai",
      "mecha guardians w4",
      "item 4242",
      "j stars vol 2",
      "garage shelf a",
      "collect them",
      "play arts",
      "sealed",
      "lego",
      "",
      "itme 12", // fuzzy fallback
    ];
    const urls = queries.flatMap((q) => [
      `/v1/search?q=${encodeURIComponent(q)}`,
      `/v1/search?q=${encodeURIComponent(q)}&category=Model%20kit&limit=120`,
      `/v1/search?q=${encodeURIComponent(q)}&unverified=true&offset=60`,
    ]);
    for (const url of urls.slice(0, 5)) await ctx.app.inject({ method: "GET", url, headers: auth }); // warm up

    const times: number[] = [];
    for (const url of urls) {
      const t = performance.now();
      const res = await ctx.app.inject({ method: "GET", url, headers: auth });
      times.push(performance.now() - t);
      if (process.env.PERF_DEBUG) console.log(Math.round(performance.now() - t), url);
      expect(res.statusCode).toBe(200);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`search p50 ${times[Math.floor(times.length / 2)]!.toFixed(0)} ms · p95 ${p95.toFixed(0)} ms (${times.length} queries)`);
    expect(p95).toBeLessThan(300);

    const s3 = (await ctx.app.inject({ method: "GET", url: "/v1/search?q=turbo%20rac%20s3", headers: auth })).json();
    expect(s3.total).toBeGreaterThan(0);
    expect(s3.hits.every((h: { series: string }) => h.series === "Turbo Racers Series 3")).toBe(true);
  }, 120_000);
});
