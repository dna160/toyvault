import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IMAGE_DEFAULTS } from "@toyvault/shared";
import { z } from "zod";

const ConfigFile = z.object({
  apiBaseUrl: z.url(),
  token: z.string().min(32),
  batchSize: z.number().int().min(1).max(50).default(IMAGE_DEFAULTS.batchSize),
  previewPx: z.number().int().min(256).max(2048).default(IMAGE_DEFAULTS.previewPx),
});

export interface ConnectorConfig extends z.infer<typeof ConfigFile> {
  root: string;
  inboxDir: string;
  processedDir: string;
}

export function defaultRoot(): string {
  return process.env.TOYVAULT_ROOT ?? join(homedir(), "ToyVault");
}

/** Reads ~/ToyVault/config.json. The API token lives only in this file. */
export function loadConfig(root = defaultRoot()): ConnectorConfig {
  const file = process.env.TOYVAULT_CONFIG ?? join(root, "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ToyVault config at ${file}: ${(err as Error).message}. Run the install script first.`);
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid ToyVault config at ${file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return {
    ...parsed.data,
    apiBaseUrl: parsed.data.apiBaseUrl.replace(/\/+$/, ""),
    root,
    inboxDir: join(root, "inbox"),
    processedDir: join(root, "processed"),
  };
}
