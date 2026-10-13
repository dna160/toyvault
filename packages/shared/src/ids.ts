// IDs are minted by Postgres sequences on the server. These helpers only validate them.

export const ID_PATTERNS = {
  unit: /^TV-\d{6,}$/,
  catalog: /^CAT-\d{6,}$/,
  photo: /^PH-\d{6,}$/,
  location: /^LOC-\d{4,}$/,
  container: /^C-\d{4,}$/,
  movement: /^MV-\d{6,}$/,
  batch: /^B-\d{4,}$/,
  review: /^RV-\d{5,}$/,
} as const;

export type IdKind = keyof typeof ID_PATTERNS;

export function isId(kind: IdKind, value: string): boolean {
  return ID_PATTERNS[kind].test(value);
}

/** Location paths are written with "›" (or ">") between levels. */
export const PATH_SEPARATOR = " › ";

export function splitLocationPath(path: string): string[] {
  return path
    .split(/›|>/)
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter((p) => p.length > 0);
}
