# Railway setup — project "Toyvault"

| Resource | Kind | Notes |
| --- | --- | --- |
| `Postgres` | Railway Postgres template | Ledger, catalogue, search |
| `toyvault-photos` | Railway bucket (S3-compatible, private) | Originals, previews, thumbnails; signed URLs only |
| `toyvault-api` | Service from GitHub `dna160/toyvault` (`main`) | Built from `Dockerfile`, config in `railway.toml`; migrations run on start; healthcheck `/healthz` |

## `toyvault-api` variables

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `CONNECTOR_TOKEN` | Random string, ≥ 32 chars. Set once in Railway; copy it into the connector's `config.json`. Rotate by changing it in both places. |
| `S3_ENDPOINT` | `${{toyvault-photos.ENDPOINT}}` |
| `S3_BUCKET` | `${{toyvault-photos.BUCKET}}` |
| `S3_REGION` | `${{toyvault-photos.REGION}}` |
| `S3_ACCESS_KEY_ID` | `${{toyvault-photos.ACCESS_KEY_ID}}` |
| `S3_SECRET_ACCESS_KEY` | `${{toyvault-photos.SECRET_ACCESS_KEY}}` |
| `S3_FORCE_PATH_STYLE` | `false` (Railway buckets use virtual-hosted URLs) |

`PORT` is provided by Railway. No secret is ever committed; `.env.example` lists the names only.

## Deploys

Pushes to `main` that touch `packages/api`, `packages/shared`, the `Dockerfile`, the lockfile or
`railway.toml` redeploy the service. GitHub Actions (`.github/workflows/ci.yml`) runs the forbidden
dependency check, build, typecheck and the full test suite against Postgres on every push.

## Integrity check

`pnpm --filter @toyvault/api integrity` with `DATABASE_URL` set prints a JSON report and exits
non-zero if any unit lacks exactly one resolvable location or the projection drifts from the ledger.
