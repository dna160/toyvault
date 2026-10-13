// Installs the ToyVault connector into Claude Desktop on this computer.
//
//   pnpm install-connector -- --api-url https://toyvault-api.up.railway.app [--root ~/ToyVault] [--force]
//
// The connector token is read from TOYVAULT_TOKEN or asked for interactively, and is
// written only to <root>/config.json (never to the repo or to Claude's config).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  // pnpm forwards the "--" separator; drop it so `pnpm install-connector -- --api-url …` works.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "api-url": { type: "string" },
    root: { type: "string" },
    force: { type: "boolean", default: false },
    "claude-config": { type: "string" },
  },
});

const repoRoot = resolve(import.meta.dirname, "..");
const entry = join(repoRoot, "packages", "connector", "dist", "index.js");
if (!existsSync(entry)) throw new Error(`connector is not built: ${entry} is missing`);

const root = resolve((values.root ?? join(homedir(), "ToyVault")).replace(/^~(?=$|[\\/])/, homedir()));
mkdirSync(join(root, "inbox"), { recursive: true });
mkdirSync(join(root, "processed"), { recursive: true });

// 1. Connector config with the API URL and token.
const configPath = join(root, "config.json");
if (!existsSync(configPath) || values.force) {
  const apiUrl = values["api-url"] ?? (await ask("ToyVault API URL (https://…): "));
  const token = process.env.TOYVAULT_TOKEN ?? (await ask("Connector token: "));
  if (!/^https?:\/\//.test(apiUrl)) throw new Error("API URL must start with http(s)://");
  if (token.length < 32) throw new Error("connector token looks too short");
  writeFileSync(configPath, `${JSON.stringify({ apiBaseUrl: apiUrl, token }, null, 2)}\n`, { mode: 0o600 });
  console.log(`wrote ${configPath}`);
} else {
  console.log(`kept existing ${configPath} (use --force to replace it)`);
}

// 2. Claude Desktop config: back it up, then add/replace only mcpServers.toyvault.
const claudeConfig = values["claude-config"] ?? claudeDesktopConfigPath();
mkdirSync(dirname(claudeConfig), { recursive: true });
let current: { mcpServers?: Record<string, unknown> } = {};
if (existsSync(claudeConfig)) {
  const backup = `${claudeConfig}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(claudeConfig, backup);
  console.log(`backed up Claude config to ${backup}`);
  current = JSON.parse(readFileSync(claudeConfig, "utf8"));
}
const next = {
  ...current,
  mcpServers: {
    ...(current.mcpServers ?? {}),
    toyvault: { command: process.execPath, args: [entry], env: { TOYVAULT_ROOT: root } },
  },
};
writeFileSync(claudeConfig, `${JSON.stringify(next, null, 2)}\n`);
console.log(`added mcpServers.toyvault to ${claudeConfig}`);
console.log("Restart Claude Desktop (quit fully, then reopen) to load the connector.");

function claudeDesktopConfigPath(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
}
