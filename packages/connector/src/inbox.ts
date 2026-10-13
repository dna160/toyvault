import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { ACCEPTED_EXTENSIONS } from "@toyvault/shared";
import type { ConnectorConfig } from "./config.js";

export interface InboxFile {
  /** Path relative to the inbox root, e.g. "2026-10-13/01-garage/IMG_0001.jpg". */
  relPath: string;
  absPath: string;
}

export interface FolderSummary {
  folder: string;
  unprocessed: number;
  rejected: string[];
}

const accepted = (name: string) => (ACCEPTED_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase());
const hidden = (name: string) => name.startsWith(".");

/** Resolve a folder name like "2026-10-13" or "2026-10-13/01-garage" inside the inbox. */
export function inboxFolderPath(cfg: ConnectorConfig, folder: string): string {
  const abs = resolve(cfg.inboxDir, folder);
  if (abs !== cfg.inboxDir && !abs.startsWith(cfg.inboxDir + sep)) {
    throw new Error(`folder must be inside the inbox: ${folder}`);
  }
  return abs;
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (hidden(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export async function listInboxFiles(cfg: ConnectorConfig, folder: string) {
  const files = await walk(inboxFolderPath(cfg, folder));
  const toEntry = (absPath: string): InboxFile => ({ absPath, relPath: relative(cfg.inboxDir, absPath).split(sep).join("/") });
  return {
    photos: files.filter(accepted).map(toEntry),
    rejected: files.filter((f) => !accepted(f)).map(toEntry),
  };
}

export async function listFolders(cfg: ConnectorConfig): Promise<FolderSummary[]> {
  if (!existsSync(cfg.inboxDir)) return [];
  const entries = await readdir(cfg.inboxDir, { withFileTypes: true });
  const out: FolderSummary[] = [];
  for (const e of entries.filter((d) => d.isDirectory() && !hidden(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const { photos, rejected } = await listInboxFiles(cfg, e.name);
    out.push({ folder: e.name, unprocessed: photos.length, rejected: rejected.map((r) => r.relPath) });
  }
  return out;
}

/** Move a committed photo to processed/, keeping its dated sub-path. Never overwrites. */
export async function moveToProcessed(cfg: ConnectorConfig, file: InboxFile): Promise<string> {
  let target = join(cfg.processedDir, file.relPath);
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(target)) {
    const ext = extname(target);
    target = `${target.slice(0, -ext.length)}-${Date.now()}${ext}`;
  }
  await rename(file.absPath, target);
  return target;
}
