# ToyVault

Serialized inventory and house-move tracking for a ~10,000-toy collection, operated entirely from
Claude Desktop. Spec: [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md).

- `packages/connector`: local MCP server Claude Desktop launches; reads `~/ToyVault/inbox/<date>/`
- `packages/api`: Railway service holding the ledger (Postgres) and photos (private bucket)
- `packages/shared`: the classification contract, ID formats and thresholds
- `packages/viewer`: read-only web viewer (search, unit detail, locations, batches), served by the API

## Set up the connector on the Claude Desktop computer

Needs Node.js 22+ and pnpm (`corepack enable`).

```bash
git clone https://github.com/dna160/toyvault.git
cd toyvault
pnpm install
pnpm install-connector -- --api-url https://<toyvault-api domain>
```

Quit Claude Desktop fully (Cmd+Q) before running it: Claude Desktop rewrites its config file while
it is open and would drop the new entry. It asks for the connector token (from the `CONNECTOR_TOKEN` variable on Railway), writes it to
`~/ToyVault/config.json`, backs up `claude_desktop_config.json` and adds `mcpServers.toyvault`.
Quit and reopen Claude Desktop, then paste [`prompts/desktop-instructions.md`](prompts/desktop-instructions.md)
into the Claude Desktop project's instructions.

Daily use: copy JPG/PNG photos to `~/ToyVault/inbox/2026-10-13/` and type
`Intake 2026-10-13. Location: Old House › Garage › Shelf A` in Claude Desktop.

## Develop

```bash
docker run -d --name toyvault-pg-test -e POSTGRES_USER=toyvault -e POSTGRES_PASSWORD=toyvault \
  -e POSTGRES_DB=toyvault -p 55432:5432 postgres:17-alpine
pnpm install && pnpm build && pnpm test
```
