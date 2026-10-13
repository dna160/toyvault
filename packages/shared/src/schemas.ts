import { z } from "zod";
import { CATEGORIES, CONDITIONS } from "./config.js";
import { ID_PATTERNS } from "./ids.js";

const id = (kind: keyof typeof ID_PATTERNS) =>
  z.string().regex(ID_PATTERNS[kind], `must be a ${kind} ID returned by a ToyVault tool`);

export const UnitId = id("unit");
export const CatalogId = id("catalog");
export const PhotoId = id("photo");
export const LocationId = id("location");
export const BatchId = id("batch");

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const phash = z.string().regex(/^[0-9a-f]{16}$/);
const confidence = z.number().min(0).max(1);

// ---------- Classification contract (master prompt §8), one object per toy ----------

export const Extraction = z
  .object({
    photo_ids: z.array(PhotoId).min(1),
    qr: z.string().nullable().default(null),
    barcode: z.string().nullable().default(null),
    ocr_text: z.array(z.string()).default([]),
    category: z.enum(CATEGORIES),
    brand: z.string().default(""),
    franchise: z.string().default(""),
    series: z.string().default(""),
    wave: z.string().default(""),
    item_name: z.string().default(""),
    model_number: z.string().default(""),
    scale: z.string().default(""),
    release_year: z.number().int().min(1900).max(2100).nullable().default(null),
    release_year_source: z.enum(["ocr", "web", "inferred"]).nullable().default(null),
    condition: z.enum(CONDITIONS),
    catalog_item_id: CatalogId.nullable().default(null),
    web_source_url: z.url().nullable().default(null),
    field_confidence: z.record(z.string(), confidence).default({}),
    identity_confidence: confidence,
    needs_review: z.boolean().default(false),
    review_reason: z.string().nullable().default(null),
    notes: z.string().default(""),
  })
  .refine((e) => !e.needs_review || (e.review_reason && e.review_reason.length > 0), {
    message: "review_reason is required when needs_review is true",
    path: ["review_reason"],
    // Report this alongside other field errors so Claude can fix everything in one pass.
    when: (payload) =>
      payload.issues.every((i) => i.path?.[0] !== "needs_review" && i.path?.[0] !== "review_reason"),
  });
export type Extraction = z.infer<typeof Extraction>;

// ---------- Photos ----------

export const PhotoRegisterItem = z.object({
  sha256,
  phash,
  captured_at: z.iso.datetime({ offset: true }).nullable(),
  source_folder: z.string(),
  filename: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const PhotoRegisterRequest = z.object({ photos: z.array(PhotoRegisterItem).min(1).max(200) });
export type PhotoRegisterRequest = z.infer<typeof PhotoRegisterRequest>;

export const PhotoRegisterResult = z.object({
  id: PhotoId,
  sha256,
  upload_status: z.enum(["registered", "uploaded"]),
  /** Active units this photo is already linked to. Non-empty means "already listed". */
  active_units: z.array(UnitId),
});
export const PhotoRegisterResponse = z.object({ photos: z.array(PhotoRegisterResult) });
export type PhotoRegisterResponse = z.infer<typeof PhotoRegisterResponse>;

export const PresignRequest = z.object({
  photos: z
    .array(z.object({ photo_id: PhotoId, original_content_type: z.enum(["image/jpeg", "image/png"]) }))
    .min(1)
    .max(200),
});
export type PresignRequest = z.infer<typeof PresignRequest>;

const signed = z.object({ key: z.string(), url: z.string() });
export const PresignResponse = z.object({
  photos: z.array(z.object({ photo_id: PhotoId, original: signed, preview: signed, thumb: signed })),
});
export type PresignResponse = z.infer<typeof PresignResponse>;

// ---------- Locations ----------

export const LocationResolveRequest = z.object({ path: z.string().min(1) });
export const LocationResolveResponse = z.object({
  id: LocationId,
  path: z.string(),
  created: z.boolean(),
});
export type LocationResolveResponse = z.infer<typeof LocationResolveResponse>;

// ---------- Intake ----------

export const IntakeBatchRequest = z.object({
  client_key: z.uuid(),
  folder: z.string(),
  instruction: z.string().default(""),
  location_id: LocationId,
  extractions: z.array(Extraction).max(200),
  skipped_photo_ids: z.array(PhotoId).default([]),
});
export type IntakeBatchRequest = z.input<typeof IntakeBatchRequest>;

export const IntakeReceipt = z.object({
  batch_id: BatchId,
  location_id: LocationId,
  location_path: z.string(),
  listed: z.array(
    z.object({
      unit_id: UnitId,
      catalog_item_id: CatalogId,
      photo_ids: z.array(PhotoId),
      item_name: z.string(),
      flagged: z.boolean(),
    }),
  ),
  flagged_count: z.number().int(),
  skipped: z.array(
    z.object({
      photo_ids: z.array(PhotoId),
      reason: z.enum(["already_listed", "same_shot"]),
      unit_id: UnitId.nullable(),
    }),
  ),
  replayed: z.boolean(),
});
export type IntakeReceipt = z.infer<typeof IntakeReceipt>;

// ---------- Candidates (move matching inputs) ----------

export const CandidatesQuery = z.object({
  location: LocationId,
  catalog: z.string().optional(), // comma-separated CAT ids
  model: z.string().optional(),
  qr: z.string().optional(),
  phash: phash.optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

export const Candidate = z.object({
  unit_id: UnitId,
  catalog_item_id: CatalogId,
  item_name: z.string(),
  brand: z.string(),
  series: z.string(),
  model_number: z.string(),
  condition: z.string(),
  identity: z.enum(["distinct", "fungible"]),
  location_id: LocationId,
  location_path: z.string(),
  thumb_url: z.string().nullable(),
  phash_distance: z.number().int().nullable(),
  matched_by: z.array(z.enum(["qr", "catalog", "model", "phash", "location"])),
});
export type Candidate = z.infer<typeof Candidate>;

export const CandidatesResponse = z.object({
  at_source: z.array(Candidate),
  elsewhere: z.array(Candidate),
});
export type CandidatesResponse = z.infer<typeof CandidatesResponse>;

// ---------- Units ----------

export const UnitDetail = z.object({
  id: UnitId,
  status: z.string(),
  status_reason: z.string().nullable(),
  identity: z.string(),
  condition: z.string(),
  notes: z.string(),
  needs_review: z.boolean(),
  review_reason: z.string().nullable(),
  identity_confidence: z.number().nullable(),
  created_at: z.string(),
  created_batch_id: z.string().nullable(),
  catalog: z.object({
    id: CatalogId,
    category: z.string(),
    brand: z.string(),
    franchise: z.string(),
    series: z.string(),
    wave: z.string(),
    item_name: z.string(),
    model_number: z.string(),
    barcode: z.string(),
    scale: z.string(),
    release_year: z.number().nullable(),
    release_year_source: z.string().nullable(),
    verified: z.boolean(),
    source_url: z.string().nullable(),
    field_confidence: z.record(z.string(), z.number()),
  }),
  location: z.object({ id: LocationId, path: z.string() }),
  container_id: z.string().nullable(),
  photos: z.array(
    z.object({
      id: PhotoId,
      role: z.string(),
      captured_at: z.string().nullable(),
      thumb_url: z.string().nullable(),
      preview_url: z.string().nullable(),
      ocr_text: z.array(z.string()),
    }),
  ),
  movements: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      from_path: z.string().nullable(),
      to_path: z.string().nullable(),
      to_container_id: z.string().nullable(),
      batch_id: z.string().nullable(),
      method: z.string().nullable(),
      confidence: z.number().nullable(),
      reason: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  other_copies: z.array(
    z.object({
      id: UnitId,
      condition: z.string(),
      location_path: z.string(),
      thumb_url: z.string().nullable(),
    }),
  ),
});
export type UnitDetail = z.infer<typeof UnitDetail>;

// ---------- Search ----------

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []));

export const SearchQuery = z.object({
  q: z.string().max(200).default(""),
  category: csv,
  brand: csv,
  series: csv,
  condition: csv,
  location: LocationId.optional(),
  unverified: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  in_transit: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  status: z.enum(["active", "all"]).default("active"),
  sort: z.enum(["relevance", "newest", "name"]).default("relevance"),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type SearchQueryInput = z.input<typeof SearchQuery>;

export const SearchHit = z.object({
  unit_id: UnitId,
  catalog_item_id: CatalogId,
  category: z.string(),
  brand: z.string(),
  series: z.string(),
  wave: z.string(),
  item_name: z.string(),
  model_number: z.string(),
  condition: z.string(),
  needs_review: z.boolean(),
  verified: z.boolean(),
  status: z.string(),
  location_id: LocationId.nullable(),
  location_path: z.string(),
  thumb_url: z.string().nullable(),
  created_at: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

const facet = z.array(z.object({ value: z.string(), count: z.number().int() }));
export const SearchResponse = z.object({
  total: z.number().int(),
  took_ms: z.number(),
  hits: z.array(SearchHit),
  facets: z.object({ category: facet, brand: facet, series: facet, condition: facet }),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// ---------- Catalogue ----------

export const CatalogFindQuery = z.object({
  model: z.string().optional(),
  barcode: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const CatalogItem = z.object({
  id: CatalogId,
  category: z.string(),
  brand: z.string(),
  franchise: z.string(),
  series: z.string(),
  wave: z.string(),
  item_name: z.string(),
  model_number: z.string(),
  barcode: z.string(),
  scale: z.string(),
  release_year: z.number().nullable(),
  verified: z.boolean(),
  source_url: z.string().nullable(),
  unit_count: z.number().int(),
  matched_by: z.array(z.enum(["model", "barcode", "text"])),
});
export type CatalogItem = z.infer<typeof CatalogItem>;

export const CatalogSaveRequest = z.object({
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
  source_url: z.url().nullable().default(null),
  field_confidence: z.record(z.string(), confidence).default({}),
  client_key: z.string().min(8).max(128),
});
export type CatalogSaveRequest = z.input<typeof CatalogSaveRequest>;

export const CatalogSaveResponse = z.object({ id: CatalogId, created: z.boolean() });

// ---------- Locations ----------

export interface LocationNode {
  id: string;
  name: string;
  path: string;
  kind: string;
  unit_count: number;
  subtree_count: number;
  children: LocationNode[];
}

// ---------- Batches ----------

export const BatchSummary = z.object({
  id: BatchId,
  mode: z.string(),
  folder: z.string(),
  instruction: z.string(),
  status: z.string(),
  to_location_path: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
  created_at: z.string(),
  undone_at: z.string().nullable(),
  thumbs: z.array(z.object({ unit_id: z.string(), thumb_url: z.string().nullable() })),
});
export type BatchSummary = z.infer<typeof BatchSummary>;

export const UndoResult = z.object({
  batch_id: BatchId,
  reversed_movements: z.number().int(),
  disposed_units: z.array(UnitId),
  replayed: z.boolean(),
});
export type UndoResult = z.infer<typeof UndoResult>;

export const Stats = z.object({
  units: z.number().int(),
  photos: z.number().int(),
  open_reviews: z.number().int(),
  catalog_items: z.number().int(),
});
export type Stats = z.infer<typeof Stats>;

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Turn a zod error into field-level messages Claude can act on. */
export function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
}
