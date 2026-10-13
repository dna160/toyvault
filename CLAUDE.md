# ToyVault

Serialized toy inventory and house-move tracker for ~10,000 toys. Claude Desktop is the operator terminal; this repo is the plumbing.
**Source of truth: `docs/MASTER_PROMPT.md`.** `docs/PRD.md` is background. Propose deviations before making them.

## Hard constraints
- Claude Desktop is the only entry point. The viewer is read-only; no upload pages or forms.
- No AI/OCR/vision/embedding/catalogue APIs or deps anywhere (`scripts/check-forbidden-deps.ts` enforces this). All judgement happens in Claude Desktop.
- Connector code is deterministic only: file I/O, resize, EXIF, QR/barcode, dHash, contact sheets.
- Ledger is append-only. Fix mistakes with compensating movements; never UPDATE/DELETE movements.
- Every write is idempotent. The same photo SHA-256 never creates a second active unit.
- Online only: no local queue. Failures are clean (nothing half-written, files stay in the inbox) and retryable.
- IDs (`TV-`, `CAT-`, `PH-`, `LOC-`, `C-`, `MV-`, `B-`, `RV-`) come from Postgres sequences only.
- JPEG/PNG only. No secrets in the repo. Ask before creating Railway resources, deploying, or deleting data.
- Work in phases (master prompt §13); stop and report at the end of each one.

## Architecture
- `packages/shared` — zod schemas, types, ID formats, thresholds (`config.ts`)
- `packages/connector` — MCP server (stdio) launched by Claude Desktop; reads `~/ToyVault/inbox/<date>/`, writes to the API
- `packages/api` — Fastify on Railway: bearer-token write API, read API, migrations, serves the viewer
- `packages/viewer` — Vite + React + Tailwind, read-only
- Postgres (ledger, catalogue, search via tsvector + pg_trgm) and a private S3-compatible bucket on Railway
- `prompts/desktop-instructions.md` — operator instructions pasted into the Claude Desktop project

## Commands
- `pnpm install && pnpm build` — build all packages (shared must build before api/connector typecheck)
- `pnpm test` — all suites, one package at a time; needs Postgres at `TEST_DATABASE_URL` (default `postgres://toyvault:toyvault@localhost:55432/toyvault`, see README for the docker command). Tests DROP the `public` schema.
- `pnpm typecheck` · `pnpm check-deps` (forbidden AI/OCR/catalogue deps)
- `pnpm install-connector -- --api-url <url>` — install into Claude Desktop on the operator's machine
- `pnpm --filter @toyvault/api integrity` — ledger invariant report (needs `DATABASE_URL`)
- Railway: project "Toyvault"; see `infra/railway/README.md`. Deploys from GitHub `dna160/toyvault` main.

## Standards
- pnpm workspaces, TypeScript strict, zod at every boundary.
- vitest. Required suites: ledger invariants, idempotency double-sends, viewer-cannot-write, mid-batch failure, golden-path e2e.
- ADRs in `docs/decisions/` for non-obvious choices.
- Small commits per milestone.
