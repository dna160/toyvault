# ToyVault — Inventory & Move Tracking PRD

Oct 13, 2026 · @Mechashock

## 1. Summary

ToyVault turns Claude Desktop into a warehouse terminal for Yudi's \~10,000 toys: photos go in, a serialized, location-tracked ledger comes out. **Claude Desktop is the only entry point and does all the intelligence**: reading packaging (OCR), classifying series and category, checking product names on the web, and deciding whether two photos show the same toy. A small MCP connector on Yudi's computer pulls photos from dated folders and copies photos and records to Railway, which holds the ledger and serves a read-only web viewer.

**Version A (13 Oct 2026) — the build baseline.** Photos land in dated folders on Yudi's computer. Claude Desktop pulls them through a local connector, does all OCR, classification, web name checks and matching, and the connector copies photos and records to Railway. Railway is storage and a read-only viewer only: no AI, OCR or catalogue APIs run there, and it has no upload page. Stated moves apply automatically; everything sent is listed; review is only for low-confidence items.

The core design decision: **every physical toy is a serialized unit with its own ID (the key differentiator), and every location change is an immutable movement record**. This is how a 3PL warehouse tracks pallets; it is the only approach that stays correct at 10,000 units and a house move.

### Problem

- Yudi is moving house with a very large toy collection and no record of what he owns or where it is.
- The only reliable input is a photo. There are no barcodes in a system, no spreadsheet, no prior catalogue.
- Many toys are near-identical (same model, same series, several copies). Telling "the same toy moved" from "a second copy" is the hardest problem in the system.

### Goals

1. **Intake:** photograph a stack of toys, state the location, and get every toy logged with series, category, extracted text, timestamp and location.
2. **Track moves:** send a photo of a toy at a new location; the system recognises it as an existing unit and records the move. A new unit is created only when the user says "duplicate".
3. **Find anything fast:** search by name, series, category, brand or location and see the image instantly.
4. **Never lose a toy:** every unit always has exactly one last-known location, including "in transit".

### Non-goals (v1)

- Valuation, price lookup or resale listings.
- Any OCR, vision, embedding or catalogue API outside Claude Desktop. Railway stores and serves; it never classifies.
- Any entry point other than Claude Desktop: no upload page, no edits from the web viewer.
- A mobile app. The phone is only a camera.

### Success metrics

| Metric | Target |
| --- | --- |
| Photos sent that end up listed in the ledger | 100% (low-confidence items are listed and flagged, never held back) |
| Units that need human review | ≤ 5% of intake, ≤ 3% of moves |
| Intake throughput | ≥ 300 units per hour of operator time |
| Stated moves applied without a question | ≥ 95% |
| Auto-applied move precision (correct unit) | ≥ 98% |
| False merge (two real toys recorded as one) | < 0.5% of moves |
| Units with an unknown location | 0 |
| Search response, 10,000 units, p95 | < 300 ms |
| Re-sending the same photo creates a new record | Never (idempotent) |

## 2. Users and core journeys

There is one operator (Yudi, or whoever is helping him pack) and one entry point: a chat in Claude Desktop. Every journey starts with photos copied into a dated inbox folder and one sentence of instruction.

### J1. Bulk intake

1. Operator photographs toys with the phone (one toy per photo is the default; a "group shot" mode is allowed).
2. Photos are copied to the computer by cable or AirDrop into **a folder named by date**, e.g. `~/ToyVault/inbox/2026-10-13/`. Several sessions in a day can use sub-folders (`2026-10-13/01-garage-shelf-a/`). This is a plain file copy, not an entry point.
3. In Claude Desktop the operator types: *"Intake 2026-10-13. Location: Old House › Garage › Shelf A, bin 3."*
4. Claude pulls that folder in batches of \~20 through the connector, reads each image, extracts text and classifies. For products not yet in the catalogue, Claude checks the name with its own web search (section 6).
5. **Every photo becomes a listed unit.** The connector copies each original and its record to Railway, moves the local file to `~/ToyVault/processed/2026-10-13/`, and Claude replies with a receipt: units listed, and how many were flagged.
6. Only units below the confidence bar get a `needs_review` flag. They are already in the ledger with Claude's best guess, searchable and at the right location; review only corrects them, in chat.

### J2. Move

1. Operator copies the new photos into today's dated folder and types in Claude Desktop: *"Move 2026-11-15. From: Old House › Garage › Shelf A. To: New House › Study › Cabinet 2."* Stating the source is the normal case; it is what makes moves automatic (section 5).
2. Claude matches each photo **only against units recorded at the source**. A clear match is moved automatically. No question is asked.
3. Identical copies at the source are treated as interchangeable: one of them is moved and the count stays right.
4. Claude asks only when nothing at the source matches. It then checks the rest of the ledger and offers the likely unit ("recorded at Shelf B — move it from there?").
5. If the operator says *"this is a duplicate"*, Claude creates a new unit with the same catalogue entry as the matched one.

### J3. Move a whole box (the fast path)

1. During packing, toys go into numbered cartons. Each carton is a **container** with its own ID and label.
2. Operator types: *"Carton C-0142 is now at New House › Garage."* Every unit inside moves in one transaction.
3. Unpacking a carton onto a shelf is one more transaction. This is how a 10,000-item move stays tractable: you move \~300 cartons, not 10,000 toys.

### J4. Find

- In chat: *"Where are my Series 3 racers?"* Claude returns a thumbnail grid with locations.
- In the web app: type-ahead search over name, series, brand, category, OCR text and location, with images in results.

### J5. Count and reconcile

- Operator photographs a whole shelf and says *"Count Shelf A."* Claude compares what it sees with what the ledger expects and lists missing and unexpected units.
- Discrepancies become adjustment records with a reason, never edits that overwrite history.

## 3. System architecture

Claude Desktop is the only place anything enters the system, and it does every judgement: OCR, classification, online name checks, same-toy-or-not. A local MCP connector on Yudi's computer feeds Claude photos from dated folders and records what Claude decides. Railway is the system of record: it stores the ledger and photos and serves a read-only viewer, and runs no AI of any kind.

&#91;embedded content: ToyVault architecture · 8 components, all local\]

The connector's own processing is plain code, not AI: it decodes QR labels, computes image hashes and builds contact sheets so Claude can compare a new photo with a short list of candidates. Every write goes through a local sync queue, so intake keeps working if the internet drops during the move; Railway confirms each record before the local copy is marked synced.

### Why photos go into a folder, not into the chat

Claude can see a photo attached in a Claude Desktop chat, but it cannot hand that photo's file to an MCP tool: tool calls carry text, not images. So a photo attached in chat can be read and classified, but not saved. Every unit needs its photo saved, because the photo is the evidence and the reference for matching it later.

Dated folders solve this without adding an entry point. The phone is only a camera; photos reach the computer by cable or AirDrop into `~/ToyVault/inbox/<date>/`. In Claude Desktop, the connector reads that folder and passes each photo to Claude as an image, Claude classifies it, and the connector copies the original and its record to Railway, then moves the local file to `~/ToyVault/processed/<date>/`.

| Use | Photos come from | Works? |
| --- | --- | --- |
| Intake, moves, counts | Inbox folder, pulled by Claude Desktop through the connector | Yes: classified by Claude and saved |
| "Where is this toy?" / quick question | Attached directly in the Claude Desktop chat | Yes: Claude reads it and searches; nothing needs saving |
| Intake from photos attached in chat | Attached directly in the chat | Not supported: the record would have no photo to match against later |

### Where it runs

| Component | Runs on | Does | Never does |
| --- | --- | --- | --- |
| Claude Desktop | Yudi's computer | OCR, classification, web name checks, matching, questions | — |
| ToyVault MCP connector (stdio) | Yudi's computer, launched by Claude Desktop | Reads dated folders, IDs, QR decode, hashes, contact sheets, sync queue | Classify or decide |
| `toyvault-api` service | Railway | Authenticated writes from the connector; read API for the viewer | Accept uploads from browsers; call any AI or catalogue API |
| Postgres | Railway | Ledger, catalogue, full-text search, hashes | — |
| Bucket (S3-compatible) | Railway | Originals, previews, thumbnails; private, signed URLs | Public access |
| Web viewer | Railway, served by `toyvault-api` | Search, browse, move board, review list (read-only) | Any edit |

- The connector authenticates to Railway with a long-lived API token kept in the connector's local config, never in chat.
- `~/ToyVault/processed/` keeps a local copy of every original as a second backup.
- Data leaving the computer: previews Claude sees, Claude's own web searches, and the sync to Yudi's private Railway project. Nothing else.

| Responsibility | Claude (in Desktop) | MCP server (local code) |
| --- | --- | --- |
| Read packaging text (OCR), classify | Yes | No |
| Check product names online | Yes, with its own web search | No |
| Judge "same toy or not" | Yes | No |
| Shortlist candidates (QR, image hash, model number, location) | No | Yes |
| Assign IDs, store photos, write movements, enforce thresholds | No | Yes |
| Ask the operator | Yes | No |

## 4. Data model: an ERP-style ledger

The model separates **what a toy is** (catalogue) from **which physical toy this is** (unit), and treats location as the result of a movement log, not a field anyone edits. This is the item-master / serial-number / inventory-transaction split used by every ERP.

### Entities

| Entity | ERP analogue | Holds | Key |
| --- | --- | --- | --- |
| `catalog_item` | Item master / SKU | Brand, franchise, series, line or wave, name, model number, category, scale, release year | `CAT-000412` |
| `unit` | Serialized instance / LPN | One physical toy: catalogue link, condition, packaging state, notes, current location (projected) | `TV-004871` |
| `photo` | Attachment | Original file, thumbnail, SHA-256, perceptual hash, OCR text Claude read, capture time | `PH-019220` |
| `location` | Warehouse › zone › bin | Tree: site › room › zone › shelf or bin, with a printable label | `LOC-0087` |
| `container` | Handling unit / carton | A carton or bin that holds units and can itself move; nestable | `C-0142` |
| `movement` | Inventory transaction | Append-only: type, unit or container, from, to, timestamp, evidence photo, confidence, actor | `MV-031557` |
| `review_task` | Exception queue | Anything the system will not decide alone, with candidates and scores | `RV-00213` |
| `batch` | Receiving document | One intake or move session: instruction, location, photo count, results | `B-0058` |

### Movement types

| Type | Meaning |
| --- | --- |
| `RECEIPT` | First time a unit enters the ledger (intake) |
| `TRANSFER` | Unit or container changes location |
| `PACK` / `UNPACK` | Unit enters or leaves a container |
| `ADJUST` | Count correction with a mandatory reason (found, lost, mis-scanned) |
| `MERGE` | Two units were found to be the same toy; one is retired, history is kept |
| `SPLIT` | One unit was found to be two toys (a missed duplicate) |
| `DISPOSE` | Sold, gifted, broken or thrown away |

### Ledger rules

- Movements are never edited or deleted. A mistake is fixed by a compensating movement.
- A unit's current location = the destination of its latest movement. If it sits in a container, its location is the container's location (resolved recursively).
- Every location tree has three virtual locations: **In transit**, **Unknown** and **Disposed**. Nothing is ever without a location.
- Every write carries an idempotency key (photo SHA-256 + batch ID), so re-sending a photo cannot create a second unit.
- `logged_at` (when the system recorded it) is separate from `release_year` (read off the packaging) and `captured_at` (from the photo's EXIF).

## 5. Identity and matching: the key differentiator

The system identifies a toy through four signals in order of certainty: a printed tag, the packaging text, the image fingerprint, then Claude's visual judgement. Images alone cannot tell two sealed copies of the same toy apart, so identity must not rest on images alone.

### The differentiator: a unit ID that is physically on the toy

- At intake, each unit gets an ID such as `TV-004871`. The connector prints sheets of small QR labels (Avery-style, 65 per A4) in ID order.
- The operator sticks the label on the toy, its bag or its box before photographing it. The QR is then visible in the intake photo and every later photo.
- When the QR is readable, matching is exact and costs nothing. When it is not (label hidden, loose small parts), the system falls back to visual matching.
- Labels are **strongly recommended, not required**. The system must work photo-only, as requested; labels turn the hardest problem into a lookup.

### Matching pipeline (move mode)

1. **Source first:** when the operator states "from A", the candidate set is only the units recorded at A (and inside cartons at A). This one fact removes almost all ambiguity: a shelf holds dozens of units, not 10,000.
2. **Tag:** the connector decodes any QR label. Hit = exact match, confidence 1.0.
3. **Text:** Claude reads model numbers, SKU codes, series and wave numbers. An exact model-number match within A is usually decisive on its own.
4. **Shortlist:** the connector narrows the units at A by catalogue item and image hash, and returns their reference thumbnails as one contact-sheet image.
5. **Claude decides:** Claude compares the new photo with the contact sheet and names the unit. No embedding model or other AI runs outside Claude Desktop.

### Decision thresholds

**Answer to "can a photo alone move a toy from A to B?" — yes.** When the source is stated, the system is not identifying a toy among 10,000; it is picking one out of the few dozen recorded at A. That is reliable enough to apply automatically.

| Situation | Action |
| --- | --- |
| Source stated; best match at A ≥ 0.80 and one catalogue item clearly ahead | **Moved automatically.** Listed in the receipt |
| Source stated; several identical copies at A match | **Moved automatically** (one copy, marked `fungible`). Counts stay correct |
| Source stated; nothing at A ≥ 0.80, but a unit elsewhere ≥ 0.92 | Moved automatically, flagged "found at a different location than stated" |
| Source stated; nothing anywhere ≥ 0.80 | Asked in chat: new toy, or missed intake? Never auto-created |
| No source stated | Whole-ledger match: auto-move at ≥ 0.92 with a clear winner, otherwise ask |
| User says "duplicate" | New unit on the same catalogue entry; reason logged |

Thresholds are configuration, tuned in the pilot against 200 known moves. The goal is ≥ 95% of stated moves applied without a question.

Every automatic move appears in the batch receipt and can be undone with one command.

### Identical copies (the twin problem)

- When several units of one catalogue item have no distinguishing marks, the system cannot know which twin moved, and it does not need to. It moves one of the twins at the stated source and marks the record `identity: fungible`.
- Location counts stay right, which is what matters for finding toys. Twins are never sent to review for this reason alone.
- Labelling is still the way to get exact per-twin history for valuable items; the web app can list unlabelled twins as an optional to-do, not a review task.

### Intake-mode duplicate check

In intake mode every photo is listed as a new unit. The only exception is the same photo sent twice (identical file hash, or near-identical perceptual hash within the same batch): that is skipped silently and noted in the receipt. A second copy of a known toy is simply a new unit on the existing catalogue entry; Claude does not ask.

## 6. Classification and OCR extraction

Claude does OCR and classification in one pass per image and returns a fixed JSON shape; nothing is free text except notes. No separate OCR engine is needed for v1, because Claude reads packaging text directly. The server still runs a cheap QR/barcode decoder (deterministic, free).

### Taxonomy (controlled vocabulary)

Two axes, as requested: **series** (what line it belongs to) and **category** (what kind of product it is).

| Level | Example values | Source |
| --- | --- | --- |
| Category | Die-cast vehicle, Action figure, Building set, Model kit, Plush, Doll, Vinyl / designer figure, Trading cards, Board game, RC / electronic, Blind box, Accessory, Other | Fixed list, extendable by operator only |
| Brand / manufacturer | As printed on packaging | OCR, normalised against a brand table |
| Franchise | As printed or recognised | OCR + Claude recognition |
| Series / line | Series name and wave or set number | OCR first; recognition second |
| Item name | Product name on packaging | OCR |
| Model / SKU number | Catalogue or set number | OCR (highest-value field for matching) |
| Scale | 1:64, 1:144, 6-inch, etc. | OCR or inferred |
| Release year | Copyright year on packaging | OCR; marked `inferred` if guessed |
| Condition | Sealed (MIB), Opened, Loose complete, Loose incomplete, Damaged | Claude visual |

### Extraction contract (per photo)

```json
{
  "photo_id": "PH-019220",
  "qr": null,
  "ocr_text": ["...raw lines read from packaging..."],
  "category": "Die-cast vehicle",
  "brand": "...", "franchise": "...", "series": "...", "wave": "3",
  "item_name": "...", "model_number": "...", "scale": "1:64",
  "release_year": 2019, "release_year_source": "ocr",
  "condition": "Sealed",
  "field_confidence": {"series": 0.95, "model_number": 0.99},
  "needs_review": false, "review_reason": null
}
```

### Rules

- **Everything sent is listed.** A unit is created for every photo, even when some fields are uncertain. Uncertain fields hold Claude's best guess, marked `unverified`, and stay searchable.
- **Review is the exception, not a step.** A unit goes to review only when its *identity* is uncertain after Claude's online name check: combined confidence below 0.60 on the catalogue match, or the category itself is unclear. Target: ≤ 5% of intake.
- A low-confidence minor field (scale, release year) never sends a unit to review; it is just marked `unverified`.
- New series and brands confirmed by an online source are created automatically. Unconfirmed ones are created too, marked `unverified`, and merged later if they turn out to be a spelling variant.
- Catalogue entries are reused: the 40th copy of a known item links to the existing `catalog_item`, so it costs no lookup and no judgement.
- Raw OCR text is kept on every photo so search can find words Claude did not map to a field.

### Online name check by Claude (before anything reaches review)

**Yes — Claude checks the name online before anything goes to review, using Claude Desktop's own web search.** No external catalogue API is called by the connector. The check runs once per new product, not per unit; repeat copies reuse the result. With 10,000 units the number of distinct products is likely a few thousand, and most are checked once early in intake.

1. **Local catalogue first:** the connector matches model number, barcode or series against products already recorded. Most units stop here, with no search.
2. **Claude web search:** for a new product, Claude searches the text it read (brand, series, model or set number, barcode digits) and opens the most relevant result, such as the maker's product page, a set database or a collector wiki.
3. **Claude compares:** Claude checks the result against the photo (packaging art, number, colours) and settles the official name, series and release year.
4. **Write back:** the confirmed fields go into `catalog_item` with the source URL kept for audit. Confidence rises when a source agrees.

Only when the search leaves the identity uncertain does the unit go to review, already listed with Claude's best guess and the closest search results attached.

Trade-off: web searches use chat context and time. Claude groups a batch's new products and searches them together, and skips search when the packaging already shows a model number the local catalogue knows. Web search must be turned on in Claude Desktop; online data never overwrites a field the operator corrected by hand.

## 7. MCP connector: tool specification

The connector is a local MCP server (stdio) launched by Claude Desktop. It owns IDs, files and the sync to Railway, and makes no judgements: every tool either hands Claude something to look at or records what Claude decided. Tools are coarse-grained and batch-first, so a 20-photo batch costs a handful of calls, not 100. Reads that need the whole ledger (search, candidates at a shelf) are answered by Railway through the connector.

**Photos:** the connector reads the local inbox folder and returns downscaled previews (1024 px) to Claude as image content; originals stay on disk. Section 3 explains why photos attached in chat can't be saved.

### Tools

| Tool | Purpose | Key inputs | Returns |
| --- | --- | --- | --- |
| `inbox_folders` | List dated folders and what is unprocessed in each | — | Folders with counts |
| `inbox_next_batch` | Pull the next photos from a dated folder for Claude to see | `folder` (e.g. `2026-10-13`), `size` (default 20), `max_px` (default 1024) | Photo IDs + image content + decoded QR/barcode + EXIF time + same-photo warnings |
| `location_resolve` | Turn "Old House › Garage › Shelf A" into a location; missing levels are created | path text | `LOC-…`, created flag |
| `catalog_find` | Catalogue lookup in Railway | model number, barcode, series, name | Matching entries, or none (Claude then searches the web) |
| `catalog_save` | Store a product Claude identified, with the source URL Claude used | fields, source URL, confidence | `CAT-…` |
| `units_create` | Intake: list every photo as a unit (atomic per batch), copy originals to Railway, archive local files | batch ID, location, Claude's extraction per photo | Unit IDs, flagged count, sync status |
| `shelf_candidates` | For a move: shortlist units at the stated source for each photo | photo IDs, `from` | Contact-sheet image per photo + candidate IDs |
| `movements_record` | Record the moves Claude decided (atomic, idempotent) | list of {unit or container, from, to, type, evidence photo, confidence} | Movement IDs |
| `container_create` / `container_move` | Cartons: create, print label, move with contents | container ID, location | Container + contents count |
| `unit_duplicate` | User said "duplicate": new unit on the same catalogue entry | source unit ID, photo ID | New unit ID |
| `review_list` / `review_resolve` | Work the small exception queue in chat | filters / decision | Tasks / result |
| `search` | Inventory search for chat answers | query, filters | Units with thumbnails and locations |
| `count_reconcile` | Shelf count: expected vs what Claude saw | location, unit IDs Claude matched | Missing, unexpected, adjustments proposed |
| `sync_status` | What is queued, synced or failed | — | Counts, oldest pending, last error |
| `labels_print` | PDF of QR labels for the next N IDs or a container | count or container | File path |
| `undo_batch` | Reverse a whole batch with compensating movements | batch ID | Movements reversed |

### Contract rules

- Every write takes an `idempotency_key`; replays return the original result.
- Every write is all-or-nothing per batch; a half-applied batch cannot exist.
- Tools return compact JSON plus, where useful, small thumbnails (≤ 256 px) so Claude can show results in chat.
- Tool descriptions include the decision thresholds, so Claude's behaviour and the server's rules stay in one place.
- A project instruction (system prompt) in Claude Desktop holds the operating procedure: batch size, taxonomy, when to ask, receipt format.

## 8. Search and UI/UX

Chat is where work happens; the web app is where you look things up. Both read the same database. The UI mock-ups are in a separate design file linked at the end of this document.

### In Claude Desktop (the entry point)

- **Batch receipt** after every intake or move: counts (listed, moved, flagged), a thumbnail strip of what was logged, and the batch ID for undo. No per-toy confirmation.
- **Questions only for the exceptions:** a move photo that matches nothing, or an intake photo whose identity stays uncertain after the online check. All of a batch's questions come together in one message, answered with "1", "2", "new" or "duplicate".
- **Chat search:** natural-language questions answered with a thumbnail grid and locations.
- One message = one instruction. The first line states the mode and locations ("Intake. Location: …" / "Move. From: … To: …").

### Web viewer (on Railway, read-only)

| Screen | What it shows (nothing here changes data) |
| --- | --- |
| Search | One search box with type-ahead; filter chips for category, series, brand, location, condition, unverified; image grid or table view; 10,000 units scroll without paging stalls |
| Unit detail | Photo gallery, all fields with confidence and the web source Claude used, current location breadcrumb, movement timeline, other copies |
| Locations | Tree of site › room › zone › bin with unit counts; carton contents; "In transit" and "Unknown" pinned at the top |
| Review list | The small exception queue (target ≤ 5%), for reference; each item shows the phrase to resolve it in Claude Desktop |
| Move board | Progress of the house move: units and cartons at old house, in transit, at new house, with stragglers |
| Batches | Every session with its receipt; undo is done by asking Claude |

### Search requirements

- Full-text search (Postgres) across name, series, brand, franchise, model number, OCR text, notes and location path.
- Fuzzy and prefix matching, so "turbo rac s3" finds "Turbo Racers Series 3".
- **Search by photo:** attach a photo in Claude Desktop and ask "where is this?"; Claude reads it and runs the search.
- Results show a thumbnail first; full images load on demand.
- p95 under 300 ms at 10,000 units and 30,000 photos, on the Railway service.

### UX principles

- Show the image wherever a toy is named. Nobody recognises `TV-004871`.
- Every automatic decision is visible and reversible (receipt + undo).
- The system asks rather than guesses, but asks in batches, not one toy at a time.
- Locations read as breadcrumbs (Old House › Garage › Shelf A), never as codes.

## 9. Scale, cost and non-functional requirements

At 10,000 units the bottleneck is not the database; it is the operator's time and Claude's per-chat context. The design keeps all state in the database so any chat can pick up where the last stopped.

### Sizing (planning estimates)

| Quantity | Estimate | Basis |
| --- | --- | --- |
| Units | 10,000 | Stated |
| Photos at intake | \~15,000 | \~1.5 photos per unit (front, plus back for some boxes) |
| Intake batches | \~750 | 20 photos per batch |
| Original photos (Railway bucket, plus local `processed/` copy) | \~45 GB each | \~3 MB per phone photo |
| Previews + thumbnails (bucket) | \~1 GB | 1024 px and 256 px JPEGs |
| Postgres | < 2 GB | Records, full-text index, image hashes |
| Distinct products needing a web check | a few thousand | One check per new product, not per unit |
| Units expected in review | ≤ 500 | 5% target of 10,000 |
| Cartons for the move | \~300 | \~30 units per carton |

### Working within Claude Desktop

- **Chats are disposable, the ledger is not.** Start a new chat every \~10 batches. Long chats fill context with images and slow down; `inbox_status` tells a fresh chat exactly what is left.
- Claude sees 1024 px previews, not 12 MP originals. This is enough to read packaging and keeps each batch small.
- Web checks also use chat context. Expect early batches (all-new products) to be slower than later ones, where most toys hit the local catalogue.
- Plan usage around the Claude plan's limits: 750 batches is many sessions over days. Because everything runs in Claude Desktop, intake speed is set by the plan, not by the software. Spread intake across days and start with the shelves that will be packed first.

### Non-functional requirements

| Area | Requirement |
| --- | --- |
| Integrity | Append-only movements; atomic batches; idempotent writes keyed on photo SHA-256 + batch ID; nightly integrity check (every unit has exactly one location; container cycles impossible) |
| Offline tolerance | Local sync queue; intake and moves keep working without internet and sync later; `sync_status` shows anything pending |
| Backup | Railway Postgres backups daily; local `processed/` folder keeps every original; weekly database export to the computer; restore tested before the move |
| Security | API token for the connector; login for the viewer; private bucket with signed URLs; no write endpoints reachable from the browser |
| Privacy | Railway stores data only. Previews Claude sees and Claude's web searches are the only other data leaving the computer |
| Performance | Search p95 < 300 ms; connector tool calls < 3 s for a 20-photo batch excluding Claude's reasoning and photo sync time |
| Recoverability | `undo_batch` for any batch; full movement history per unit |
| Export | CSV and XLSX export of units with locations and photo links, on request in Claude Desktop |

## 10. Build plan for Claude Code

One TypeScript monorepo with two deployables: the local MCP connector installed on Yudi's computer, and `toyvault-api` on Railway (with Postgres and a bucket). Claude Code can build it in five phases, each ending in something Yudi can use. The kick-off prompt for Claude Code is in the Related section.

### Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Connector | TypeScript, official MCP SDK, stdio transport | Launched by Claude Desktop; image content in tool results |
| Local queue | SQLite (WAL) for the sync queue and folder state | Survives restarts and offline periods |
| Images | `sharp` for previews, thumbnails, contact sheets, EXIF and perceptual hash | Fast, local, no Python |
| QR / barcodes | ZXing-based decoder | Deterministic, local, free |
| API | Fastify on Railway, token auth for the connector, session login for the viewer | Small, fast, typed |
| Database | Railway Postgres + full-text search (`tsvector`, `pg_trgm` for fuzzy) | Transactions for atomic batches; search in one place |
| Photo storage | Railway bucket (S3-compatible), signed URLs | Originals never in the database |
| Web viewer | Vite + React + Tailwind, read-only, served by `toyvault-api` | No write endpoints exposed to the browser |
| Labels | PDF generation (QR sheets, carton labels) | Print at home |

### Repository layout

```
toyvault/
  packages/shared/     # types, zod schemas, ID formats, thresholds
  packages/connector/  # local MCP server (stdio): tools, folders, images, sync queue
  packages/api/        # Railway service: write API, read API, viewer hosting, migrations
  packages/viewer/     # read-only React app
  infra/railway/       # service config, env var list, bucket setup
  scripts/             # install connector into Claude Desktop, seed, backup export
  prompts/             # Claude Desktop project instructions + extraction contract
  tests/fixtures/      # labelled photo set for matching evaluation
```

### Phases

1. **Spike (3–4 days):** connector skeleton in Claude Desktop, a bare `toyvault-api` on Railway, 50 real photos from Yudi's shelves. Prove Claude's extraction quality, QR decoding on packaging, web-check hit rate, contact-sheet matching within one shelf, and photo sync. Exit: ≥ 90% series accuracy, ≥ 95% correct auto-moves within a stated shelf.
2. **Intake MVP:** dated folders, locations, `units_create`, catalogue reuse, web-checked new products, sync queue, batch receipts, undo, read-only viewer with images. Exit: 500 real units listed in one sitting with ≤ 5% flagged, all synced.
3. **Move and match:** `shelf_candidates`, source-constrained matching, fungible twins, duplicate flow, review in chat, containers and labels. Exit: 200-move labelled test at ≥ 98% precision and ≥ 95% applied without a question.
4. **Move-day tooling:** move board, carton pack/unpack, shelf counts, "In transit" handling, offline drill, backups and a restore drill. Exit: full dry run of one room from old house to new house.
5. **Scale and polish:** CSV/XLSX export, performance at 10,000 units, Claude Desktop project instructions tuned from the pilot. Exit: all success metrics in section 1 met.

### Risks

| Risk | Mitigation |
| --- | --- |
| Photos attached in chat can't be saved by the connector | Photos go through dated folders; chat attachments are for questions only |
| Internet drops during intake or on move day | Local sync queue; work continues and syncs later |
| Operator forgets to state the source | Claude asks for the source once per batch before matching |
| Wrong toy auto-moved | Source-constrained matching; every move in the receipt; one-command undo |
| Identical sealed toys cannot be told apart | `fungible` identity keeps counts right; optional QR labels for valuable items |
| Web search finds nothing for niche or regional toys | Unit is still listed with Claude's reading, marked `unverified` |
| Claude plan limits slow intake | Plan intake across days; prioritise shelves packed first |
| API token leaks | Token only in the connector's local config; rotate from Railway variables |
| Operator fatigue over 750 batches | Container-first moves; no per-toy confirmation; resumable sessions |

### Open questions

- [ ] Which computer runs Claude Desktop and the connector, and does it have \~50 GB free for the local `processed/` copy?
- [ ] Is there a Railway workspace to deploy into, and who pays for it?
- [ ] Is web search enabled in Yudi's Claude Desktop?
- [ ] Will Yudi accept QR labels on valuable items, even if not on everything?
- [ ] Who besides Yudi needs a viewer login?
- [ ] Is there a target move date that fixes the timeline?

## Related

- [ToyVault UI/UX design](https://claude.ai/artifact/42vuZ9qzEUpkhSnfrL2qED): six screens — intake receipt and move-and-match in Claude Desktop; search, unit detail, review queue and move board in the web viewer. Toy names in the mock-ups are placeholders.

* **Claude Code master prompt (Version A):** saved in the Yudi Toys project as `claude/toyvault-master-prompt-version-a.md`. Paste it as the first message in Claude Code; it also contains the Claude Desktop operating instructions (Appendix A).
