# 0001 — Database access: Kysely

Date: 2026-10-13 · Status: accepted

## Context

The ledger leans on Postgres features more than on ORM conveniences: ID defaults from sequences
(`TV-000001`), an append-only trigger on `movements`, a recursive view that resolves a unit's
location through nested cartons, `bit(64)` image hashes compared with `bit_count`, `tsvector` and
`pg_trgm` search, advisory locks for idempotent batch commits, and `SELECT … FOR UPDATE` on the
projection. The master prompt asks for a migration tool with typed queries: Drizzle or Kysely.

## Decision

Use **Kysely** with `pg`.

- Migrations are plain SQL inside `sql\`\`` blocks, so the schema in `0001_init.ts` reads like the
  spec and can use triggers, views, generated columns and extensions without fighting a schema DSL.
- Ordinary reads and writes use Kysely's typed builder against a hand-written `Database` interface
  (`packages/api/src/db.ts`); complex queries (recursive CTEs, candidate scoring) use typed raw `sql`.
- Migrations are registered statically in `migrate.ts`, so the same code runs in tests, CI and on
  Railway, and they run on every deploy before the server listens.

## Alternatives

- **Drizzle**: good typed schema, but its schema DSL would need escape hatches for most of the
  features above, and drizzle-kit generated migrations would hide the ledger invariants in diffs.
- **Prisma**: excluded; heavy runtime and weak support for the raw Postgres features we need.

## Consequences

- The `Database` interface must be kept in step with migrations by hand. Tests run every query
  against a real Postgres, so drift shows up as a failing test.
- Migrations are forward-only (`down` throws); fixes go in new migrations, matching the ledger's
  append-only philosophy.
