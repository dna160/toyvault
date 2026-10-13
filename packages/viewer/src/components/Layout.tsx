import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { fmtNum } from "../lib/format";

const NAV = [
  { href: "/", label: "Search", match: (p: string) => p === "/" || p.startsWith("/units") },
  { href: "/locations", label: "Locations", match: (p: string) => p.startsWith("/locations") },
  { href: "/batches", label: "Batches", match: (p: string) => p.startsWith("/batches") },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [path] = useLocation();
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats, staleTime: 30_000 });

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 bg-ink text-white">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link href="/" className="shrink-0 text-[17px] font-semibold tracking-tight">
            Toy<span className="text-accent">Vault</span>
          </Link>
          <nav className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
                  n.match(path) ? "bg-white/12 text-white" : "text-white/70 hover:text-white"
                }`}
              >
                {n.label}
                {n.label === "Search" && stats.data && stats.data.open_reviews > 0 && (
                  <span className="ml-1.5 rounded-full bg-accent px-1.5 py-px text-[11px] font-semibold text-white" title="Flagged for review">
                    {stats.data.open_reviews}
                  </span>
                )}
              </Link>
            ))}
          </nav>
          <div className="ml-auto hidden shrink-0 font-mono text-[12px] text-white/60 md:block">
            {stats.data && `${fmtNum(stats.data.units)} units · ${fmtNum(stats.data.photos)} photos`}
          </div>
          <button
            type="button"
            onClick={() => api.logout().then(() => location.reload())}
            className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs text-white/50 hover:text-white md:ml-2"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 sm:py-7">{children}</main>
    </div>
  );
}
