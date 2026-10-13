import { type Kysely, sql } from "kysely";

// Full ledger schema (master prompt §5). Later phases add features on top of these tables
// rather than reshaping them.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE SEQUENCE unit_seq;
    CREATE SEQUENCE catalog_seq;
    CREATE SEQUENCE photo_seq;
    CREATE SEQUENCE location_seq;
    CREATE SEQUENCE container_seq;
    CREATE SEQUENCE movement_seq;
    CREATE SEQUENCE batch_seq;
    CREATE SEQUENCE review_seq;

    CREATE FUNCTION tv_id(prefix text, n bigint, width int) RETURNS text
      LANGUAGE sql IMMUTABLE AS $$ SELECT prefix || '-' || lpad(n::text, width, '0') $$;

    CREATE TABLE locations (
      id          text PRIMARY KEY DEFAULT tv_id('LOC', nextval('location_seq'), 4),
      parent_id   text REFERENCES locations(id),
      name        text NOT NULL,
      path        text NOT NULL UNIQUE,
      kind        text NOT NULL CHECK (kind IN ('site','room','zone','bin','virtual')),
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX locations_parent_name ON locations (coalesce(parent_id, ''), lower(name));

    CREATE TABLE containers (
      id          text PRIMARY KEY DEFAULT tv_id('C', nextval('container_seq'), 4),
      label       text NOT NULL DEFAULT '',
      notes       text NOT NULL DEFAULT '',
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE catalog_items (
      id                  text PRIMARY KEY DEFAULT tv_id('CAT', nextval('catalog_seq'), 6),
      category            text NOT NULL,
      brand               text NOT NULL DEFAULT '',
      franchise           text NOT NULL DEFAULT '',
      series              text NOT NULL DEFAULT '',
      wave                text NOT NULL DEFAULT '',
      item_name           text NOT NULL DEFAULT '',
      model_number        text NOT NULL DEFAULT '',
      barcode             text NOT NULL DEFAULT '',
      scale               text NOT NULL DEFAULT '',
      release_year        int,
      release_year_source text CHECK (release_year_source IN ('ocr','web','inferred')),
      source_url          text,
      verified            boolean NOT NULL DEFAULT false,
      field_confidence    jsonb NOT NULL DEFAULT '{}',
      created_at          timestamptz NOT NULL DEFAULT now(),
      search_vector       tsvector GENERATED ALWAYS AS (
        to_tsvector('simple',
          coalesce(item_name,'') || ' ' || coalesce(series,'') || ' ' || coalesce(wave,'') || ' ' ||
          coalesce(brand,'') || ' ' || coalesce(franchise,'') || ' ' || coalesce(model_number,'') || ' ' ||
          coalesce(category,''))
      ) STORED
    );
    CREATE INDEX catalog_items_search ON catalog_items USING gin (search_vector);
    CREATE INDEX catalog_items_model ON catalog_items (lower(model_number)) WHERE model_number <> '';
    CREATE INDEX catalog_items_barcode ON catalog_items (barcode) WHERE barcode <> '';
    CREATE INDEX catalog_items_trgm ON catalog_items
      USING gin ((item_name || ' ' || series || ' ' || brand || ' ' || model_number) gin_trgm_ops);

    CREATE TABLE batches (
      id                text PRIMARY KEY DEFAULT tv_id('B', nextval('batch_seq'), 4),
      mode              text NOT NULL CHECK (mode IN ('intake','move','pack','count')),
      folder            text NOT NULL DEFAULT '',
      instruction       text NOT NULL DEFAULT '',
      from_location_id  text REFERENCES locations(id),
      to_location_id    text REFERENCES locations(id),
      counts            jsonb NOT NULL DEFAULT '{}',
      receipt           jsonb,
      status            text NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','undone')),
      client_key        text NOT NULL UNIQUE,
      created_at        timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE units (
      id                text PRIMARY KEY DEFAULT tv_id('TV', nextval('unit_seq'), 6),
      catalog_item_id   text NOT NULL REFERENCES catalog_items(id),
      condition         text NOT NULL,
      packaging_state   text NOT NULL DEFAULT '',
      notes             text NOT NULL DEFAULT '',
      identity          text NOT NULL DEFAULT 'distinct' CHECK (identity IN ('distinct','fungible')),
      needs_review      boolean NOT NULL DEFAULT false,
      review_reason     text,
      identity_confidence numeric(4,3),
      status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','disposed')),
      status_reason     text,
      created_batch_id  text REFERENCES batches(id),
      created_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX units_catalog ON units (catalog_item_id);

    -- Unit IDs printed on QR labels before intake (labels_print, Phase 3).
    CREATE TABLE id_reservations (
      unit_id     text PRIMARY KEY,
      reserved_at timestamptz NOT NULL DEFAULT now(),
      used_at     timestamptz
    );

    CREATE TABLE photos (
      id                    text PRIMARY KEY DEFAULT tv_id('PH', nextval('photo_seq'), 6),
      sha256                text NOT NULL UNIQUE,
      phash                 bit(64) NOT NULL,
      captured_at           timestamptz,
      logged_at             timestamptz NOT NULL DEFAULT now(),
      upload_status         text NOT NULL DEFAULT 'registered' CHECK (upload_status IN ('registered','uploaded')),
      original_key          text,
      preview_key           text,
      thumb_key             text,
      original_content_type text,
      ocr_text              text[] NOT NULL DEFAULT '{}',
      source_folder         text NOT NULL DEFAULT '',
      filename              text NOT NULL DEFAULT '',
      width                 int,
      height                int
    );

    CREATE TABLE unit_photos (
      unit_id     text NOT NULL REFERENCES units(id),
      photo_id    text NOT NULL REFERENCES photos(id),
      role        text NOT NULL CHECK (role IN ('intake','evidence')),
      extraction  jsonb,
      batch_id    text REFERENCES batches(id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (unit_id, photo_id, role)
    );
    CREATE INDEX unit_photos_photo ON unit_photos (photo_id);

    CREATE TABLE movements (
      id                text PRIMARY KEY DEFAULT tv_id('MV', nextval('movement_seq'), 6),
      type              text NOT NULL CHECK (type IN ('RECEIPT','TRANSFER','PACK','UNPACK','ADJUST','MERGE','SPLIT','DISPOSE')),
      unit_id           text REFERENCES units(id),
      container_id      text REFERENCES containers(id),
      from_location_id  text REFERENCES locations(id),
      from_container_id text REFERENCES containers(id),
      to_location_id    text REFERENCES locations(id),
      to_container_id   text REFERENCES containers(id),
      batch_id          text REFERENCES batches(id),
      evidence_photo_id text REFERENCES photos(id),
      confidence        numeric(4,3),
      method            text CHECK (method IN ('qr','text','visual','manual','carton')),
      reason            text,
      idempotency_key   text NOT NULL UNIQUE,
      created_at        timestamptz NOT NULL DEFAULT now(),
      CHECK ((unit_id IS NULL) <> (container_id IS NULL)),
      CHECK ((to_location_id IS NULL) <> (to_container_id IS NULL)),
      CHECK (type <> 'ADJUST' OR coalesce(reason, '') <> '')
    );
    CREATE INDEX movements_unit ON movements (unit_id, created_at);
    CREATE INDEX movements_container ON movements (container_id, created_at);
    CREATE INDEX movements_batch ON movements (batch_id);

    -- The ledger is append-only: corrections are compensating movements.
    CREATE FUNCTION movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'movements are append-only; write a compensating movement instead';
    END $$;
    CREATE TRIGGER movements_no_update BEFORE UPDATE OR DELETE ON movements
      FOR EACH ROW EXECUTE FUNCTION movements_append_only();

    -- Projection: exactly one row per unit and per container, updated in the same
    -- transaction as each movement. A unit in a container has container_id set and
    -- resolves to the container's location (recursively).
    CREATE TABLE stock_position (
      subject_type      text NOT NULL CHECK (subject_type IN ('unit','container')),
      subject_id        text NOT NULL,
      location_id       text REFERENCES locations(id),
      container_id      text REFERENCES containers(id),
      last_movement_id  text NOT NULL REFERENCES movements(id),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (subject_type, subject_id),
      CHECK ((location_id IS NULL) <> (container_id IS NULL))
    );
    CREATE INDEX stock_position_location ON stock_position (location_id);
    CREATE INDEX stock_position_container ON stock_position (container_id);

    CREATE VIEW unit_current_location AS
    WITH RECURSIVE chain AS (
      SELECT sp.subject_id AS unit_id, sp.location_id, sp.container_id, 0 AS depth
        FROM stock_position sp WHERE sp.subject_type = 'unit'
      UNION ALL
      SELECT c.unit_id, sp.location_id, sp.container_id, c.depth + 1
        FROM chain c
        JOIN stock_position sp ON sp.subject_type = 'container' AND sp.subject_id = c.container_id
       WHERE c.location_id IS NULL AND c.depth < 32
    )
    SELECT unit_id, location_id FROM chain WHERE location_id IS NOT NULL;

    CREATE TABLE review_tasks (
      id          text PRIMARY KEY DEFAULT tv_id('RV', nextval('review_seq'), 5),
      kind        text NOT NULL CHECK (kind IN ('uncertain_identity','unmatched_move_photo','found_elsewhere','count_discrepancy')),
      unit_id     text REFERENCES units(id),
      photo_id    text REFERENCES photos(id),
      batch_id    text REFERENCES batches(id),
      candidates  jsonb NOT NULL DEFAULT '[]',
      reason      text,
      status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      resolution  jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    );
    CREATE INDEX review_tasks_open ON review_tasks (status, created_at);

    INSERT INTO locations (name, path, kind) VALUES
      ('In transit', 'In transit', 'virtual'),
      ('Unknown', 'Unknown', 'virtual'),
      ('Disposed', 'Disposed', 'virtual');
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("ToyVault migrations are forward-only");
}
