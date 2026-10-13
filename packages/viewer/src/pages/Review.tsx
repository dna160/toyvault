import type { ReviewItem, ReviewKind, ReviewSummary } from "@toyvault/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Breadcrumb, Confidence, Empty, Loading, Thumb } from "../components/ui";
import { api } from "../lib/api";
import { copyText } from "../lib/copy";
import { fmtNum } from "../lib/format";

// Mirrors the Review mock-up: exceptions sidebar, the selected item opened as a card with
// its photos, Claude's read and "Resolve in Claude Desktop" buttons, the rest as compact
// rows. The viewer never writes: each button copies a decision to paste into Claude Desktop.

type QueueKey = ReviewKind | "count_discrepancies";

interface Queue {
  key: QueueKey;
  label: string;
  count: (s: ReviewSummary) => number;
  empty: string;
}

const QUEUES: Queue[] = [
  {
    key: "flagged",
    label: "Ambiguous matches",
    count: (s) => s.flagged + s.ambiguous_moves,
    empty: "No toy is waiting for an identity decision.",
  },
  {
    key: "low_confidence",
    label: "Low-confidence fields",
    count: (s) => s.low_confidence,
    empty: "No uncertain values left to check.",
  },
  {
    key: "unverified",
    label: "Proposed new products",
    count: (s) => s.unverified,
    empty: "Every product has been confirmed by a source or by you.",
  },
  {
    key: "twins",
    label: "Twins without labels",
    count: (s) => s.twins,
    empty: "No identical copies without labels.",
  },
  {
    key: "count_discrepancies",
    label: "Count discrepancies",
    count: (s) => s.count_discrepancies,
    empty: "Shelf counts that differ from the ledger appear here once counting starts.",
  },
];

export function Review({ kind }: { kind?: string }) {
  const summary = useQuery({ queryKey: ["review-summary"], queryFn: api.reviewSummary });
  const queue = QUEUES.find((q) => q.key === kind) ?? QUEUES[0]!;

  return (
    <div className="grid gap-6 md:grid-cols-[230px_minmax(0,1fr)]">
      <aside>
        <p className="mb-2 text-xs font-medium tracking-wider text-muted uppercase">Exceptions</p>
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-col md:px-0">
          {QUEUES.map((q) => {
            const n = summary.data ? q.count(summary.data) : undefined;
            const on = q.key === queue.key;
            return (
              <Link
                key={q.key}
                href={`/review/${q.key}`}
                className={`flex shrink-0 items-center justify-between gap-4 rounded-lg px-3 py-2 text-sm ${
                  on ? "bg-card font-semibold shadow-sm ring-1 ring-line" : "text-ink-2 hover:bg-card/60"
                }`}
              >
                <span>{q.label}</span>
                <span className="font-mono text-[12px] font-normal">{n === undefined ? "…" : fmtNum(n)}</span>
              </Link>
            );
          })}
        </nav>
        <p className="mt-4 hidden text-xs leading-relaxed text-muted md:block">
          Read-only. Nothing is changed here; copy the phrase on an item and paste it in Claude Desktop.
        </p>
      </aside>

      <section className="min-w-0">
        {queue.key === "count_discrepancies" ? (
          <>
            <h1 className="text-xl font-semibold tracking-tight">{queue.label}</h1>
            <div className="mt-4">
              <Empty title="Nothing here">{queue.empty}</Empty>
            </div>
          </>
        ) : (
          <QueueView key={queue.key} queue={queue} kind={queue.key as ReviewKind} />
        )}
      </section>
    </div>
  );
}

function QueueView({ queue, kind }: { queue: Queue; kind: ReviewKind }) {
  const q = useInfiniteQuery({
    queryKey: ["reviews", kind],
    queryFn: ({ pageParam }) => api.reviews(kind, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  const [selected, setSelected] = useState(0);
  const current = items[selected];

  // j/k or arrow keys move through the queue, like a mail client.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if (e.key === "j" || e.key === "ArrowDown") setSelected((s) => Math.min(s + 1, items.length - 1));
      if (e.key === "k" || e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length]);

  if (q.isPending) return <Loading />;
  if (q.isError) return <Empty title="Can’t load this queue">{(q.error as Error).message}</Empty>;

  return (
    <div>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{queue.label}</h1>
        {current && (
          <span className="text-sm text-muted">
            Oldest first · <span className="font-mono text-[12px]">{idOf(current)}</span> · {selected + 1} of {fmtNum(total)}
          </span>
        )}
      </header>

      {items.length === 0 ? (
        <div className="mt-4">
          <Empty title="All clear">{queue.empty}</Empty>
        </div>
      ) : (
        <div className="mt-4 space-y-2.5">
          {items.map((item, i) =>
            i === selected ? (
              <OpenCard key={item.subject_id} item={item} />
            ) : (
              <Row key={item.subject_id} item={item} onOpen={() => setSelected(i)} />
            ),
          )}
          {q.hasNextPage && (
            <button
              type="button"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
              className="w-full rounded-xl border border-line-2 bg-card py-2.5 text-sm hover:border-ink-2"
            >
              {q.isFetchingNextPage ? "Loading…" : `Show more (${fmtNum(total - items.length)} left)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Copy decisions ----------

const idOf = (item: ReviewItem) => item.review_id ?? item.subject_id;

function decisions(item: ReviewItem): string[] {
  const id = idOf(item);
  switch (item.kind) {
    case "flagged":
      return [`${id}: ok`, `${id}: not a toy`, `${id}: correct`];
    case "low_confidence":
      return [`${id}: ok`, ...item.low_fields.map((f) => `${id}: fix ${f.field.replace(/_/g, " ")}`)];
    case "unverified":
      return [`${id}: verify`, `${id}: correct`];
    case "twins":
      return [];
  }
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string) => {
    if (!(await copyText(text))) return;
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
  };
  return { copied, copy };
}

// ---------- Selected item ----------

function title(item: ReviewItem) {
  return [item.series && !item.item_name.includes(item.series) ? item.series : "", item.item_name || item.category]
    .filter(Boolean)
    .join(" · ");
}

function context(item: ReviewItem) {
  switch (item.kind) {
    case "flagged":
      return item.location_paths[0] ? `intake · at ${item.location_paths[0]}` : "intake";
    case "low_confidence":
      return item.condition ?? "";
    case "unverified":
    case "twins":
      return `${item.unit_count} cop${item.unit_count === 1 ? "y" : "ies"} · ${item.category}`;
  }
}

function flag(item: ReviewItem): string | null {
  switch (item.kind) {
    case "flagged":
      return item.identity_confidence !== null ? `identity ${item.identity_confidence.toFixed(2)} < 0.60` : "identity unclear";
    case "low_confidence": {
      const f = item.low_fields[0];
      return f ? `${f.field.replace(/_/g, " ")} ${f.confidence.toFixed(2)} < 0.70` : null;
    }
    case "unverified":
      return "no web source";
    case "twins":
      return "no labels";
  }
}

function claudesRead(item: ReviewItem): React.ReactNode {
  switch (item.kind) {
    case "flagged":
      return item.reason ?? "Identity uncertain after the web check.";
    case "low_confidence":
      return (
        <span className="inline-flex flex-wrap gap-x-4 gap-y-1">
          {item.low_fields.map((f) => (
            <span key={f.field}>
              {f.field.replace(/_/g, " ")} read as <strong>{f.value || "—"}</strong> <Confidence value={f.confidence} />
            </span>
          ))}
        </span>
      );
    case "unverified":
      return (
        <>
          Listed as <strong>{[item.brand, item.series, item.item_name].filter(Boolean).join(" · ")}</strong>
          {item.model_number && <span className="font-mono text-[12px]"> ({item.model_number})</span>}, but no source confirmed it
          yet. “Verify” asks Claude to run the web check and attach the source.
        </>
      );
    case "twins":
      return (
        <>
          {item.unit_count} identical copies. Moves treat them as interchangeable, so counts stay right; a QR label on each tells
          them apart. Label printing arrives with the move tools.
        </>
      );
  }
}

function OpenCard({ item }: { item: ReviewItem }) {
  const { copied, copy } = useCopy();
  const tiles = item.photos.slice(0, 3);
  const phrases = decisions(item);
  const unitHref = `/units/${item.photos[0]?.unit_id ?? item.unit_ids[0] ?? ""}`;
  const f = flag(item);

  return (
    <article className="rounded-xl border-2 border-[#2f5bd3] bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0">
          <Link href={unitHref} className="font-semibold hover:underline">
            {title(item)}
          </Link>
          <span className="text-sm text-muted"> · {context(item)}</span>
        </p>
        {f && <span className="font-mono text-[12px] text-low">{f}</span>}
      </div>

      <div className={`mt-3 grid gap-3 ${tiles.length > 1 ? "sm:grid-cols-3" : "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"}`}>
        {tiles.length === 0 && <Thumb src={null} alt="" className="aspect-[4/3]" />}
        {tiles.map((t, i) => (
          <figure key={t.photo_id} className="min-w-0">
            <a href={t.preview_url ?? undefined} target="_blank" rel="noreferrer" className="block">
              <Thumb
                src={t.preview_url ?? t.thumb_url}
                alt={t.unit_id}
                className={`w-full bg-[#ebe7df] [&_img]:object-contain ${tiles.length === 1 ? "aspect-[16/10] max-h-72" : "aspect-[4/3]"}`}
              />
            </a>
            <figcaption className="mt-1.5 text-sm">
              <span className="font-semibold">
                {item.kind === "unverified" || item.kind === "twins" ? `${i + 1} · ` : "Photo · "}
                <Link href={`/units/${t.unit_id}`} className="font-mono text-[12.5px] hover:underline">
                  {item.kind === "unverified" || item.kind === "twins" ? t.unit_id : t.photo_id}
                </Link>
              </span>
              <span className="block text-[12.5px] text-muted">
                <Breadcrumb path={t.location_path} />
              </span>
            </figcaption>
          </figure>
        ))}
        {tiles.length === 1 && (
          <div className="flex flex-col justify-center gap-1 rounded-lg bg-paper p-4 text-sm">
            <span className="id">{item.subject_id}</span>
            <span className="font-medium">{[item.brand, item.category].filter(Boolean).join(" · ")}</span>
            {item.model_number && <span className="font-mono text-[12.5px]">{item.model_number}</span>}
            {item.condition && <span className="text-muted">{item.condition}</span>}
          </div>
        )}
      </div>

      <p className="mt-3 rounded-lg bg-paper px-3 py-2.5 text-sm leading-relaxed">
        <span className="font-semibold">Claude’s read: </span>
        {claudesRead(item)}
      </p>

      {phrases.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <span className="mr-1 text-[11px] font-medium tracking-wider text-muted uppercase">Resolve in Claude Desktop</span>
          {phrases.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => copy(p)}
              title="Copy, then paste into Claude Desktop"
              className={`rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] transition-colors ${
                copied === p ? "border-ok bg-ok text-white" : "border-line-2 bg-paper text-ink hover:border-ink"
              }`}
            >
              {copied === p ? "Copied — paste in Claude" : p}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

// ---------- Collapsed row ----------

function Row({ item, onOpen }: { item: ReviewItem; onOpen: () => void }) {
  const f = flag(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-card px-3 py-2.5 text-left hover:border-ink-2"
    >
      <Thumb src={item.photos[0]?.thumb_url ?? null} alt="" className="h-9 w-9 shrink-0" rounded="rounded-md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {title(item)}
          {f && <span className="font-normal text-muted"> — {f}</span>}
        </span>
        <span className="block truncate text-[12.5px] text-muted">
          {context(item)}
          {item.kind === "flagged" && item.reason && ` · ${item.reason}`}
        </span>
      </span>
      <span className="shrink-0 font-mono text-[12px] text-muted">{idOf(item)}</span>
    </button>
  );
}
