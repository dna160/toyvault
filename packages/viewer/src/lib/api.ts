import type {
  BatchSummary,
  LocationNode,
  ReviewKind,
  ReviewList,
  ReviewSummary,
  SearchResponse,
  Stats,
  UnitDetail,
} from "@toyvault/shared";

export class Unauthorized extends Error {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface SearchParams {
  q: string;
  category: string[];
  brand: string[];
  series: string[];
  condition: string[];
  location?: string;
  unverified: boolean;
  in_transit: boolean;
  sort: "relevance" | "newest" | "name";
}

export function searchUrl(p: SearchParams, offset: number, limit = 60) {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  for (const k of ["category", "brand", "series", "condition"] as const) if (p[k].length) qs.set(k, p[k].join("|"));
  if (p.location) qs.set("location", p.location);
  if (p.unverified) qs.set("unverified", "true");
  if (p.in_transit) qs.set("in_transit", "true");
  if (p.sort !== "relevance") qs.set("sort", p.sort);
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  return `/v1/search?${qs}`;
}

export const api = {
  me: () => get<{ principal: string; scope: string }>("/auth/me"),
  stats: () => get<Stats>("/v1/stats"),
  search: (p: SearchParams, offset: number) => get<SearchResponse>(searchUrl(p, offset)),
  unit: (id: string) => get<UnitDetail>(`/v1/units/${encodeURIComponent(id)}`),
  locations: () => get<{ roots: LocationNode[] }>("/v1/locations/tree"),
  batches: () => get<{ batches: BatchSummary[] }>("/v1/batches?limit=100"),
  reviewSummary: () => get<ReviewSummary>("/v1/reviews/summary"),
  reviews: (kind: ReviewKind, offset: number) => get<ReviewList>(`/v1/reviews?kind=${kind}&limit=30&offset=${offset}`),
  async login(password: string) {
    const res = await fetch("/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? "Sign-in failed");
    }
  },
  logout: () => fetch("/auth/logout", { method: "POST", credentials: "same-origin" }),
};
