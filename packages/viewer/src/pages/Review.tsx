import type { ReviewItem, ReviewKind, ReviewSummary } from "@toyvault/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Breadcrumb, Confidence, Empty, Loading, Phrase, Thumb } from "../components/ui";
import { api } from "../lib/api";
import { fmtNum } from "../lib/format";

interface Queue {
  kind: ReviewKind | "ambiguous_moves" | "count_discrepancies";
  label: string;
  title: string;
  blurb: string;
  phrase?: string;
}

const QUEUES: Queue[] = [
  {
    kind: "flagged",
    label: "Flagged identities",
    title: "Flagged identities",
    blurb: "Toys Claude could not identify with confidence at intake. They are listed already; review confirms, corrects or removes them.",
    phrase: "Review flagged",
  },
  {
    kind: "unverified",
    label: "Unverified products",
    title: "Unverified products",
    blurb: "Products never confirmed by a web source. Verifying a product once covers every copy of it.",
    phrase: "Verify products",
  },
  {
    kind: "low_confidence",
    label: "Low-confidence fields",
    title: "Low-confidence fields",
    blurb: "A minor field (release year, scale, wave…) was uncertain. The toy is fine; only that value may be off.",
    phrase: "Check low-confidence",
  },
  {
    kind: "ambiguous_moves",
    label: "Ambiguous matches",
    title: "Ambiguous matches",
    blurb: "Move photos that matched nothing at the stated source. Appears once moves start (Phase 3).",
  },
  {
    kind: "count_discrepancies",
    label: "Count discrepancies",
    title: "Count discrepancies",
    blurb: "Shelf counts that differ from the ledger. Appears once counts start (Phase 4).",
  },
];

export function Review({ kind }: { kind?: string }) {
  const summary = useQuery({ queryKey: ["review-summary"], queryFn: api.reviewSummary });
  const active = QUEUES.find((q) => q.kind === kind) ?? QUEUES[0]!;

  return (
    <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside>
        <p className="mb-2 text-xs font-medium tracking-wider text-muted uppercase">Exceptions</p>
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-col md:px-0">
          {QUEUES.map((q) => {
            const n = summary.data?.[q.kind as keyof ReviewSummary];
            const on = q.kind === active.kind;
            return (
              <Link
                key={q.kind}
                href={`/review/${q.kind}`}
                className={`flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${
                  on ? "bg-card font-medium shadow-sm ring-1 ring-line" : "text-ink-2 hover:bg-card/60"
                }`}
              >
                <span>{q.label}</span>
                <span className={`font-mono text-[12px] ${n ? (q.kind === "flagged" ? "text-accent-ink" : "text-ink") : "text-muted"}`}>
                  {n === undefined ? "…" : fmtNum(n)}
                </span>
              </Link>
            );
          })}
        </nav>
        <p className="mt-4 hidden text-xs leading-relaxed text-muted md:block">
          Read-only. Nothing is changed here; type the phrase shown on an item in Claude Desktop and Claude will propose
          a decision for you to approve.
        </p>
      </aside>

      <section className="min-w-0">
        {active.kind === "ambiguous_moves" || active.kind === "count_discrepancies" ? (
          <>
            <Header queue={active} total={summary.data?.[active.kind]} />
            <div className="mt-5">
              <Empty title="Nothing here">{active.blurb}</Empty>
            </div>
          </>
        ) : (
          <QueueList queue={active as Queue & { kind: ReviewKind }} total={summary.data?.[active.kind as ReviewKind]} />
        )}
      </section>
    </div>
  );
}

function Header({ queue, total }: { queue: Queue; total?: number }) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{queue.title}</h1>
        {total !== undefined && <span className="text-sm text-muted">{fmtNum(total)} open</span>}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted">{queue.blurb}</p>
      {queue.phrase && total ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Work through them in Claude Desktop:</span>
          <Phrase text={queue.phrase} />
        </div>
      ) : null}
    </header>
  );
}

function QueueList({ queue, total }: { queue: Queue & { kind: ReviewKind }; total?: number }) {
  const q = useInfiniteQuery({
    queryKey: ["reviews", queue.kind],
    queryFn: ({ pageParam }) => api.reviews(queue.kind, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <Header queue={queue} total={total ?? q.data?.pages[0]?.total} />
      <div className="mt-5 space-y-3">
        {q.isPending ? (
          <Loading />
        ) : q.isError ? (
          <Empty title="Can’t load this queue">{(q.error as Error).message}</Empty>
        ) : items.length === 0 ? (
          <Empty title="All clear">Nothing waiting in this queue.</Empty>
        ) : (
          items.map((item) => <Item key={item.subject_id} item={item} />)
        )}
        {q.hasNextPage && (
          <button
            type="button"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            className="w-full rounded-xl border border-line-2 bg-card py-2.5 text-sm hover:border-ink-2"
          >
            {q.isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        )}
      </div>
    </>
  );
}

function Item({ item }: { item: ReviewItem }) {
  const href = item.kind === "unverified" ? `/units/${item.unit_ids[0]}` : `/units/${item.subject_id}`;
  const phrase =
    item.kind === "flagged"
      ? `Review ${item.subject_id}`
      : item.kind === "unverified"
        ? `Verify ${item.subject_id}`
        : `Check ${item.subject_id}`;

  return (
    <article className="panel flex gap-3 p-3 sm:gap-4 sm:p-4">
      <Link href={href} className="shrink-0">
        <Thumb src={item.thumb_url} alt={item.item_name} className="h-20 w-20 sm:h-28 sm:w-28" />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link href={href} className="font-semibold hover:underline">
            {item.item_name || item.series || item.category}
          </Link>
          <span className="id">{item.subject_id}</span>
          {item.review_id && <span className="id">· {item.review_id}</span>}
        </div>
        <p className="truncate text-sm text-ink-2">
          {[item.series, item.brand, item.category].filter(Boolean).join(" · ")}
          {item.model_number && <span className="font-mono text-[12px]"> · {item.model_number}</span>}
        </p>
        <div className="mt-0.5 text-[13px] text-muted">
          {item.location_paths.map((p) => (
            <Breadcrumb key={p} path={p} className="mr-3" />
          ))}
        </div>

        {item.reason && (
          <p className="mt-2 rounded-lg bg-paper px-3 py-2 text-sm">
            <span className="font-medium">Claude’s note: </span>
            {item.reason}
            {item.identity_confidence !== null && (
              <span className="ml-2">
                <Confidence value={item.identity_confidence} />
              </span>
            )}
          </p>
        )}

        {item.kind === "unverified" && (
          <p className="mt-2 text-sm text-ink-2">
            {item.unit_count} cop{item.unit_count === 1 ? "y" : "ies"}:{" "}
            {item.unit_ids.map((id) => (
              <Link key={id} href={`/units/${id}`} className="id mr-1.5 text-ink hover:underline">
                {id}
              </Link>
            ))}
            {item.unit_count > item.unit_ids.length && <span className="id">…</span>}
          </p>
        )}

        {item.kind === "low_confidence" && item.low_fields.length > 0 && (
          <dl className="mt-2 flex flex-wrap gap-2">
            {item.low_fields.map((f) => (
              <div key={f.field} className="flex items-center gap-2 rounded-lg bg-paper px-2.5 py-1 text-sm">
                <dt className="text-muted">{f.field.replace(/_/g, " ")}</dt>
                <dd>{f.value || "—"}</dd>
                <dd>
                  <Confidence value={f.confidence} />
                </dd>
              </div>
            ))}
          </dl>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">In Claude Desktop:</span>
          <Phrase text={phrase} />
        </div>
      </div>
    </article>
  );
}
