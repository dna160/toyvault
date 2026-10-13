import type {
  CandidatesResponse,
  CatalogItem,
  CatalogSaveRequest,
  CatalogUpdateRequest,
  ReviewKind,
  ReviewList,
  ReviewSummary,
  UnitReviewRequest,
  UnitReviewResult,
  SearchQueryInput,
  SearchResponse,
  UndoResult,
  IntakeBatchRequest,
  IntakeReceipt,
  LocationResolveResponse,
  PhotoRegisterRequest,
  PhotoRegisterResponse,
  PresignRequest,
  PresignResponse,
} from "@toyvault/shared";

/** Railway could not be reached after retries. Nothing was saved. */
export class RailwayUnreachableError extends Error {}

/** Railway answered with a 4xx: the request itself needs fixing. */
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

const RETRY_DELAYS_MS = [500, 1500, 3000];
const TIMEOUT_MS = 30_000;

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  registerPhotos(body: PhotoRegisterRequest) {
    return this.request<PhotoRegisterResponse>("POST", "/v1/photos", body);
  }
  presign(body: PresignRequest) {
    return this.request<PresignResponse>("POST", "/v1/photos/presign", body);
  }
  resolveLocation(path: string) {
    return this.request<LocationResolveResponse>("POST", "/v1/locations/resolve", { path });
  }
  commitIntake(body: IntakeBatchRequest) {
    return this.request<IntakeReceipt>("POST", "/v1/intake-batches", body);
  }
  candidates(params: Record<string, string | undefined>) {
    return this.request<CandidatesResponse>("GET", `/v1/candidates?${query(params)}`);
  }
  findCatalog(params: { model?: string; barcode?: string; q?: string; limit?: number }) {
    return this.request<{ items: CatalogItem[] }>("GET", `/v1/catalog?${query(params)}`);
  }
  saveCatalog(body: CatalogSaveRequest) {
    return this.request<{ id: string; created: boolean }>("POST", "/v1/catalog", body);
  }
  search(params: SearchQueryInput) {
    return this.request<SearchResponse>("GET", `/v1/search?${query(params)}`);
  }
  reviewSummary() {
    return this.request<ReviewSummary>("GET", "/v1/reviews/summary");
  }
  reviews(kind: ReviewKind, limit = 20, offset = 0) {
    return this.request<ReviewList>("GET", `/v1/reviews?${query({ kind, limit, offset })}`);
  }
  reviewUnit(id: string, body: UnitReviewRequest) {
    const path = id.startsWith("RV-") ? `/v1/reviews/${encodeURIComponent(id)}/resolve` : `/v1/units/${encodeURIComponent(id)}/review`;
    return this.request<UnitReviewResult>("POST", path, body);
  }
  updateCatalog(id: string, body: CatalogUpdateRequest) {
    return this.request<{ id: string; verified: boolean; operator_corrected: boolean; changed: string[] }>(
      "POST",
      `/v1/catalog/${encodeURIComponent(id)}`,
      body,
    );
  }
  undoBatch(batchId: string) {
    return this.request<UndoResult>("POST", `/v1/batches/${encodeURIComponent(batchId)}/undo`, {});
  }

  /** Upload bytes to a presigned bucket URL (with the same retry policy). */
  async upload(url: string, body: Buffer, contentType: string): Promise<void> {
    await this.withRetries(async () => {
      const res = await this.fetchImpl(url, {
        method: "PUT",
        body: new Uint8Array(body),
        headers: { "content-type": contentType },
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      });
      if (res.status >= 500) throw new RetryableError(`bucket upload failed with ${res.status}`);
      if (!res.ok) throw new ApiRequestError(res.status, `bucket upload failed with ${res.status}: ${await res.text()}`);
    });
  }

  async download(url: string): Promise<Buffer | null> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return this.withRetries(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 500) throw new RetryableError(`Railway returned ${res.status}`);
      const json = (await res.json().catch(() => ({}))) as { message?: string; issues?: { path: string; message: string }[] };
      if (!res.ok) throw new ApiRequestError(res.status, json.message ?? `HTTP ${res.status}`, json.issues ?? []);
      return json as T;
    });
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiRequestError) throw err;
        lastError = err;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new RailwayUnreachableError(`Railway unreachable: ${(lastError as Error)?.message ?? lastError}`);
  }
}

class RetryableError extends Error {}

function query(params: object): URLSearchParams {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)] as [string, string]);
  return new URLSearchParams(entries);
}
