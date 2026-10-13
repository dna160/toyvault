/** "Old House › Garage › Shelf A" → ["Old House", "Garage", "Shelf A"] */
export const crumbs = (path: string) => path.split(" › ").filter(Boolean);

export function fmtDate(iso: string, withTime = false) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export const fmtNum = (n: number) => n.toLocaleString();

/** Card title: item name, else series, else category. */
export function titleOf(x: { item_name: string; series: string; category: string }) {
  return x.item_name || x.series || x.category;
}

/** Subtitle: series · wave, skipping parts already in the title. */
export function subtitleOf(x: { item_name: string; series: string; wave: string; brand: string }) {
  const parts = [x.series, x.wave && `Wave ${x.wave}`].filter((p) => p && !x.item_name.includes(p));
  return parts.length ? parts.join(" · ") : x.brand;
}

export const conditionShort: Record<string, string> = {
  Sealed: "Sealed",
  Opened: "Opened",
  "Loose complete": "Loose",
  "Loose incomplete": "Loose · incomplete",
  Damaged: "Damaged",
};
