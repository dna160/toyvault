import { describe, expect, it } from "vitest";
import { Extraction, splitLocationPath } from "./index.js";

const valid = {
  photo_ids: ["PH-000001"],
  category: "Plush",
  condition: "Opened",
  identity_confidence: 0.9,
};

describe("classification contract", () => {
  it("fills defaults for optional fields", () => {
    const e = Extraction.parse(valid);
    expect(e).toMatchObject({ qr: null, brand: "", needs_review: false, catalog_item_id: null, ocr_text: [] });
  });

  it("rejects invented or malformed IDs", () => {
    const r = Extraction.safeParse({ ...valid, photo_ids: ["photo-1"], catalog_item_id: "CAT-12" });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join("."))).toEqual(["photo_ids.0", "catalog_item_id"]);
  });

  it("requires a review reason when flagged, alongside other errors", () => {
    const r = Extraction.safeParse({ ...valid, category: "Rocket", needs_review: true });
    expect(r.error!.issues.map((i) => i.path.join("."))).toEqual(["category", "review_reason"]);
  });

  it("only accepts the fixed category and condition lists", () => {
    expect(Extraction.safeParse({ ...valid, condition: "Mint" }).success).toBe(false);
  });
});

describe("location paths", () => {
  it("splits on › or > and normalises whitespace", () => {
    expect(splitLocationPath(" Old House ›Garage >  Shelf  A ")).toEqual(["Old House", "Garage", "Shelf A"]);
  });
});
