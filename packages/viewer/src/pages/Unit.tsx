import type { UnitDetail } from "@toyvault/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { Badge, Breadcrumb, Confidence, Empty, Loading, Phrase, Thumb } from "../components/ui";
import { api } from "../lib/api";
import { fmtDate, titleOf } from "../lib/format";

export function Unit({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["unit", id], queryFn: () => api.unit(id) });
  if (q.isPending) return <Loading />;
  if (q.isError) return <Empty title={`Can’t show ${id}`}>{(q.error as Error).message}</Empty>;
  const u = q.data;
  const c = u.catalog;

  return (
    <div>
      <button type="button" onClick={() => history.back()} className="text-sm text-accent-ink hover:underline">
        ← Back to results
      </button>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-10">
        <Gallery unit={u} />

        <div className="min-w-0">
          <p className="id">
            {u.id} · {c.id}
          </p>
          <h1 className="mt-1 text-2xl leading-tight font-semibold tracking-tight sm:text-[32px]">{titleOf(c)}</h1>
          <p className="mt-1 text-ink-2">
            {[c.series, c.wave && `Wave ${c.wave}`, c.category, c.scale].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="dark">{u.condition}</Badge>
            {u.identity === "fungible" && <Badge>Interchangeable twin</Badge>}
            {u.status !== "active" && <Badge tone="warn">{u.status_reason === "undo" ? "Undone" : u.status}</Badge>}
            {!c.verified && <Badge>Unverified product</Badge>}
          </div>

          {u.needs_review && (
            <div className="mt-4 rounded-xl border border-accent/40 bg-accent-soft p-4">
              <p className="text-sm font-semibold text-accent-ink">Flagged for review</p>
              <p className="mt-1 text-sm text-ink-2">{u.review_reason}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">In Claude Desktop:</span>
                <Phrase text={`Review ${u.id}`} />
              </div>
            </div>
          )}

          <section className="panel mt-4 p-4">
            <p className="text-xs text-muted">{u.status === "active" ? "Current location" : "Last location"}</p>
            <Breadcrumb path={u.location.path} strong className="mt-0.5 text-lg" />
            {u.container_id && <p className="mt-1 text-sm text-muted">Inside carton {u.container_id}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <span className="text-xs text-muted">In Claude Desktop:</span>
              <Phrase text={`Where is ${u.id}?`} />
            </div>
          </section>

          <section className="panel mt-4 overflow-hidden">
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Extracted fields</h2>
            <dl className="divide-y divide-line text-sm">
              <Field label="Category" value={c.category} conf={c.field_confidence.category} />
              <Field label="Brand" value={c.brand} conf={c.field_confidence.brand} />
              <Field label="Franchise" value={c.franchise} conf={c.field_confidence.franchise} />
              <Field label="Series · wave" value={[c.series, c.wave].filter(Boolean).join(" · ")} conf={c.field_confidence.series} />
              <Field label="Item name" value={c.item_name} conf={c.field_confidence.item_name} />
              <Field label="Model number" value={c.model_number} conf={c.field_confidence.model_number} mono />
              <Field label="Barcode" value={c.barcode} conf={c.field_confidence.barcode} mono />
              <Field label="Scale" value={c.scale} conf={c.field_confidence.scale} />
              <Field
                label="Release year"
                value={c.release_year ? `${c.release_year}${c.release_year_source ? ` (${sourceLabel(c.release_year_source)})` : ""}` : ""}
                conf={c.field_confidence.release_year}
              />
              <Field label="Condition" value={u.condition} conf={c.field_confidence.condition} />
              <Field label="Identity" value={u.identity_confidence !== null ? "Claude’s overall confidence" : ""} conf={u.identity_confidence} />
              {u.notes && <Field label="Notes" value={u.notes} />}
            </dl>
            {c.source_url && (
              <div className="border-t border-line px-4 py-3 text-sm">
                <span className="text-muted">Web source: </span>
                <a href={c.source_url} target="_blank" rel="noreferrer noopener" className="break-all text-accent-ink hover:underline">
                  {c.source_url}
                </a>
              </div>
            )}
          </section>

          <Ocr unit={u} />
          <Timeline unit={u} />

          {u.other_copies.length > 0 && (
            <section className="mt-6">
              <h2 className="font-semibold">
                Other copies of this item <span className="font-normal text-muted">· {u.other_copies.length}</span>
              </h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {u.other_copies.map((o) => (
                  <Link key={o.id} href={`/units/${o.id}`} className="panel flex items-center gap-3 p-2.5 hover:border-ink-2">
                    <Thumb src={o.thumb_url} alt="" className="h-12 w-12 shrink-0" rounded="rounded-md" />
                    <div className="min-w-0">
                      <p className="id text-ink">{o.id}</p>
                      <p className="truncate text-sm text-muted">
                        {o.condition} · <Breadcrumb path={o.location_path} />
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function sourceLabel(s: string) {
  return s === "ocr" ? "from packaging" : s === "web" ? "from web check" : "inferred";
}

function Field({ label, value, conf, mono }: { label: string; value: string; conf?: number | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)_44px] items-baseline gap-3 px-4 py-2.5 sm:grid-cols-[160px_minmax(0,1fr)_48px]">
      <dt className="text-muted">{label}</dt>
      <dd className={`break-words ${mono ? "font-mono text-[13px]" : ""}`}>{value}</dd>
      <dd className="text-right">{conf !== undefined && <Confidence value={conf} />}</dd>
    </div>
  );
}

function Gallery({ unit }: { unit: UnitDetail }) {
  const [active, setActive] = useState(0);
  const photo = unit.photos[active];
  const intake = unit.photos.find((p) => p.role === "intake");
  return (
    <div className="min-w-0">
      <a href={photo?.preview_url ?? undefined} target="_blank" rel="noreferrer" className="block">
        <Thumb src={photo?.preview_url ?? null} alt={titleOf(unit.catalog)} className="aspect-[4/3] w-full bg-[#ebe7df] [&_img]:object-contain" rounded="rounded-xl" />
      </a>
      {unit.photos.length > 1 && (
        <div className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-5">
          {unit.photos.map((p, i) => (
            <button
              key={p.id + p.role}
              type="button"
              onClick={() => setActive(i)}
              className={`overflow-hidden rounded-lg ring-2 ${i === active ? "ring-ink" : "ring-transparent"}`}
              aria-label={`Photo ${p.id}`}
            >
              <Thumb src={p.thumb_url} alt="" className="aspect-square w-full" rounded="rounded-lg" />
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-sm text-muted">
        {unit.photos.length} photo{unit.photos.length === 1 ? "" : "s"} · first logged {fmtDate(unit.created_at, true)}
        {intake?.captured_at && <> · taken {fmtDate(intake.captured_at, true)}</>}
        {photo && <span className="id ml-1">· {photo.id}</span>}
      </p>
    </div>
  );
}

function Ocr({ unit }: { unit: UnitDetail }) {
  const lines = [...new Set(unit.photos.flatMap((p) => p.ocr_text))];
  if (lines.length === 0) return null;
  return (
    <details className="panel mt-4 group">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">
        Text read from packaging <span className="font-normal text-muted">· {lines.length} lines</span>
        <span className="float-right text-muted group-open:rotate-180">▾</span>
      </summary>
      <ul className="border-t border-line px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink-2">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </details>
  );
}

function Timeline({ unit }: { unit: UnitDetail }) {
  return (
    <section className="mt-6">
      <h2 className="font-semibold">Movement history</h2>
      <ol className="relative mt-3 border-l border-line-2 pl-5">
        {unit.movements.map((m, i) => (
          <li key={m.id} className="relative pb-4 last:pb-0">
            <span className={`absolute top-1.5 -left-[25px] h-2.5 w-2.5 rounded-full ${i === 0 ? "bg-accent" : "bg-line-2"}`} />
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="rounded bg-paper px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-line">{m.type}</span>
              {m.to_path ? <Breadcrumb path={m.to_path} strong /> : m.to_container_id ? <span className="font-semibold">Carton {m.to_container_id}</span> : null}
            </p>
            <p className="mt-0.5 text-[13px] text-muted">
              {fmtDate(m.created_at, true)}
              {m.method && ` · ${m.method}`}
              {m.confidence !== null && ` ${m.confidence.toFixed(2)}`}
              {m.reason && ` · ${m.reason}`}
              {m.batch_id && <span className="id"> · {m.batch_id}</span>}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
