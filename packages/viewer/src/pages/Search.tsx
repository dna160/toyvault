import type { SearchHit, SearchResponse } from "@toyvault/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Badge, Breadcrumb, Empty, Loading, Thumb } from "../components/ui";
import { type SearchParams, api } from "../lib/api";
import { conditionShort, fmtNum, subtitleOf, titleOf } from "../lib/format";

const PAGE = 60;

// ---------- URL state: the search is shareable and survives Back ----------

function readParams(search: string): SearchParams & { view: "grid" | "table"; loc_path: string } {
  const s = new URLSearchParams(search);
  const list = (k: string) => (s.get(k) ? s.get(k)!.split("|") : []);
  return {
    q: s.get("q") ?? "",
    category: list("category"),
    brand: list("brand"),
    series: list("series"),
    condition: list("condition"),
    location: s.get("location") ?? undefined,
    loc_path: s.get("loc_path") ?? "",
    unverified: s.get("unverified") === "1",
    in_transit: s.get("in_transit") === "1",
    // Inside one series with no search text, list in name order (No.001, No.002, …).
    sort: (s.get("sort") as SearchParams["sort"]) ?? (list("series").length === 1 && !s.get("q") ? "name" : "relevance"),
    // Series collapse into one card by default; a selected series shows its units.
    group: s.get("group") !== "off" && list("series").length === 0,
    view: s.get("view") === "table" ? "table" : "grid",
  };
}

function writeParams(p: ReturnType<typeof readParams>): string {
  const s = new URLSearchParams();
  if (p.q) s.set("q", p.q);
  for (const k of ["category", "brand", "series", "condition"] as const) if (p[k].length) s.set(k, p[k].join("|"));
  if (p.location) {
    s.set("location", p.location);
    if (p.loc_path) s.set("loc_path", p.loc_path);
  }
  if (p.unverified) s.set("unverified", "1");
  if (p.in_transit) s.set("in_transit", "1");
  const defaultSort = p.series.length === 1 && !p.q ? "name" : "relevance";
  if (p.sort !== defaultSort) s.set("sort", p.sort);
  if (!p.group && p.series.length === 0) s.set("group", "off");
  if (p.view === "table") s.set("view", "table");
  const str = s.toString();
  return str ? `/?${str}` : "/";
}

export function Search() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => readParams(search), [search]);
  const set = (patch: Partial<typeof params>) => navigate(writeParams({ ...params, ...patch }), { replace: true });

  // Type-ahead: the box updates instantly; the query follows after a short pause.
  const [text, setText] = useState(params.q);
  useEffect(() => setText(params.q), [params.q]);
  useEffect(() => {
    if (text === params.q) return;
    const t = setTimeout(() => set({ q: text }), 180);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useInfiniteQuery({
    queryKey: ["search", { ...params, view: undefined }],
    queryFn: ({ pageParam }) => api.search(params, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last: SearchResponse, pages) => {
      const loaded = pages.reduce((n, p) => n + p.hits.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    placeholderData: (prev) => prev,
  });

  const first = query.data?.pages[0];
  const groupHref = (series: string) => writeParams({ ...params, series: [series] });
  const hits = useMemo(() => query.data?.pages.flatMap((p) => p.hits) ?? [], [query.data]);
  const facets = first?.facets;

  return (
    <div>
      <div className="relative">
        <svg className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search name, series, brand, model number, packaging text or location"
          aria-label="Search"
          autoFocus
          className="w-full rounded-xl border-2 border-ink bg-card py-3.5 pr-36 pl-12 text-[17px] outline-none placeholder:text-muted/70"
        />
        <span className="pointer-events-none absolute top-1/2 right-4 hidden -translate-y-1/2 font-mono text-[12px] text-muted sm:block">
          {first
            ? `${fmtNum(first.total)} result${first.total === 1 ? "" : "s"}${
                first.unit_total !== first.total ? ` · ${fmtNum(first.unit_total)} units` : ""
              } · ${first.took_ms} ms`
            : ""}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted">
        Search by photo: attach it in Claude Desktop and ask “Where is this?”.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm text-muted">Filters</span>
        {params.location && (
          <button type="button" className="chip chip-on" onClick={() => set({ location: undefined, loc_path: "" })}>
            <Breadcrumb path={params.loc_path || params.location} /> <span aria-hidden>×</span>
          </button>
        )}
        <FacetChip label="Category" selected={params.category} options={facets?.category} onChange={(v) => set({ category: v })} />
        <FacetChip label="Series" selected={params.series} options={facets?.series} onChange={(v) => set({ series: v })} />
        <FacetChip label="Brand" selected={params.brand} options={facets?.brand} onChange={(v) => set({ brand: v })} />
        <FacetChip label="Condition" selected={params.condition} options={facets?.condition} onChange={(v) => set({ condition: v })} />
        <button type="button" className={`chip ${params.unverified ? "chip-on" : ""}`} onClick={() => set({ unverified: !params.unverified })}>
          Unverified or flagged
        </button>
        <button type="button" className={`chip ${params.in_transit ? "chip-on" : ""}`} onClick={() => set({ in_transit: !params.in_transit })}>
          In transit only
        </button>
        {params.series.length === 0 && (
          <button
            type="button"
            className={`chip ${params.group ? "chip-on" : ""}`}
            onClick={() => set({ group: !params.group })}
            title="Show each series as one card"
          >
            Group series
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            aria-label="Sort"
            value={params.sort}
            onChange={(e) => set({ sort: e.target.value as SearchParams["sort"] })}
            className="rounded-lg border border-line-2 bg-card px-2 py-1.5 text-sm"
          >
            <option value="relevance">Best match</option>
            <option value="newest">Newest</option>
            <option value="name">Name</option>
          </select>
          <div className="flex overflow-hidden rounded-lg border border-line-2 text-sm">
            {(["grid", "table"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => set({ view: v })}
                className={`px-3 py-1.5 capitalize ${params.view === v ? "bg-ink text-white" : "bg-card text-ink-2"}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5">
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <Empty title="Search failed">{(query.error as Error).message}</Empty>
        ) : hits.length === 0 ? (
          <Empty title="No toys match">
            Try fewer words or clear a filter. Partial words work: “turbo rac s3”.
          </Empty>
        ) : params.view === "grid" ? (
          <Grid hits={hits} total={first!.total} groupHref={groupHref} loadMore={() => query.hasNextPage && !query.isFetchingNextPage && query.fetchNextPage()} />
        ) : (
          <Table hits={hits} total={first!.total} groupHref={groupHref} loadMore={() => query.hasNextPage && !query.isFetchingNextPage && query.fetchNextPage()} />
        )}
      </div>
    </div>
  );
}

// ---------- Filter chip with a facet list ----------

function FacetChip({
  label,
  selected,
  options,
  onChange,
}: {
  label: string;
  selected: string[];
  options?: { value: string; count: number }[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const on = selected.length > 0;
  return (
    <div ref={ref} className="relative">
      <button type="button" className={`chip ${on ? "chip-on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        {on ? `${label}: ${selected.length === 1 ? selected[0] : `${selected.length} selected`}` : label}
        {on ? (
          <span
            role="button"
            aria-label={`Clear ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          >
            ×
          </span>
        ) : (
          <span aria-hidden className="text-muted">▾</span>
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1.5 max-h-80 w-72 overflow-auto rounded-xl border border-line bg-card p-1.5 shadow-lg">
          {!options?.length ? (
            <p className="px-2 py-3 text-sm text-muted">Nothing to filter by.</p>
          ) : (
            options.map((o) => {
              const checked = selected.includes(o.value);
              return (
                <label key={o.value} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-paper">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(checked ? selected.filter((s) => s !== o.value) : [...selected, o.value])}
                    className="accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate">{o.value}</span>
                  <span className="font-mono text-[11px] text-muted">{o.count}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Grid (virtualised rows of cards) ----------

function useColumns(ref: React.RefObject<HTMLDivElement | null>) {
  const [cols, setCols] = useState(4);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e!.contentRect.width;
      setCols(w < 520 ? 2 : w < 820 ? 3 : w < 1080 ? 4 : w < 1300 ? 5 : 6);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return cols;
}

function useInfiniteRows(count: number, total: number, loaded: number, loadMore: () => void, estimate: number, gap: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => setOffset(listRef.current?.offsetTop ?? 0), []);
  const virtualizer = useWindowVirtualizer({ count, estimateSize: () => estimate, overscan: 4, gap, scrollMargin: offset });
  const items = virtualizer.getVirtualItems();
  const last = items.at(-1);
  useEffect(() => {
    if (last && last.index >= count - 3 && loaded < total) loadMore();
  }, [last?.index, count, loaded, total]); // eslint-disable-line react-hooks/exhaustive-deps
  return { listRef, virtualizer, items };
}

function Grid({ hits, total, loadMore, groupHref }: { hits: SearchHit[]; total: number; loadMore: () => void; groupHref: (s: string) => string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cols = useColumns(wrap);
  const rows = Math.ceil(hits.length / cols);
  const { listRef, virtualizer, items } = useInfiniteRows(rows, total, hits.length, loadMore, 330, 16);

  return (
    <div ref={wrap}>
      <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 grid gap-4"
            style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {hits.slice(row.index * cols, row.index * cols + cols).map((h) =>
              h.group ? <GroupCard key={`g:${h.group.series}`} hit={h} href={groupHref(h.group.series)} /> : <Card key={h.unit_id} hit={h} />,
            )}
          </div>
        ))}
      </div>
      {hits.length < total && <p className="py-6 text-center text-sm text-muted">Loading more…</p>}
    </div>
  );
}

function Card({ hit }: { hit: SearchHit }) {
  return (
    <Link href={`/units/${hit.unit_id}`} className="group panel block overflow-hidden transition-shadow hover:shadow-md">
      <div className="relative">
        <Thumb src={hit.thumb_url} alt={titleOf(hit)} className="aspect-[4/3] w-full" rounded="rounded-none" />
        <div className="absolute top-2 left-2 flex gap-1">
          <Badge>{conditionShort[hit.condition] ?? hit.condition}</Badge>
          {hit.needs_review && <Badge tone="warn">Check</Badge>}
        </div>
      </div>
      <div className="p-3">
        <p className="line-clamp-2 leading-snug font-semibold group-hover:underline">{titleOf(hit)}</p>
        <p className="mt-0.5 truncate text-sm text-ink-2">{subtitleOf(hit)}</p>
        <Breadcrumb path={hit.location_path} className="mt-1 text-[13px] text-muted" />
        <p className="id mt-1.5">{hit.unit_id}</p>
      </div>
    </Link>
  );
}

/** A whole series as one card: a 2×2 photo mosaic, the series and how many units it holds. */
function GroupCard({ hit, href }: { hit: SearchHit; href: string }) {
  const g = hit.group!;
  const tiles = [...g.thumb_urls, null, null, null, null].slice(0, 4);
  return (
    <Link href={href} className="group panel block overflow-hidden transition-shadow hover:shadow-md">
      <div className="relative grid aspect-[4/3] grid-cols-2 grid-rows-2 gap-px bg-line">
        {tiles.map((t, i) => (
          <Thumb key={i} src={t} alt="" className="h-full w-full" rounded="rounded-none" />
        ))}
        <div className="absolute top-2 left-2 flex gap-1">
          <Badge tone="dark">{fmtNum(g.count)} units</Badge>
          {g.flagged > 0 && <Badge tone="warn">{g.flagged} to check</Badge>}
        </div>
      </div>
      <div className="p-3">
        <p className="line-clamp-2 leading-snug font-semibold group-hover:underline">{g.series}</p>
        <p className="mt-0.5 truncate text-sm text-ink-2">{[hit.brand, hit.category].filter(Boolean).join(" · ")}</p>
        {g.location_paths.length === 1 ? (
          <Breadcrumb path={g.location_paths[0]!} className="mt-1 text-[13px] text-muted" />
        ) : (
          <p className="mt-1 text-[13px] text-muted">{g.location_paths.length} locations</p>
        )}
        <p className="mt-1.5 text-[12px] text-accent-ink">Open series →</p>
      </div>
    </Link>
  );
}

// ---------- Table (virtualised rows) ----------

function Table({ hits, total, loadMore, groupHref }: { hits: SearchHit[]; total: number; loadMore: () => void; groupHref: (s: string) => string }) {
  const { listRef, virtualizer, items } = useInfiniteRows(hits.length, total, hits.length, loadMore, 64, 0);
  return (
    <div className="panel overflow-x-auto">
      <div className="min-w-[860px]">
        <div className="grid grid-cols-[56px_2fr_1.4fr_1fr_1fr_1.6fr_96px] gap-3 border-b border-line px-3 py-2 text-xs font-medium text-muted">
          <span />
          <span>Name</span>
          <span>Series</span>
          <span>Brand</span>
          <span>Condition</span>
          <span>Location</span>
          <span>ID</span>
        </div>
        <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((row) => {
            const h = hits[row.index]!;
            if (h.group) {
              return (
                <Link
                  key={row.key}
                  href={groupHref(h.group.series)}
                  className="absolute inset-x-0 grid grid-cols-[56px_2fr_1.4fr_1fr_1fr_1.6fr_96px] items-center gap-3 border-b border-line/70 bg-paper/50 px-3 text-sm hover:bg-paper"
                  style={{ height: row.size, transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
                >
                  <Thumb src={h.group.thumb_urls[0] ?? null} alt="" className="h-11 w-11" rounded="rounded-md" />
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{h.group.series}</span>
                    <Badge tone="dark">{fmtNum(h.group.count)}</Badge>
                  </span>
                  <span className="truncate text-ink-2">Whole series</span>
                  <span className="truncate text-ink-2">{h.brand}</span>
                  <span className="truncate text-ink-2">—</span>
                  <span className="truncate text-[13px] text-muted">
                    {h.group.location_paths.length === 1 ? <Breadcrumb path={h.group.location_paths[0]!} /> : `${h.group.location_paths.length} locations`}
                  </span>
                  <span className="id">open →</span>
                </Link>
              );
            }
            return (
              <Link
                key={row.key}
                href={`/units/${h.unit_id}`}
                className="absolute inset-x-0 grid grid-cols-[56px_2fr_1.4fr_1fr_1fr_1.6fr_96px] items-center gap-3 border-b border-line/70 px-3 text-sm hover:bg-paper"
                style={{ height: row.size, transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
              >
                <Thumb src={h.thumb_url} alt="" className="h-11 w-11" rounded="rounded-md" />
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{titleOf(h)}</span>
                  {h.needs_review && <Badge tone="warn">Check</Badge>}
                </span>
                <span className="truncate text-ink-2">{h.series}</span>
                <span className="truncate text-ink-2">{h.brand}</span>
                <span className="truncate text-ink-2">{h.condition}</span>
                <Breadcrumb path={h.location_path} className="truncate text-[13px] text-muted" />
                <span className="id">{h.unit_id}</span>
              </Link>
            );
          })}
        </div>
      </div>
      {hits.length < total && <p className="py-4 text-center text-sm text-muted">Loading more…</p>}
    </div>
  );
}
