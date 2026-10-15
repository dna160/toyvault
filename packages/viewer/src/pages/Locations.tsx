import type { LocationNode } from "@toyvault/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { Empty, Loading } from "../components/ui";
import { api } from "../lib/api";
import { fmtNum } from "../lib/format";

const searchHref = (n: LocationNode) => `/?location=${n.id}&loc_path=${encodeURIComponent(n.path)}`;

export function Locations() {
  const q = useQuery({ queryKey: ["locations"], queryFn: api.locations });
  const [showEmpty, setShowEmpty] = useState(false);
  if (q.isPending) return <Loading />;
  if (q.isError) return <Empty title="Can’t load locations">{(q.error as Error).message}</Empty>;

  const roots = q.data.roots;
  const pinned = roots.filter((r) => r.kind === "virtual" && r.path !== "Disposed");
  // Places that no longer hold anything (e.g. after a location correction) stay in the
  // ledger for history but are hidden unless asked for.
  const prune = (n: LocationNode): LocationNode | null =>
    showEmpty || n.subtree_count > 0
      ? { ...n, children: n.children.map(prune).filter((c): c is LocationNode => c !== null) }
      : null;
  const allReal = roots.filter((r) => r.kind !== "virtual");
  const real = allReal.map(prune).filter((r): r is LocationNode => r !== null);
  const countEmpty = (n: LocationNode): number => (n.subtree_count === 0 ? 1 : 0) + n.children.reduce((s, c) => s + countEmpty(c), 0);
  const emptyCount = allReal.reduce((s, r) => s + countEmpty(r), 0);
  const disposed = roots.find((r) => r.path === "Disposed");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
      <p className="mt-1 text-sm text-muted">Every unit has exactly one last-known location. Click a place to see what is there.</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {pinned.map((n) => (
          <Link key={n.id} href={searchHref(n)} className="panel flex items-center justify-between p-4 hover:border-ink-2">
            <span className="font-semibold">{n.name}</span>
            <span className={`font-mono text-lg ${n.subtree_count > 0 ? "text-accent-ink" : "text-muted"}`}>{fmtNum(n.subtree_count)}</span>
          </Link>
        ))}
      </div>

      <div className="panel mt-4 py-2">
        {real.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No locations yet. They are created the first time Claude Desktop logs a toy there.</p>
        ) : (
          real.map((n) => <Node key={n.id} node={n} depth={0} />)
        )}
      </div>

      {emptyCount > 0 && (
        <button type="button" onClick={() => setShowEmpty(!showEmpty)} className="mt-3 block text-sm text-muted hover:underline">
          {showEmpty ? "Hide empty locations" : `Show ${emptyCount} empty location${emptyCount === 1 ? "" : "s"}`}
        </button>
      )}
      {disposed && disposed.subtree_count > 0 && (
        <Link href={searchHref(disposed)} className="mt-3 block text-sm text-muted hover:underline">
          {fmtNum(disposed.subtree_count)} disposed or undone units are kept for history.
        </Link>
      )}
    </div>
  );
}

function Node({ node, depth }: { node: LocationNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-paper" style={{ paddingLeft: 8 + depth * 20 }}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`flex h-6 w-6 items-center justify-center rounded text-muted ${hasChildren ? "" : "invisible"}`}
          aria-label={open ? "Collapse" : "Expand"}
        >
          <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        </button>
        <Link href={searchHref(node)} className="min-w-0 flex-1 truncate py-0.5 hover:underline">
          <span className={depth === 0 ? "font-semibold" : ""}>{node.name}</span>
        </Link>
        <span className="font-mono text-[13px] text-muted" title={`${node.unit_count} here, ${node.subtree_count} including sub-locations`}>
          {fmtNum(node.subtree_count)}
        </span>
      </div>
      {open && node.children.map((c) => <Node key={c.id} node={c} depth={depth + 1} />)}
    </div>
  );
}
