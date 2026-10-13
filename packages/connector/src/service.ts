import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type Candidate,
  type Extraction,
  IMAGE_DEFAULTS,
  ID_PATTERNS,
  type IntakeReceipt,
  type PhotoRegisterResponse,
} from "@toyvault/shared";
import { ApiRequestError, type ApiClient } from "./api-client.js";
import type { ConnectorConfig } from "./config.js";
import { type ProcessedPhoto, contactSheet, hammingDistance, processPhoto } from "./images.js";
import { type InboxFile, listFolders, listInboxFiles, moveToProcessed } from "./inbox.js";

interface SessionPhoto {
  photoId: string;
  folder: string;
  file: InboxFile;
  processed: ProcessedPhoto;
  uploaded: boolean;
  activeUnits: string[];
  /** Set once the file has been moved to processed/ after a committed batch. */
  archived: boolean;
}

export interface BatchPhoto {
  photo_id: string;
  file: string;
  captured_at: string | null;
  codes: { format: string; text: string }[];
  already_listed_as: string[];
  preview: Buffer;
}

export interface NextBatchResult {
  folder: string;
  photos: BatchPhoto[];
  same_shot_pairs: { a: string; b: string; distance: number }[];
  rejected_files: string[];
  remaining_after_batch: number;
}

export interface IntakeInput {
  folder: string;
  location_id: string;
  instruction?: string;
  extractions: Extraction[];
  skipped_photo_ids?: string[];
  idempotency_key?: string;
}

export interface ShelfCandidatesResult {
  photo_id: string;
  at_source: Candidate[];
  elsewhere: Candidate[];
  sheet: Buffer | null;
  elsewhere_sheet: Buffer | null;
}

/** A user-facing problem Claude can fix (bad IDs, missing photos), not a network failure. */
export class ToolInputError extends Error {}

const CONCURRENCY = 4;

/**
 * The connector's work, independent of MCP: read the inbox, register and upload photos,
 * and forward Claude's decisions to Railway. It holds per-chat state in memory only;
 * if Claude Desktop restarts the connector, state is rebuilt from the inbox (photo
 * registration is idempotent on SHA-256).
 */
export class ConnectorService {
  private photos = new Map<string, SessionPhoto>();
  private lastBatch = new Map<string, string[]>();

  constructor(
    private cfg: ConnectorConfig,
    private api: ApiClient,
  ) {}

  folders() {
    return listFolders(this.cfg);
  }

  resolveLocation(path: string) {
    return this.api.resolveLocation(path);
  }

  async nextBatch(folder: string, size = this.cfg.batchSize, maxPx = this.cfg.previewPx): Promise<NextBatchResult> {
    const { photos: files, rejected } = await listInboxFiles(this.cfg, folder);
    const batchFiles = files.slice(0, size);
    const session = await this.ingest(folder, batchFiles, maxPx);
    this.lastBatch.set(folder, session.map((s) => s.photoId));

    const pairs: NextBatchResult["same_shot_pairs"] = [];
    for (let i = 0; i < session.length; i++) {
      for (let j = i + 1; j < session.length; j++) {
        const a = session[i]!;
        const b = session[j]!;
        const distance =
          a.processed.sha256 === b.processed.sha256 ? 0 : hammingDistance(a.processed.phash, b.processed.phash);
        if (distance <= IMAGE_DEFAULTS.sameShotMaxDistance) pairs.push({ a: a.photoId, b: b.photoId, distance });
      }
    }

    return {
      folder,
      photos: session.map((s) => ({
        photo_id: s.photoId,
        file: s.file.relPath,
        captured_at: s.processed.capturedAt,
        codes: s.processed.codes,
        already_listed_as: s.activeUnits,
        preview: s.processed.preview,
      })),
      same_shot_pairs: pairs,
      rejected_files: rejected.map((r) => r.relPath),
      remaining_after_batch: Math.max(0, files.length - batchFiles.length),
    };
  }

  async createUnits(input: IntakeInput): Promise<IntakeReceipt & { moved_to_processed: number; remaining_in_folder: number }> {
    const referenced = unique([...input.extractions.flatMap((e) => e.photo_ids), ...(input.skipped_photo_ids ?? [])]);
    await this.ensureKnown(input.folder, referenced);

    const unknown = referenced.filter((id) => this.photos.get(id)?.folder !== input.folder);
    if (unknown.length > 0) {
      throw new ToolInputError(
        `These photo IDs are not from folder ${input.folder}: ${unknown.join(", ")}. Use the IDs returned by inbox_next_batch.`,
      );
    }

    // Every photo of the last batch must be accounted for. Photos already listed are
    // skipped automatically; anything else missing is an error Claude must fix.
    const covered = new Set(referenced);
    const skipped = new Set(input.skipped_photo_ids ?? []);
    const missing: string[] = [];
    for (const id of this.lastBatch.get(input.folder) ?? []) {
      if (covered.has(id)) continue;
      if ((this.photos.get(id)?.activeUnits.length ?? 0) > 0) skipped.add(id);
      else missing.push(id);
    }
    if (missing.length > 0) {
      throw new ToolInputError(
        `Every photo in the batch must be in an extraction or in skipped_photo_ids. Missing: ${missing.join(", ")}.`,
      );
    }

    const allIds = unique([...referenced, ...skipped]);
    await this.uploadPhotos(allIds);

    const clientKey = input.idempotency_key ?? deterministicUuid(`intake|${input.folder}|${[...allIds].sort().join(",")}`);
    const receipt = await this.api.commitIntake({
      client_key: clientKey,
      folder: input.folder,
      instruction: input.instruction ?? "",
      location_id: input.location_id,
      extractions: input.extractions,
      skipped_photo_ids: [...skipped],
    });

    // Only after the server acknowledged: archive the local files. Archived photos stay
    // in memory so a retried call replays the receipt instead of failing.
    let moved = 0;
    for (const id of allIds) {
      const photo = this.photos.get(id);
      if (!photo || photo.archived) continue;
      await moveToProcessed(this.cfg, photo.file);
      photo.archived = true;
      moved++;
    }
    this.lastBatch.delete(input.folder);
    const { photos: left } = await listInboxFiles(this.cfg, input.folder);
    return { ...receipt, moved_to_processed: moved, remaining_in_folder: left.length };
  }

  async shelfCandidates(
    from: string,
    items: { photo_id: string; model_number?: string; catalog_item_id?: string }[],
  ): Promise<ShelfCandidatesResult[]> {
    const out: ShelfCandidatesResult[] = [];
    for (const item of items) {
      const photo = this.photos.get(item.photo_id);
      if (!photo) {
        throw new ToolInputError(`Unknown photo ${item.photo_id}. Call inbox_next_batch first and use its photo IDs.`);
      }
      const qr = photo.processed.codes.map((c) => c.text.trim()).find((t) => ID_PATTERNS.unit.test(t));
      const res = await this.api.candidates({
        location: from,
        model: item.model_number,
        catalog: item.catalog_item_id,
        qr,
        phash: photo.processed.phash,
      });
      const sheet = res.at_source.length
        ? await this.sheetFor(res.at_source, `At source · for ${item.photo_id}`)
        : null;
      const elsewhereSheet = res.elsewhere.length
        ? await this.sheetFor(res.elsewhere, `Elsewhere (review only) · for ${item.photo_id}`)
        : null;
      out.push({ photo_id: item.photo_id, at_source: res.at_source, elsewhere: res.elsewhere, sheet, elsewhere_sheet: elsewhereSheet });
    }
    return out;
  }

  private async sheetFor(candidates: Candidate[], title: string): Promise<Buffer> {
    const images = await mapLimit(candidates, CONCURRENCY, (c) =>
      c.thumb_url ? this.api.download(c.thumb_url) : Promise.resolve(null),
    );
    return contactSheet(
      candidates.map((c, i) => ({ label: c.unit_id, image: images[i] ?? null })),
      { title },
    );
  }

  /** Hash, resize and decode files, then register them with Railway to get PH- IDs. */
  private async ingest(folder: string, files: InboxFile[], maxPx: number): Promise<SessionPhoto[]> {
    if (files.length === 0) return [];
    const processed = await mapLimit(files, CONCURRENCY, async (f) => processPhoto(await readFile(f.absPath), { previewPx: maxPx }));
    const response: PhotoRegisterResponse = await this.api.registerPhotos({
      photos: processed.map((p, i) => ({
        sha256: p.sha256,
        phash: p.phash,
        captured_at: p.capturedAt,
        source_folder: folder,
        filename: files[i]!.relPath,
        width: p.width,
        height: p.height,
      })),
    });
    return response.photos.map((r, i) => {
      const s: SessionPhoto = {
        photoId: r.id,
        folder,
        file: files[i]!,
        processed: processed[i]!,
        uploaded: r.upload_status === "uploaded",
        activeUnits: r.active_units,
        archived: false,
      };
      this.photos.set(r.id, s);
      return s;
    });
  }

  /** Rebuild state after a connector restart by re-reading the folder (idempotent). */
  private async ensureKnown(folder: string, ids: string[]) {
    if (ids.every((id) => this.photos.has(id))) return;
    const { photos: files } = await listInboxFiles(this.cfg, folder);
    const knownPaths = new Set([...this.photos.values()].map((p) => p.file.absPath));
    const pending = files.filter((f) => !knownPaths.has(f.absPath));
    for (let i = 0; i < pending.length && !ids.every((id) => this.photos.has(id)); i += this.cfg.batchSize) {
      await this.ingest(folder, pending.slice(i, i + this.cfg.batchSize), this.cfg.previewPx);
    }
  }

  private async uploadPhotos(ids: string[]) {
    const pending = ids.map((id) => this.photos.get(id)!).filter((p) => !p.uploaded);
    if (pending.length === 0) return;
    const presigned = await this.api.presign({
      photos: pending.map((p) => ({ photo_id: p.photoId, original_content_type: p.processed.contentType })),
    });
    const byId = new Map(presigned.photos.map((p) => [p.photo_id, p]));
    await mapLimit(pending, CONCURRENCY, async (p) => {
      const urls = byId.get(p.photoId);
      if (!urls) throw new ApiRequestError(500, `no upload URL for ${p.photoId}`);
      const original = await readFile(p.file.absPath);
      await this.api.upload(urls.original.url, original, p.processed.contentType);
      await this.api.upload(urls.preview.url, p.processed.preview, "image/jpeg");
      await this.api.upload(urls.thumb.url, p.processed.thumb, "image/jpeg");
      p.uploaded = true;
    });
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** RFC 4122 version-5-shaped UUID derived from content, so retries reuse the same key. */
export function deterministicUuid(input: string): string {
  const h = createHash("sha256").update(input).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}
