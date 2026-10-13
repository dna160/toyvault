import { type ColumnType, type Generated, Kysely, PostgresDialect } from "kysely";
import pg from "pg";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T = unknown> = ColumnType<T, string | undefined, string>;

export interface LocationsTable {
  id: Generated<string>;
  parent_id: string | null;
  name: string;
  path: string;
  kind: "site" | "room" | "zone" | "bin" | "virtual";
  created_at: Timestamp;
}

export interface ContainersTable {
  id: Generated<string>;
  label: Generated<string>;
  notes: Generated<string>;
  created_at: Timestamp;
}

export interface CatalogItemsTable {
  id: Generated<string>;
  category: string;
  brand: Generated<string>;
  franchise: Generated<string>;
  series: Generated<string>;
  wave: Generated<string>;
  item_name: Generated<string>;
  model_number: Generated<string>;
  barcode: Generated<string>;
  scale: Generated<string>;
  release_year: number | null;
  release_year_source: "ocr" | "web" | "inferred" | null;
  source_url: string | null;
  verified: Generated<boolean>;
  field_confidence: Json<Record<string, number>>;
  created_at: Timestamp;
}

export interface BatchesTable {
  id: Generated<string>;
  mode: "intake" | "move" | "pack" | "count";
  folder: Generated<string>;
  instruction: Generated<string>;
  from_location_id: string | null;
  to_location_id: string | null;
  counts: Json<Record<string, number>>;
  receipt: Json<unknown> | null;
  status: Generated<"committed" | "undone">;
  client_key: string;
  created_at: Timestamp;
}

export interface UnitsTable {
  id: Generated<string>;
  catalog_item_id: string;
  condition: string;
  packaging_state: Generated<string>;
  notes: Generated<string>;
  identity: Generated<"distinct" | "fungible">;
  needs_review: Generated<boolean>;
  review_reason: string | null;
  identity_confidence: ColumnType<string | null, number | null, number | null>;
  status: Generated<"active" | "merged" | "disposed">;
  status_reason: string | null;
  created_batch_id: string | null;
  created_at: Timestamp;
}

export interface IdReservationsTable {
  unit_id: string;
  reserved_at: Timestamp;
  used_at: Timestamp | null;
}

export interface PhotosTable {
  id: Generated<string>;
  sha256: string;
  /** bit(64), written as a 64-char binary string. */
  phash: string;
  captured_at: Timestamp | null;
  logged_at: Timestamp;
  upload_status: Generated<"registered" | "uploaded">;
  original_key: string | null;
  preview_key: string | null;
  thumb_key: string | null;
  original_content_type: string | null;
  ocr_text: Generated<string[]>;
  source_folder: Generated<string>;
  filename: Generated<string>;
  width: number | null;
  height: number | null;
}

export interface UnitPhotosTable {
  unit_id: string;
  photo_id: string;
  role: "intake" | "evidence";
  extraction: Json<unknown> | null;
  batch_id: string | null;
  created_at: Timestamp;
}

export interface MovementsTable {
  id: Generated<string>;
  type: "RECEIPT" | "TRANSFER" | "PACK" | "UNPACK" | "ADJUST" | "MERGE" | "SPLIT" | "DISPOSE";
  unit_id: string | null;
  container_id: string | null;
  from_location_id: string | null;
  from_container_id: string | null;
  to_location_id: string | null;
  to_container_id: string | null;
  batch_id: string | null;
  evidence_photo_id: string | null;
  confidence: ColumnType<string | null, number | null, number | null>;
  method: "qr" | "text" | "visual" | "manual" | "carton" | null;
  reason: string | null;
  idempotency_key: string;
  created_at: Timestamp;
}

export interface StockPositionTable {
  subject_type: "unit" | "container";
  subject_id: string;
  location_id: string | null;
  container_id: string | null;
  last_movement_id: string;
  updated_at: Timestamp;
}

export interface UnitCurrentLocationView {
  unit_id: string;
  location_id: string;
}

export interface ReviewTasksTable {
  id: Generated<string>;
  kind: "uncertain_identity" | "unmatched_move_photo" | "found_elsewhere" | "count_discrepancy";
  unit_id: string | null;
  photo_id: string | null;
  batch_id: string | null;
  candidates: Json<unknown[]>;
  reason: string | null;
  status: Generated<"open" | "resolved">;
  resolution: Json<unknown> | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}

export interface Database {
  locations: LocationsTable;
  containers: ContainersTable;
  catalog_items: CatalogItemsTable;
  batches: BatchesTable;
  units: UnitsTable;
  id_reservations: IdReservationsTable;
  photos: PhotosTable;
  unit_photos: UnitPhotosTable;
  movements: MovementsTable;
  stock_position: StockPositionTable;
  unit_current_location: UnitCurrentLocationView;
  review_tasks: ReviewTasksTable;
}

export type DB = Kysely<Database>;

export function createDb(connectionString: string): DB {
  const ssl = /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined;
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, ssl, max: 10 }) }),
  });
}

/** 16-char hex dHash -> 64-char bit string for a bit(64) column. */
export function phashToBits(hex: string): string {
  return BigInt(`0x${hex}`).toString(2).padStart(64, "0");
}

export function bitsToPhash(bits: string): string {
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}
