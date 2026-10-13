import { type Kysely, sql } from "kysely";

// Phase 2: unit search index, catalogue idempotency, undo bookkeeping.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Expands "Series 3" / "Wave 2" / "Vol. 4" into short forms (s3, w2, v4) so
    -- "turbo rac s3" matches "Turbo Racers Series 3".
    CREATE FUNCTION tv_search_expand(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT t || ' ' || coalesce((
        SELECT string_agg(
                 CASE WHEN lower(m[1]) LIKE 'ser%' THEN 's'
                      WHEN lower(m[1]) LIKE 'wav%' THEN 'w'
                      ELSE 'v' END || m[2], ' ')
          FROM regexp_matches(t, '(series|wave|vol\\.?|volume)\\s*#?\\s*(\\d+)', 'gi') AS m
      ), '')
    $$;

    -- A unit's location without scanning the whole ledger: walk its carton chain.
    CREATE FUNCTION tv_unit_location(uid text) RETURNS text LANGUAGE plpgsql STABLE AS $$
    DECLARE loc text; cont text; depth int := 0;
    BEGIN
      SELECT location_id, container_id INTO loc, cont
        FROM stock_position WHERE subject_type = 'unit' AND subject_id = uid;
      WHILE loc IS NULL AND cont IS NOT NULL AND depth < 32 LOOP
        SELECT location_id, container_id INTO loc, cont
          FROM stock_position WHERE subject_type = 'container' AND subject_id = cont;
        depth := depth + 1;
      END LOOP;
      RETURN loc;
    END $$;

    -- One search document per unit (with its resolved location), refreshed in the same
    -- transaction as any change to the unit, its catalogue item, OCR text or location.
    CREATE TABLE unit_search (
      unit_id     text PRIMARY KEY REFERENCES units(id),
      location_id text REFERENCES locations(id),
      doc         text NOT NULL,
      tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', doc)) STORED,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX unit_search_tsv ON unit_search USING gin (tsv);
    CREATE INDEX unit_search_location ON unit_search (location_id);

    -- Vocabulary for typo correction ("lightnig" -> "lightning").
    CREATE TABLE search_words (word text PRIMARY KEY);
    CREATE INDEX search_words_trgm ON search_words USING gin (word gin_trgm_ops);
    CREATE INDEX search_words_prefix ON search_words (word text_pattern_ops);

    CREATE FUNCTION refresh_unit_search(ids text[]) RETURNS void LANGUAGE sql AS $$
      INSERT INTO unit_search (unit_id, location_id, doc, updated_at)
      SELECT u.id, loc.id,
             lower(tv_search_expand(concat_ws(' ',
               u.id, c.id, c.category, c.brand, c.franchise, c.series, c.wave, c.item_name,
               c.model_number, c.barcode, c.scale, u.condition, u.notes, loc.path,
               (SELECT string_agg(array_to_string(p.ocr_text, ' '), ' ')
                  FROM unit_photos up JOIN photos p ON p.id = up.photo_id
                 WHERE up.unit_id = u.id)))),
             now()
        FROM units u
        JOIN catalog_items c ON c.id = u.catalog_item_id
        CROSS JOIN LATERAL (SELECT tv_unit_location(u.id) AS id) AS here
        LEFT JOIN locations loc ON loc.id = here.id
       WHERE u.id = ANY(ids)
      ON CONFLICT (unit_id) DO UPDATE
        SET doc = EXCLUDED.doc, location_id = EXCLUDED.location_id, updated_at = now();

      INSERT INTO search_words (word)
      SELECT DISTINCT w
        FROM unit_search s, regexp_split_to_table(s.doc, '[^[:alnum:]]+') AS w
       WHERE s.unit_id = ANY(ids) AND length(w) >= 3
      ON CONFLICT DO NOTHING;
    $$;

    SELECT refresh_unit_search(array_agg(id)) FROM units;

    -- catalog_save is idempotent on a client key derived from the normalised fields.
    ALTER TABLE catalog_items ADD COLUMN client_key text UNIQUE;

    ALTER TABLE batches ADD COLUMN undone_at timestamptz;
    ALTER TABLE batches ADD COLUMN undo_receipt jsonb;
    ALTER TABLE movements ADD COLUMN compensates_movement_id text REFERENCES movements(id);

    CREATE INDEX units_status ON units (status);
    CREATE INDEX units_needs_review ON units (needs_review) WHERE needs_review;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("ToyVault migrations are forward-only");
}
