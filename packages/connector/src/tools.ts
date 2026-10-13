import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BatchId, CATEGORIES, CONDITIONS, Extraction, LocationId, PhotoId, THRESHOLDS } from "@toyvault/shared";
import { z } from "zod";
import { ApiRequestError, RailwayUnreachableError } from "./api-client.js";
import { type ConnectorService, ToolInputError } from "./service.js";

// Tool descriptions are part of the product: they tell Claude in Desktop exactly when to
// call each tool, which thresholds apply, and that IDs only ever come from tool results.

const NO_INVENTED_IDS = "Never invent IDs (TV-, CAT-, PH-, LOC-, B-); use only IDs returned by ToyVault tools.";

type Content = CallToolResult["content"];

const text = (value: unknown): Content[number] => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value, null, 1),
});
const image = (buf: Buffer): Content[number] => ({ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" });

async function run(fn: () => Promise<Content>): Promise<CallToolResult> {
  try {
    return { content: await fn() };
  } catch (err) {
    if (err instanceof RailwayUnreachableError) {
      return {
        isError: true,
        content: [
          text(
            "Railway is unreachable. Nothing was saved and the photos are still in the inbox. " +
              "It is safe to retry the same call once the connection is back.",
          ),
        ],
      };
    }
    if (err instanceof ApiRequestError) {
      return {
        isError: true,
        content: [text({ error: err.message, issues: err.issues, hint: "Fix the listed fields and call the tool again." })],
      };
    }
    if (err instanceof ToolInputError) return { isError: true, content: [text(err.message)] };
    return { isError: true, content: [text(`ToyVault connector error: ${(err as Error).message}`)] };
  }
}

export function registerTools(server: McpServer, svc: ConnectorService) {
  server.registerTool(
    "inbox_folders",
    {
      title: "List inbox folders",
      description:
        "List the dated folders in ~/ToyVault/inbox with how many photos are still unprocessed in each, " +
        "plus any rejected files (only JPG and PNG are accepted; HEIC must be re-exported, or the iPhone camera set to " +
        "'Most Compatible'). Call this at the start of every new chat to see what is left.",
      inputSchema: {},
    },
    () => run(async () => [text({ folders: await svc.folders() })]),
  );

  server.registerTool(
    "inbox_next_batch",
    {
      title: "Get next photo batch",
      description:
        "Pull the next photos from a dated inbox folder so you can see them. Returns each photo's ID (PH-…), " +
        "the preview image, any decoded QR code or barcode, the EXIF capture time, and warnings: " +
        "'already_listed_as' (this exact photo is already on a unit: put it in skipped_photo_ids) and " +
        "'same_shot_pairs' (near-identical photos: if it is the same shot twice, skip one; if it is another angle " +
        "of the same toy, put both in one extraction). Calling it again before units_create returns the same photos. " +
        "Use it for intake and for moves. Photos attached directly in chat cannot be saved; intake and move photos " +
        "must come through this tool.",
      inputSchema: {
        folder: z.string().describe("Dated folder, e.g. '2026-10-13' or '2026-10-13/01-garage-shelf-a'"),
        size: z.number().int().min(1).max(50).optional().describe("Photos per batch (default from config, normally 20)"),
        max_px: z.number().int().min(256).max(2048).optional().describe("Preview size in pixels (default 1024)"),
      },
    },
    ({ folder, size, max_px }) =>
      run(async () => {
        const batch = await svc.nextBatch(folder, size, max_px);
        if (batch.photos.length === 0) {
          return [text({ folder, photos: [], message: "This folder has no unprocessed photos.", rejected_files: batch.rejected_files })];
        }
        const content: Content = [
          text({
            folder,
            photo_count: batch.photos.length,
            remaining_after_batch: batch.remaining_after_batch,
            same_shot_pairs: batch.same_shot_pairs,
            rejected_files: batch.rejected_files,
          }),
        ];
        for (const p of batch.photos) {
          content.push(
            text({
              photo_id: p.photo_id,
              file: p.file,
              captured_at: p.captured_at,
              codes: p.codes,
              already_listed_as: p.already_listed_as,
            }),
            image(p.preview),
          );
        }
        return content;
      }),
  );

  server.registerTool(
    "location_resolve",
    {
      title: "Resolve location",
      description:
        "Turn a location path such as 'Old House › Garage › Shelf A' into a location ID (LOC-…). Missing levels are " +
        "created. Matching is case-insensitive per level. Call this once per batch before units_create. " +
        NO_INVENTED_IDS,
      inputSchema: { path: z.string().min(1).describe("Levels separated by › or >") },
    },
    ({ path }) => run(async () => [text(await svc.resolveLocation(path))]),
  );

  server.registerTool(
    "units_create",
    {
      title: "List toys as units (intake)",
      description:
        "Intake: record one extraction per physical toy from the current batch as new units at the location, " +
        "atomically. Every photo of the batch must appear in an extraction's photo_ids or in skipped_photo_ids. " +
        "Several photos of the same toy go in ONE extraction; a group shot showing several toys appears in several " +
        "extractions. Always set catalog_item_id: use the CAT- ID from catalog_find when the product is already known, " +
        "or from catalog_save after your web check for a new product. Only pass null when you could not identify the " +
        "product at all. A second copy of a known toy is simply another unit on the same catalog_item_id; do not ask. " +
        `Set needs_review only when identity_confidence < ${THRESHOLDS.intakeReview} after your web check, or the ` +
        "category is unclear; low confidence on a minor field never triggers review. " +
        `Categories: ${CATEGORIES.join(", ")}. Conditions: ${CONDITIONS.join(", ")}. ` +
        "On success the photos move to processed/ and you get a receipt with the batch ID (for undo). " +
        "Retrying the same call is safe and returns the original receipt. " +
        NO_INVENTED_IDS,
      inputSchema: {
        folder: z.string().describe("The same folder passed to inbox_next_batch"),
        location_id: LocationId.describe("From location_resolve"),
        instruction: z.string().optional().describe("The operator's instruction line, for the batch record"),
        extractions: z.array(Extraction).describe("One object per toy (classification contract)"),
        skipped_photo_ids: z
          .array(PhotoId)
          .optional()
          .describe("Photos not listed: already listed, or the same shot sent twice"),
        idempotency_key: z
          .uuid()
          .optional()
          .describe("Optional. Omit it: the connector derives a stable key from the folder and photo IDs"),
      },
    },
    (input) =>
      run(async () => {
        const receipt = await svc.createUnits(input);
        return [text(receipt)];
      }),
  );

  server.registerTool(
    "shelf_candidates",
    {
      title: "Shortlist units for move matching",
      description:
        "Move: for each photo, get a contact sheet of the plausible units recorded at the stated source location " +
        "(including cartons there), each tile labelled with its unit ID, shortlisted by QR, catalogue/model number " +
        "you read, and image hash. A second sheet may show close matches ELSEWHERE in the ledger. Decision rules " +
        `(you apply them): QR decoded → that unit, confidence 1.0. Best at source ≥ ${THRESHOLDS.moveAtSource} and ` +
        "one catalogue item clearly ahead → move it. Several identical copies at source → move one, mark fungible. " +
        `Nothing at source ≥ ${THRESHOLDS.moveAtSource} but a unit elsewhere matches → do NOT move; raise it as a ` +
        "review question. Nothing anywhere → ask 'new toy or missed intake?'; never create units in move mode. " +
        NO_INVENTED_IDS,
      inputSchema: {
        from: LocationId.describe("Source location ID from location_resolve"),
        photos: z
          .array(
            z.object({
              photo_id: PhotoId,
              model_number: z.string().optional().describe("Model/SKU number you read on the packaging, if any"),
              catalog_item_id: z.string().optional().describe("CAT- ID if you already know the catalogue item"),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    ({ from, photos }) =>
      run(async () => {
        const results = await svc.shelfCandidates(from, photos);
        const content: Content = [];
        for (const r of results) {
          const brief = (c: (typeof r.at_source)[number]) => ({
            unit_id: c.unit_id,
            item: c.item_name,
            series: c.series,
            model: c.model_number,
            location: c.location_path,
            identity: c.identity,
            phash_distance: c.phash_distance,
            matched_by: c.matched_by,
          });
          content.push(text({ photo_id: r.photo_id, at_source: r.at_source.map(brief), elsewhere: r.elsewhere.map(brief) }));
          if (r.sheet) content.push(image(r.sheet));
          if (r.elsewhere_sheet) content.push(image(r.elsewhere_sheet));
          if (!r.sheet && !r.elsewhere_sheet) content.push(text(`No candidates for ${r.photo_id}.`));
        }
        return content;
      }),
  );

  server.registerTool(
    "catalog_find",
    {
      title: "Find a product in the catalogue",
      description:
        "Look up products already in the ToyVault catalogue before any web search. Pass the model/SKU number, " +
        "barcode digits and/or the name and series text you read on the packaging. Results are ordered by exact " +
        "model number, then barcode, then text; each shows how many units already use it. If one result is clearly " +
        "the product in the photo, reuse its CAT- ID in units_create and skip the web search. If none fits, do one " +
        "web search for the product, then catalog_save. Group the batch's lookups; call it once per distinct product. " +
        NO_INVENTED_IDS,
      inputSchema: {
        model_number: z.string().optional().describe("Model, set or SKU number as printed"),
        barcode: z.string().optional().describe("UPC/EAN digits"),
        text: z.string().optional().describe("Brand, series and item name as read"),
      },
    },
    (input) => run(async () => [text(await svc.findCatalog(input))]),
  );

  server.registerTool(
    "catalog_save",
    {
      title: "Save a new product to the catalogue",
      description:
        "Store a product you identified that catalog_find did not know, with the source URL from your web check " +
        "(a maker page, set database or collector wiki). Items with a source URL are marked verified; without one " +
        "they are stored unverified and still usable. Returns the CAT- ID to put in units_create. Calling it again " +
        "with the same fields returns the same ID. Never overwrite a product the operator corrected by hand. " +
        `Categories: ${CATEGORIES.join(", ")}.`,
      inputSchema: {
        category: z.enum(CATEGORIES),
        brand: z.string().default(""),
        franchise: z.string().default(""),
        series: z.string().default(""),
        wave: z.string().default(""),
        item_name: z.string().min(1),
        model_number: z.string().default(""),
        barcode: z.string().default(""),
        scale: z.string().default(""),
        release_year: z.number().int().min(1900).max(2100).nullable().default(null),
        release_year_source: z.enum(["ocr", "web", "inferred"]).nullable().default(null),
        source_url: z.url().nullable().default(null).describe("The page you used to confirm the product"),
        field_confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
      },
    },
    (input) => run(async () => [text(await svc.saveCatalog(input))]),
  );

  server.registerTool(
    "search",
    {
      title: "Search the inventory",
      description:
        "Answer 'where is …' questions: search units by name, series, brand, franchise, model number, text read " +
        "from packaging, notes or location. Partial words and short forms work ('turbo rac s3'); typos are " +
        "corrected. If the operator attached a photo in chat, read it and search with the text you see. Returns a " +
        "list with locations plus one contact sheet of thumbnails labelled with unit IDs. Nothing is recorded.",
      inputSchema: {
        query: z.string().default("").describe("Free text"),
        category: z.array(z.enum(CATEGORIES)).optional(),
        brand: z.array(z.string()).optional(),
        series: z.array(z.string()).optional(),
        location_id: LocationId.optional().describe("Only units at this location or below it"),
        in_transit: z.boolean().optional(),
        unverified: z.boolean().optional().describe("Only flagged or unverified units"),
        limit: z.number().int().min(1).max(60).default(24),
      },
    },
    (input) =>
      run(async () => {
        const { result, sheet } = await svc.search({
          q: input.query,
          category: input.category?.join(","),
          brand: input.brand?.join(","),
          series: input.series?.join(","),
          location: input.location_id,
          in_transit: input.in_transit ? "true" : undefined,
          unverified: input.unverified ? "true" : undefined,
          limit: input.limit,
        });
        const content: Content = [
          text({
            total: result.total,
            showing: result.hits.length,
            hits: result.hits.map((h) => ({
              unit_id: h.unit_id,
              item: h.item_name,
              series: h.series,
              brand: h.brand,
              condition: h.condition,
              location: h.location_path,
              flagged: h.needs_review,
            })),
          }),
        ];
        if (sheet) content.push(image(sheet));
        return content;
      }),
  );

  server.registerTool(
    "undo_batch",
    {
      title: "Undo a batch",
      description:
        "Reverse a whole batch by its B- ID (from a receipt) with compensating movements. Nothing is deleted: " +
        "units listed by an undone intake are marked disposed (reason 'undo') and their photos can be listed again; " +
        "moves go back where they came from. Only call this when the operator explicitly asks to undo a batch. " +
        "If a unit has moved again since, the undo is refused; undo the later batch first. Safe to repeat.",
      inputSchema: { batch_id: BatchId },
    },
    ({ batch_id }) => run(async () => [text(await svc.undoBatch(batch_id))]),
  );
}
