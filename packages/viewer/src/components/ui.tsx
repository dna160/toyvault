import { useState } from "react";
import { crumbs } from "../lib/format";

/** Locations always read as breadcrumbs, never as codes. */
export function Breadcrumb({ path, className = "", strong = false }: { path: string; className?: string; strong?: boolean }) {
  const parts = crumbs(path);
  if (parts.length === 0) return <span className={`text-muted ${className}`}>No location</span>;
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-1 ${className}`}>
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-muted/70">›</span>}
          <span className={strong ? "font-semibold text-ink" : ""}>{p}</span>
        </span>
      ))}
    </span>
  );
}

/** A toy image, or a quiet placeholder. Images load lazily and never shift layout. */
export function Thumb({ src, alt, className = "", rounded = "rounded-lg" }: { src: string | null; alt: string; className?: string; rounded?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`relative overflow-hidden bg-[#ebe7df] ${rounded} ${className}`}>
      {src && !failed ? (
        <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-line-2">
          <svg viewBox="0 0 24 24" className="h-1/3 w-1/3" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 8l9-5 9 5v8l-9 5-9-5z M3 8l9 5 9-5 M12 13v8" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

/** A phrase to type in Claude Desktop. Click copies it. The viewer itself never changes data. */
export function Phrase({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="phrase"
      title="Copy, then paste into Claude Desktop"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      <span>{text}</span>
      <span className="font-sans text-[11px] text-muted">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="id">—</span>;
  const tone = value >= 0.85 ? "text-ok" : value >= 0.7 ? "text-warn" : "text-low";
  return <span className={`font-mono text-[12px] ${tone}`}>{value.toFixed(2)}</span>;
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warn" | "dark" }) {
  const cls =
    tone === "warn"
      ? "bg-accent text-white"
      : tone === "dark"
        ? "bg-ink text-white"
        : "bg-card/95 text-ink-2 ring-1 ring-line";
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel px-6 py-14 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Loading() {
  return <div className="py-16 text-center text-sm text-muted">Loading…</div>;
}
