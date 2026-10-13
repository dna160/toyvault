import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Badge, Breadcrumb, Empty, Loading, Phrase, Thumb } from "../components/ui";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";

export function Batches() {
  const q = useQuery({ queryKey: ["batches"], queryFn: api.batches });
  if (q.isPending) return <Loading />;
  if (q.isError) return <Empty title="Can’t load batches">{(q.error as Error).message}</Empty>;
  const batches = q.data.batches;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Batches</h1>
      <p className="mt-1 text-sm text-muted">Every intake and move session with its receipt. To undo one, type the phrase in Claude Desktop.</p>

      {batches.length === 0 ? (
        <div className="mt-5">
          <Empty title="No batches yet" />
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {batches.map((b) => (
            <article key={b.id} className={`panel p-4 ${b.status === "undone" ? "opacity-70" : ""}`}>
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-sm font-semibold">{b.id}</span>
                <span className="text-sm font-medium capitalize">{b.mode}</span>
                {b.to_location_path && <Breadcrumb path={b.to_location_path} className="text-sm text-ink-2" />}
                {b.status === "undone" && <Badge tone="warn">Undone {b.undone_at && fmtDate(b.undone_at)}</Badge>}
                <span className="ml-auto text-[13px] text-muted">{fmtDate(b.created_at, true)}</span>
              </header>
              {b.instruction && <p className="mt-1 truncate text-sm text-muted">“{b.instruction}”</p>}

              <dl className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                <Stat label="Listed" value={b.counts.listed} />
                <Stat label="Flagged" value={b.counts.flagged} warn />
                <Stat label="Skipped" value={b.counts.skipped} />
                <Stat label="Photos" value={b.counts.photos} className="hidden sm:block" />
              </dl>

              {b.thumbs.length > 0 && (
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {b.thumbs.map((t) => (
                    <Link key={t.unit_id} href={`/units/${t.unit_id}`} className="shrink-0" title={t.unit_id}>
                      <Thumb src={t.thumb_url} alt={t.unit_id} className="h-16 w-16" rounded="rounded-md" />
                    </Link>
                  ))}
                </div>
              )}

              {b.status !== "undone" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <span className="text-xs text-muted">In Claude Desktop:</span>
                  <Phrase text={`Undo batch ${b.id}`} />
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn, className = "" }: { label: string; value?: number; warn?: boolean; className?: string }) {
  return (
    <div className={className}>
      <dd className={`text-2xl font-semibold ${warn && value ? "text-accent-ink" : ""}`}>{value ?? 0}</dd>
      <dt className="text-xs text-muted">{label}</dt>
    </div>
  );
}
