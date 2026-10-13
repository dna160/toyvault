import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIntegrity } from "../../api/src/integrity.js";
import type { Storage } from "../../api/src/storage.js";
import { TOKEN, type TestContext, setup, teardown } from "../../api/test/helpers.js";
import { ApiClient, RailwayUnreachableError } from "../src/api-client.js";
import type { ConnectorConfig } from "../src/config.js";
import { ConnectorService } from "../src/service.js";
import { toyPhoto, writeInbox } from "./fixtures.js";

/** Bucket stand-in reachable over HTTP, so the connector's presigned PUTs really happen. */
class HttpBucket implements Storage {
  objects = new Map<string, Buffer>();
  server: Server = createServer((req, res) => {
    const [, verb, ...rest] = (req.url ?? "").split("/");
    const key = decodeURIComponent(rest.join("/"));
    if (req.method === "PUT" && verb === "put") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        this.objects.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
      return;
    }
    const body = this.objects.get(key);
    if (req.method === "GET" && verb === "get" && body) return void res.writeHead(200).end(body);
    res.writeHead(404).end();
  });
  base = "";
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async presignPut(key: string) {
    return `${this.base}/put/${encodeURIComponent(key)}`;
  }
  async presignGet(key: string) {
    return `${this.base}/get/${encodeURIComponent(key)}`;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

let ctx: TestContext;
let bucket: HttpBucket;
let apiUrl: string;
let root: string;
let svc: ConnectorService;

function config(apiBaseUrl: string): ConnectorConfig {
  return {
    apiBaseUrl,
    token: TOKEN,
    batchSize: 20,
    previewPx: 1024,
    root,
    inboxDir: join(root, "inbox"),
    processedDir: join(root, "processed"),
  };
}

beforeAll(async () => {
  bucket = new HttpBucket();
  await bucket.start();
  ctx = await setup(bucket);
  await (ctx.app as FastifyInstance).listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "toyvault-"));
  svc = new ConnectorService(config(apiUrl), new ApiClient(apiUrl, TOKEN));
  await ctx.db.insertInto("id_reservations").values({ unit_id: "TV-900001", used_at: null }).execute();
});

afterAll(async () => {
  bucket.server.close();
  await teardown(ctx);
  rmSync(root, { recursive: true, force: true });
});

describe("golden path: inbox → connector → API → Postgres", () => {
  let racerUnit = "";

  it("lists, uploads, commits and archives an intake batch", async () => {
    writeInbox(root, "2026-10-13", {
      "IMG_0001.jpg": await toyPhoto({ color: "#2a6fdb", label: "RACER" }),
      "IMG_0002.jpg": await toyPhoto({ color: "#2a6fdb", label: "RACER", shift: 40 }), // another angle
      "IMG_0003.jpg": await toyPhoto({ color: "#f0c419", label: "DOLL", qr: "TV-900001", shift: 300 }),
      "IMG_0004.HEIC": Buffer.from("not supported"),
    });

    expect(await svc.folders()).toEqual([
      { folder: "2026-10-13", unprocessed: 3, rejected: ["2026-10-13/IMG_0004.HEIC"] },
    ]);

    const batch = await svc.nextBatch("2026-10-13");
    expect(batch.photos).toHaveLength(3);
    const [p1, p2, p3] = batch.photos.map((p) => p.photo_id) as [string, string, string];
    expect(batch.photos[2]!.codes).toContainEqual({ format: "QRCode", text: "TV-900001" });

    // Stubbed Claude decisions.
    const shelf = await svc.resolveLocation("Old House › Garage › Shelf A");
    const input = {
      folder: "2026-10-13",
      location_id: shelf.id,
      instruction: "Intake 2026-10-13. Location: Old House › Garage › Shelf A",
      extractions: [
        stub([p1, p2], { item_name: "Night Shifter", series: "Turbo Racers Series 3", model_number: "GTB12" }),
        stub([p3], { item_name: "Sunny Doll", category: "Doll", qr: "TV-900001" }),
      ],
    };
    const receipt = await svc.createUnits(input);
    expect(receipt.listed.map((l) => l.photo_ids)).toEqual([[p1, p2], [p3]]);
    expect(receipt.listed[1]!.unit_id).toBe("TV-900001");
    expect(receipt.moved_to_processed).toBe(3);
    expect(receipt.remaining_in_folder).toBe(0);
    racerUnit = receipt.listed[0]!.unit_id;

    // Files archived locally; originals, previews and thumbnails in the bucket.
    expect(readdirSync(join(root, "processed", "2026-10-13")).sort()).toEqual(["IMG_0001.jpg", "IMG_0002.jpg", "IMG_0003.jpg"]);
    expect([...bucket.objects.keys()].filter((k) => k.endsWith("original.jpg"))).toHaveLength(3);

    // A retried call replays the receipt; nothing new is created.
    const again = await svc.createUnits(input);
    expect(again.replayed).toBe(true);
    expect(again.batch_id).toBe(receipt.batch_id);

    const unit = await ctx.db
      .selectFrom("unit_current_location as u")
      .innerJoin("locations as l", "l.id", "u.location_id")
      .select("l.path")
      .where("u.unit_id", "=", racerUnit)
      .executeTakeFirstOrThrow();
    expect(unit.path).toBe("Old House › Garage › Shelf A");
    expect((await checkIntegrity(ctx.db)).ok).toBe(true);
  });

  it("rejects a batch that leaves photos unaccounted for", async () => {
    writeInbox(root, "2026-10-14", {
      "a.jpg": await toyPhoto({ color: "#884488", label: "ROBOT" }),
      "b.jpg": await toyPhoto({ color: "#448844", label: "TRAIN", shift: 250 }),
    });
    const batch = await svc.nextBatch("2026-10-14");
    const shelf = await svc.resolveLocation("Old House › Garage › Shelf A");
    await expect(
      svc.createUnits({ folder: "2026-10-14", location_id: shelf.id, extractions: [stub([batch.photos[0]!.photo_id])] }),
    ).rejects.toThrow(/Missing: PH-/);
    expect(existsSync(join(root, "inbox", "2026-10-14", "a.jpg"))).toBe(true);
  });

  it("shortlists the right unit at the source for a move photo", async () => {
    writeInbox(root, "2026-11-15", { "move1.jpg": await toyPhoto({ color: "#2a6fdb", label: "RACER", shift: 10 }) });
    const batch = await svc.nextBatch("2026-11-15");
    const shelf = await svc.resolveLocation("Old House › Garage › Shelf A");
    const [result] = await svc.shelfCandidates(shelf.id, [{ photo_id: batch.photos[0]!.photo_id, model_number: "GTB12" }]);
    expect(result!.at_source[0]!.unit_id).toBe(racerUnit);
    expect(result!.at_source[0]!.matched_by).toContain("catalog");
    expect(result!.sheet).toBeInstanceOf(Buffer);
  });

  it("reuses the catalogue, finds units by search, and undoes a batch", async () => {
    // Claude saves a product after its web check, then a second photo reuses it.
    const saved = await svc.saveCatalog({
      category: "Die-cast vehicle",
      brand: "INNO Models",
      franchise: "",
      series: "INNO64",
      wave: "",
      item_name: "Liberty Walk F40",
      model_number: "IN64-LBWK-F40",
      barcode: "",
      scale: "1:64",
      release_year: 2023,
      release_year_source: "web",
      source_url: "https://example.com/inno64-f40",
      field_confidence: {},
    });
    const again = await svc.saveCatalog({
      category: "Die-cast vehicle",
      brand: "inno models",
      franchise: "",
      series: "INNO64",
      wave: "",
      item_name: "Liberty Walk F40",
      model_number: "IN64 LBWK F40",
      barcode: "",
      scale: "1:64",
      release_year: 2023,
      release_year_source: "web",
      source_url: "https://example.com/inno64-f40",
      field_confidence: {},
    });
    expect(again.id).toBe(saved.id);
    expect((await svc.findCatalog({ model_number: "in64-lbwk-f40" })).items[0]!.id).toBe(saved.id);

    writeInbox(root, "2026-10-21", {
      "f40-a.jpg": await toyPhoto({ color: "#1b1b1b", label: "F40", shift: 120 }),
      "f40-b.jpg": await toyPhoto({ color: "#eeeeee", label: "F40 #2", shift: 420 }),
    });
    const batch = await svc.nextBatch("2026-10-21");
    const shelf = await svc.resolveLocation("Mirae › Office");
    const receipt = await svc.createUnits({
      folder: "2026-10-21",
      location_id: shelf.id,
      extractions: batch.photos.map((p) =>
        stub([p.photo_id], { item_name: "Liberty Walk F40", series: "INNO64", catalog_item_id: saved.id }),
      ),
    });
    expect(receipt.listed.map((l) => l.catalog_item_id)).toEqual([saved.id, saved.id]);

    const found = await svc.search({ q: "liberty walk", limit: 10 });
    expect(found.result.total).toBe(2);
    expect(found.result.hits[0]!.location_path).toBe("Mirae › Office");
    expect(found.sheet).toBeInstanceOf(Buffer);

    const undone = await svc.undoBatch(receipt.batch_id);
    expect(undone.disposed_units.sort()).toEqual(receipt.listed.map((l) => l.unit_id).sort());
    expect((await svc.search({ q: "liberty walk" })).result.total).toBe(0);
    expect((await checkIntegrity(ctx.db)).ok).toBe(true);
  });

  it("fails cleanly when Railway is unreachable and leaves photos in the inbox", async () => {
    writeInbox(root, "2026-10-20", { "x.jpg": await toyPhoto({ color: "#aa2222", label: "TANK" }) });
    const offline = new ConnectorService(config("http://127.0.0.1:9"), new ApiClient("http://127.0.0.1:9", TOKEN));
    await expect(offline.nextBatch("2026-10-20")).rejects.toBeInstanceOf(RailwayUnreachableError);
    expect(existsSync(join(root, "inbox", "2026-10-20", "x.jpg"))).toBe(true);
  });
});

function stub(photoIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    photo_ids: photoIds,
    qr: null,
    barcode: null,
    ocr_text: ["SAMPLE TEXT"],
    category: "Die-cast vehicle" as const,
    brand: "Hot Wheels",
    franchise: "",
    series: "",
    wave: "",
    item_name: "",
    model_number: "",
    scale: "1:64",
    release_year: 2019,
    release_year_source: "ocr" as const,
    condition: "Sealed" as const,
    catalog_item_id: null,
    web_source_url: null,
    field_confidence: {},
    identity_confidence: 0.93,
    needs_review: false,
    review_reason: null,
    notes: "",
    ...overrides,
  };
}
