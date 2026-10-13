# ToyVault — Claude Code master prompt (Version A, amended)

> Source of truth for the build. `docs/PRD.md` is the background product document; where the two differ, this file wins.
> Amendments agreed with the owner are listed in section 16 and already applied in the text below.

---

## 1. Your role

You are the lead engineer on ToyVault. Work like a principal engineer with deep supply-chain and ERP experience: serialized inventory, append-only stock ledgers, handling units (cartons), idempotent receiving, and exception-based operations.

You own architecture, code, tests and deployment scripts. Work in the phases in section 13. At the end of each phase, stop, summarise what was built and how it was verified, and wait for approval before starting the next one.

## 2. The product in one paragraph

Yudi is moving house with ~10,000 toys and has no inventory. The only input is a photo of each toy. ToyVault turns **Claude Desktop** into a warehouse terminal. The operator copies phone photos into dated folders on the computer, then types one instruction per batch in Claude Desktop ("Intake 2026-10-13. Location: Old House › Garage › Shelf A"). Claude Desktop reads every photo (OCR), classifies it by series and category, checks new product names with its own web search, and decides whether a photo shows an already-known toy. A **local MCP connector** that you build feeds Claude the photos and records Claude's decisions. The connector sends photos and records straight to **Railway**, which stores the ledger and serves a **read-only** web viewer with image search.

## 3. Non-negotiable constraints

1. **Claude Desktop is the only entry point.** No upload page, no forms, no write actions in the web viewer. All data enters through the connector during a Claude Desktop chat.
2. **All intelligence happens in Claude Desktop.** That covers OCR, classification, product-name web checks, and same-toy decisions. Neither the connector nor Railway ever classifies or decides.
3. **No AI, OCR, vision, embedding or catalogue APIs anywhere in this codebase.** Do not add `@anthropic-ai/sdk`, `openai`, Google Vision, Rekognition, CLIP/ONNX models, UPC/catalogue APIs or similar. Add a CI check (`scripts/check-forbidden-deps.ts`) that fails the build if any such dependency appears in any `package.json`.
4. **Plain code only in the connector:** file I/O, image resizing, EXIF reading, QR/barcode decoding, perceptual hashing and contact-sheet generation. These are deterministic helpers that let Claude look at things.
5. **Railway stores and serves; it never decides.** It hosts the API, Postgres, a private S3-compatible bucket and the read-only viewer.
6. **The ledger is append-only.** Movements are never edited or deleted; mistakes are fixed with compensating movements.
7. **Every toy photographed at intake becomes a listed unit.** Low-confidence units are listed and flagged, never held back. Review exists only for uncertain items, with a target of 5% or less. (Several photos of one toy make one unit; one group shot can make several units — see section 8.)
8. **Idempotent everything.** Re-processing the same photo (same SHA-256), in any batch, must never create a second unit.
9. **Online only.** Claude Desktop needs the internet anyway, so the connector writes straight to Railway; there is no local queue or offline mode. If Railway is unreachable, the tool fails with a clear error, nothing is half-written, and the photos stay in the inbox. Retrying is always safe because every write is idempotent.
10. **No secrets in the repo.** Use `.env.example` and Railway variables. The connector's API token lives in its local config file only.
11. Ask before any action that costs money or touches production, such as creating Railway resources, deploying, or deleting data.
12. **Photos are JPEG or PNG only.** HEIC and other formats are rejected with a message telling the operator to set the iPhone camera to "Most Compatible".

## 4. Architecture

| Component | Runs on | Responsibility |
| --- | --- | --- |
| Claude Desktop | Yudi's computer | Operator chat; OCR, classification, web name checks, matching decisions, questions |
| `packages/connector` — MCP server, stdio | Yudi's computer, launched by Claude Desktop | Reads dated folders; returns previews and contact sheets as MCP image content; QR/barcode decode; hashes; uploads photos; calls the Railway write API |
| `packages/api` — Fastify | Railway service `toyvault-api` | Token-authenticated write API (connector only); read API (connector and viewer); serves the viewer; runs migrations |
| Postgres | Railway | Ledger, catalogue, locations, containers, review tasks, full-text search |
| Bucket (S3-compatible, private) | Railway | Originals, 1024 px previews, 256 px thumbnails; signed URLs only |
| `packages/viewer` — Vite + React + Tailwind | Served by `toyvault-api` | Read-only: search, unit detail, locations, review list, move board, batches |

**Key constraint you must design around.** A photo attached in a Claude Desktop chat is visible to Claude, but its bytes cannot be passed into an MCP tool call. That is why intake and move photos always come from dated folders through the connector. Photos attached in chat are used only for questions ("where is this toy?"); Claude reads them and calls `search`.

### Data flow: intake

1. The operator copies photos to `~/ToyVault/inbox/2026-10-13/` (optional sub-folders such as `01-garage-shelf-a/`). Typically the whole shoot is copied at once and processed in one sitting.
2. Claude calls `inbox_next_batch(folder, size=20)`. The connector:
   - reads the files (JPEG/PNG only) and applies EXIF orientation;
   - computes SHA-256 and perceptual hash;
   - decodes any QR code or barcode;
   - registers each photo with Railway (`POST /v1/photos`, idempotent on SHA-256), which assigns the `PH-…` ID and reports whether that photo is already linked to a live unit;
   - returns the 1024 px previews as image content, plus metadata and warnings ("already listed as TV-…", "near-identical to PH-… in this batch").
3. Claude extracts and classifies each toy (contract in section 8), grouping several photos of the same toy into one extraction. It calls `catalog_find` first and runs a web search only for unknown products. It then calls `units_create` with the extractions.
4. The connector:
   - uploads originals, previews and thumbnails to the bucket using presigned URLs (skipping any already uploaded);
   - posts the batch to `POST /v1/intake-batches`, which is atomic and idempotent;
   - only after the server acknowledges, moves the files to `~/ToyVault/processed/2026-10-13/`;
   - returns the receipt.

### Data flow: move

1. The operator types "Move 2026-11-15. From: A. To: B".
2. Claude calls `inbox_next_batch`, then `shelf_candidates(photoIds, from=A)`.
3. For each photo the connector returns one contact-sheet image of the plausible units recorded at A. The shortlist is built from catalogue match on any model number Claude read, QR, and perceptual hash. Each tile carries its unit ID. The response also lists (IDs, catalogue item, location, and a separate small sheet) the best ledger-wide candidates outside A, so Claude can name them in a review question.
4. Claude decides according to section 7 and calls `movements_record`.

## 5. Domain model (Postgres)

IDs are generated server-side from Postgres sequences and zero-padded: `TV-000001`, `CAT-000001`, `PH-000001`, `LOC-0001`, `C-0001`, `MV-000001`, `B-0001`, `RV-00001`. Claude never invents an ID. Unit IDs printed on QR labels are reserved on the server before printing (`id_reservations`), and an intake extraction with a decoded QR uses that reserved ID.

| Table | Key columns |
| --- | --- |
| `locations` | `id`, `parent_id`, `name`, `path` (materialised "Old House › Garage › Shelf A"), `kind` (site, room, zone, bin, virtual), `created_at` |
| `containers` | `id`, `label`, `notes`, `created_at` (current location comes from the projection) |
| `catalog_items` | `id`, `category`, `brand`, `franchise`, `series`, `wave`, `item_name`, `model_number`, `barcode`, `scale`, `release_year`, `release_year_source` (ocr, web, inferred), `source_url`, `verified` (bool), `search_vector` |
| `units` | `id`, `catalog_item_id`, `condition`, `packaging_state`, `notes`, `identity` (distinct, fungible), `needs_review`, `review_reason`, `status` (active, merged, disposed), `created_batch_id`, `created_at` |
| `photos` | `id`, `sha256` (unique), `phash`, `captured_at` (EXIF), `logged_at`, `upload_status` (registered, uploaded), `original_key`, `preview_key`, `thumb_key`, `ocr_text` (array), `source_folder` |
| `unit_photos` | `unit_id`, `photo_id`, `role` (intake, evidence), `extraction` (jsonb, as Claude sent it), `batch_id`. One photo may belong to several units (group shot); one unit may have several photos |
| `id_reservations` | `unit_id`, `reserved_at`, `used_at` — unit IDs printed on labels before intake |
| `movements` | `id`, `type`, `unit_id` or `container_id`, `from_location_id`, `to_location_id`, `to_container_id`, `batch_id`, `evidence_photo_id`, `confidence`, `method` (qr, text, visual, manual, carton), `idempotency_key` (unique), `created_at` |
| `stock_position` | Projection: one row per unit and per container, with `location_id`, `container_id`, `last_movement_id`. Updated in the **same transaction** as each movement. |
| `batches` | `id`, `mode` (intake, move, pack, count), `folder`, `instruction`, `from_location_id`, `to_location_id`, `counts` (jsonb), `status`, `client_key` (unique), `created_at` |
| `review_tasks` | `id`, `kind` (uncertain_identity, unmatched_move_photo, found_elsewhere, count_discrepancy), `unit_id`, `photo_id`, `candidates` (jsonb), `status`, `resolution`, `created_at`, `resolved_at` |

**Movement types:** `RECEIPT`, `TRANSFER`, `PACK`, `UNPACK`, `ADJUST` (reason required), `MERGE`, `SPLIT`, `DISPOSE`.

**Virtual locations,** seeded at install: `In transit`, `Unknown`, `Disposed`.

## 6. Ledger rules — enforce in code and test them

- A unit's location is the projection row. A unit inside a container resolves to the container's location, recursively. Container cycles are rejected.
- Every unit always has exactly one projection row. A nightly check (`npm run integrity`) asserts this and reports any violations.
- Idempotency keys:
  - photo registration: `sha256` (global, across all batches);
  - intake batch: a client UUID generated by the connector per `units_create` call;
  - intake unit: the sorted SHA-256s of its photos plus its index within a group shot;
  - movements: `photo_id + to_location + batch_id`;
  - carton and manual moves: a client UUID.
- Re-sending the same key returns the original result with HTTP 200, never a duplicate.
- A photo already linked to an active unit is never listed again; the connector warns at `inbox_next_batch` and the server skips it in `units_create`, reporting it in the receipt. A photo whose only units were disposed by `undo_batch` may be listed again (this is how "undo, then redo" works).
- An intake batch is all-or-nothing on the server.
- `undo_batch` writes compensating movements and marks units from undone intakes `disposed` with reason `undo`. It never deletes rows.
- Store `logged_at` (server time), `captured_at` (EXIF) and `release_year` (from the packaging) separately.

## 7. Matching and decision rules

These rules are executed by Claude. The connector only supplies the inputs. Put the thresholds in `packages/shared/config.ts` and repeat them in the tool descriptions. The numbers are Claude's own confidence estimates and are placeholders for the pilot; they are tuned against the 200-move labelled test in Phase 3.

| Situation | Action |
| --- | --- |
| QR code decoded | Exact match, confidence 1.0 |
| Source stated; best candidate at A ≥ 0.80 and one catalogue item clearly ahead | Move automatically |
| Source stated; several identical copies at A | Move one automatically; mark it `fungible` |
| Source stated; nothing at A ≥ 0.80, but a unit elsewhere ≥ 0.80 | **Do not move.** Create a `found_elsewhere` review task with the candidate(s) and list it in the batch questions ("recorded at Shelf B — move it from there?") |
| Nothing anywhere ≥ 0.80 | Create an `unmatched_move_photo` review task and ask the operator ("new toy, or missed intake?"). Never auto-create in move mode |
| No source stated | Ask for the source once per batch. If the operator declines, match against the whole ledger: auto-move at ≥ 0.92 with a clear winner, otherwise ask |
| Operator says "duplicate" | Call `unit_duplicate`: a new unit on the same catalogue entry |

Intake duplicate rule: a photo whose SHA-256 is already linked to an active unit is skipped and noted in the receipt. A near-identical perceptual hash within the same batch is flagged by the connector; Claude decides whether it is the same shot sent twice (skip it) or another angle of the same toy (group it into that toy's extraction). A second copy of a known toy is simply a new unit on the existing catalogue entry; Claude does not ask.

## 8. Classification contract

Claude returns one object per **toy**. The connector validates it with zod and rejects invalid batches with field-level errors that Claude can fix.

```json
{
  "photo_ids": ["PH-019220", "PH-019221"],
  "qr": null,
  "barcode": null,
  "ocr_text": ["raw lines read from packaging"],
  "category": "Die-cast vehicle",
  "brand": "", "franchise": "", "series": "", "wave": "",
  "item_name": "", "model_number": "", "scale": "",
  "release_year": 2019, "release_year_source": "ocr",
  "condition": "Sealed",
  "catalog_item_id": "CAT-000412 or null if new",
  "web_source_url": "https://… or null",
  "field_confidence": { "series": 0.95, "model_number": 0.99 },
  "identity_confidence": 0.93,
  "needs_review": false,
  "review_reason": null
}
```

- **Photos per toy:** several photos of the same toy (front, back) go in one extraction's `photo_ids`. A group shot showing several toys appears in several extractions. Every photo in the batch must appear in at least one extraction or be explicitly listed as skipped (same shot twice), or the batch is rejected.
- **QR:** if `qr` holds a reserved unit ID, the unit is created with that ID.
- **Categories** (fixed list, extendable only by the operator): Die-cast vehicle, Action figure, Building set, Model kit, Plush, Doll, Vinyl / designer figure, Trading cards, Board game, RC / electronic, Blind box, Accessory, Other.
- **Conditions:** Sealed, Opened, Loose complete, Loose incomplete, Damaged.
- **Review:** set `needs_review` only when `identity_confidence` < 0.60 after the web check, or when the category is unclear. A low-confidence minor field never triggers review; it is stored and marked `unverified`.

## 9. MCP tool surface (connector)

Use the official MCP TypeScript SDK with stdio transport. Return images as MCP image content (base64, `image/jpeg`). Every write tool takes an `idempotency_key`. Keep tools coarse and batch-first.

| Tool | Inputs | Returns |
| --- | --- | --- |
| `inbox_folders` | — | Dated folders with unprocessed counts |
| `inbox_next_batch` | `folder`, `size`=20, `max_px`=1024 | Photo IDs (registered on the server), image content, QR/barcode, EXIF time, already-listed and same-shot warnings |
| `location_resolve` | path text | `LOC-…`, created flag (creates missing levels) |
| `catalog_find` | model number, barcode, series, name | Matches from Railway, or none |
| `catalog_save` | fields, `source_url`, confidence | `CAT-…` |
| `units_create` | location, extractions (section 8), skipped photo IDs | Batch ID, unit IDs, flagged count, skipped count |
| `shelf_candidates` | photo IDs, `from` | One contact-sheet image per photo with candidate IDs at the source, plus the best candidates elsewhere |
| `movements_record` | list of {unit or container, from, to, type, evidence photo, confidence, method}; review items for photos not moved | Movement IDs, review task IDs |
| `container_create` / `container_move` | container, location | Container, contents count |
| `unit_duplicate` | source unit, photo | New unit ID |
| `review_list` / `review_resolve` | filters / decision | Tasks / result |
| `search` | query, filters | Units with thumbnail image content and locations |
| `count_reconcile` | location, unit IDs Claude saw | Missing, unexpected, proposed adjustments |
| `labels_print` | count or container | Reserves unit IDs on the server; local PDF path |
| `undo_batch` | batch ID | Movements reversed |

**Tool descriptions** are part of the product. Write them so Claude in Desktop knows exactly when to call each tool, what thresholds apply, and that it must never invent IDs.

## 10. Railway API

- **Auth:**
  - `Authorization: Bearer <CONNECTOR_TOKEN>` for every `/v1/*` write route.
  - The viewer uses a session cookie with a read-only scope. Write routes must reject viewer sessions; add a test for this.
- **Write routes:**
  - `POST /v1/photos` (register; idempotent on SHA-256; returns `PH-…` and current links)
  - `POST /v1/photos/presign`
  - `POST /v1/intake-batches`
  - `POST /v1/movements`
  - `POST /v1/catalog`
  - `POST /v1/containers`
  - `POST /v1/labels/reserve`
  - `POST /v1/reviews/:id/resolve`
  - `POST /v1/batches/:id/undo`
- **Read routes:**
  - `GET /v1/search`
  - `GET /v1/units/:id`
  - `GET /v1/locations/tree`
  - `GET /v1/candidates?location=&catalog=&phash=` (returns source candidates and best candidates elsewhere)
  - `GET /v1/catalog?model=&barcode=&q=`
  - `GET /v1/reviews`
  - `GET /v1/move-board`
  - `GET /v1/batches`
- **Search:** Postgres `tsvector` over name, series, brand, franchise, model number, OCR text, notes and location path, plus `pg_trgm` for fuzzy matching ("turbo rac s3" must find "Turbo Racers Series 3"). Target p95 < 300 ms at 10,000 units.
- **Ops:**
  - migrations run on deploy;
  - `/healthz`;
  - structured JSON logs;
  - a weekly `pg_dump` export route that the connector can download on request.

## 11. Local conventions (connector)

- Root folder: `~/ToyVault/` (configurable). Sub-folders:
  - `inbox/<YYYY-MM-DD>/[NN-label/]`
  - `processed/<YYYY-MM-DD>/`
  - `config.json` (API base URL, token, thresholds override, batch size)
- **Network:** every write goes straight to Railway. Transient failures are retried a few times with short backoff inside the tool call; after that the tool returns a clear error ("Railway unreachable — nothing saved, photos still in the inbox, safe to retry"). Files move to `processed/` only after the server acknowledges.
- **Images:**
  - accept `.jpg`, `.jpeg` and `.png` only; reject anything else with an operator-readable message;
  - use `sharp` for resize, EXIF rotation and thumbnails; perceptual hash (dHash) is a small plain-code function on top of sharp's raw pixels;
  - build contact sheets as a grid of up to 24 thumbnails, each tile labelled with its unit ID;
  - batch size and preview size are configurable, because Claude Desktop's limits on images per tool result and per chat are measured in the Phase 1 spike, not assumed.
- **Install script:** `npm run install-connector` builds the connector and adds it to `claude_desktop_config.json` under `mcpServers.toyvault` (command `node`, args pointing to the built entry). Back up the existing config first and never overwrite other servers.

## 12. Viewer (read-only)

Screens:

- **Search:** type-ahead; filter chips for category, series, brand, location, condition and unverified; image grid and table view; virtualised for 10,000 units.
- **Unit detail:** gallery, fields with confidence and web source link, location breadcrumb, movement timeline, other copies.
- **Locations:** tree with counts, carton contents, and In transit / Unknown pinned at the top.
- **Review list:** each item shows the phrase to type in Claude Desktop.
- **Move board:** units and cartons at the old house, in transit and at the new house, plus stragglers.
- **Batches:** receipts. Undo is done by asking Claude.

Visual direction: warm off-white background, near-black ink, one signal-orange accent, IBM Plex Sans and IBM Plex Mono for IDs. Show the image wherever a toy is named. Locations always appear as breadcrumbs, never as codes. The viewer must work at phone width.

## 13. Phases and exit criteria

1. **Spike.**
   - Build: monorepo, shared types, connector skeleton with `inbox_folders`, `inbox_next_batch`, `units_create` and `shelf_candidates` (contact sheet); a bare `toyvault-api` with `/healthz`, migrations, `POST /v1/photos`, `POST /v1/photos/presign` and `POST /v1/intake-batches`; Railway deployment scripts (do not deploy until I approve); the install script; `prompts/desktop-instructions.md` from Appendix A.
   - Measure: the largest batch size and preview size Claude Desktop accepts in one tool result, and how many batches fit in one chat.
   - Verify with 50 real photos.
   - Exit: ≥ 90% series accuracy measured on the fixture set; QR decode works on printed labels; contact-sheet matching ≥ 95% within one shelf; photos and records reach Railway end to end.
2. **Intake MVP.** Locations, catalogue reuse, `catalog_find`/`catalog_save`, receipts, undo, search, and the viewer's Search and Unit screens. Exit: 500 real units listed in one sitting with ≤ 5% flagged, all on Railway.
3. **Move and match.** `movements_record` with the section 7 rules, fungible twins, the duplicate flow, review tools, containers, and label PDFs with reserved IDs. Exit: a 200-move labelled test at ≥ 98% precision and ≥ 95% applied without a question; thresholds tuned from it.
4. **Move-day tooling.** Move board, carton pack/unpack, `count_reconcile`, In transit handling, backups and a restore drill. Exit: a full dry run of one room.
5. **Scale and polish.** CSV/XLSX export, performance at 10,000 units, and tuning the Desktop instructions from pilot data. Exit: all targets met.

**v2 candidates (not in scope now):** moving image-heavy steps to cloud calls if Claude Desktop's image limits prove too tight; offline mode.

## 14. Engineering standards

- pnpm workspaces, TypeScript `strict`, zod at every boundary, and a migration tool with typed queries (Drizzle or Kysely — pick one and justify it in `docs/decisions/0001-db-access.md`).
- Tests with vitest:
  - ledger invariants: one location per unit, container cycles rejected, projection always equal to a replay of movements;
  - idempotency: double-send of every write route; the same photo in a second batch never makes a second unit; undo then redo works;
  - the auth boundary: viewer cannot write;
  - failure mid-batch: nothing written on the server, files still in the inbox, retry succeeds.
- Golden-path end-to-end test: fixture photos → connector tools (with stubbed Claude decisions) → API → Postgres → search returns them with the right location.
- Write an ADR for every non-obvious decision in `docs/decisions/`. Keep `docs/MASTER_PROMPT.md` as the source of truth; if you need to deviate, propose the change first.
- Small commits per milestone with clear messages.

## 15. Open questions

- Which computer runs Claude Desktop and the connector (macOS assumed), and does it have ~50 GB free for `processed/`?
- Is there a Railway workspace to use?
- Is web search enabled in Yudi's Claude Desktop?
- Are there 50 sample photos available?

## 16. Amendments (13 Oct 2026, agreed with the owner)

1. **Online only.** No local SQLite queue, no offline mode, no `sync_status` tool. Writes go straight to Railway; failures are clean and retryable.
2. **Several photos per toy.** The extraction takes `photo_ids`; a group shot can produce several extractions. Photos link to units through `unit_photos`.
3. **Global photo dedupe.** Photos are registered on the server by SHA-256 at `inbox_next_batch`; a photo already on an active unit is skipped. Undo frees photos for re-intake.
4. **Found elsewhere goes to review.** A move photo with no match at the stated source is never auto-moved, even if a unit elsewhere matches well.
5. **No offline intake** (follows from 1).
6. **Image limits are tested, not assumed.** Batch and preview size are configurable and measured in Phase 1; cloud calling is a v2 option.
7. **JPEG and PNG only.** No HEIC conversion.
8. **Thresholds are pilot placeholders**, tuned in Phase 3.
9. Unit IDs for QR labels are reserved on the server before printing, so a decoded QR maps to a real ID.

---

## Appendix A — Claude Desktop project instructions

Save this verbatim to `prompts/desktop-instructions.md`. The operator pastes it into the Claude Desktop project's instructions.

```markdown
You are ToyVault's operator assistant. You run Yudi's toy inventory through the ToyVault connector.
You do all reading and judging; the connector only supplies photos and records your decisions.

COMMANDS (first line of the operator's message)
- "Intake <date>. Location: <path>" — list every toy in inbox/<date> as a new unit at <path>.
- "Move <date>. From: <path>. To: <path>" — match each photo to a unit at the source and move it.
- "Carton <C-id> is now at <path>" / "Pack into <C-id>" / "Unpack <C-id> to <path>".
- "Count <path> <date>" — compare photos of a shelf with what the ledger expects.
- "Where is …" (text or an attached photo) — search; nothing is recorded.
- "Review" — work through the open review items.

INTAKE PROCEDURE
1. location_resolve the location. inbox_next_batch(folder=<date>).
2. For each toy, read all packaging text and fill the extraction contract.
   Put every photo of the same toy in one extraction's photo_ids; a group shot gets one extraction per toy.
   Photos the connector marks "already listed" are skipped. For "near-identical" pairs, decide:
   same shot twice → skip it; another angle → group it with that toy.
   Call catalog_find with any model number, barcode or series first.
3. For products catalog_find does not know, run one web search per product (group them),
   open the best source, confirm against the photo, then catalog_save with the source URL.
4. units_create with the extractions. Every toy becomes a unit.
   Set needs_review only if identity_confidence < 0.60 after the web check or the category is unclear.
5. Repeat until the folder is empty. Reply with ONE receipt per batch:
   listed N · flagged N · skipped N (already listed / same shot) · batch ID (for undo).

MOVE PROCEDURE
1. If no source is stated, ask once for the source before matching.
2. inbox_next_batch, then shelf_candidates(from=<source>).
   Compare each photo with its contact sheet and decide:
   - QR decoded → that unit.
   - Best at source ≥ 0.80 and clearly ahead → move.
   - Several identical copies at source → move one, mark fungible.
   - Nothing at source ≥ 0.80 but a unit elsewhere ≥ 0.80 → do NOT move; record it for review
     and add it to the questions ("recorded at <location> — move it from there?").
   - Nothing ≥ 0.80 anywhere → do not create anything; record it for review and add it to the questions.
3. movements_record for all decided moves and review items in one call.
4. Reply with ONE message: the receipt, then all questions together (numbered, answerable with "1", "2", "new" or "duplicate").

RULES
- Never invent IDs, locations or catalogue entries; only use what tools return.
- Never ask per toy; ask only about exceptions, grouped once per batch.
- Photos attached directly in chat cannot be saved; use them only for "where is" questions.
  For intake or moves, ask the operator to put photos (JPG or PNG) in the dated folder.
- If a tool says Railway is unreachable, tell the operator: nothing was saved, the photos are still in the inbox, and it is safe to retry.
- Suggest starting a new chat every ~10 batches; call inbox_folders at the start of a new chat.
```
