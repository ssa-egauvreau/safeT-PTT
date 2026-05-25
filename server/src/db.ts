import pg from "pg";

const { Pool } = pg;

export type ChannelRow = { id: number; name: string };

/** Slug of the tenant that pre-existing single-tenant data is migrated into. */
export const DEFAULT_AGENCY_SLUG = "default";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }
  if (!pool) {
    // Cap on concurrent Postgres connections per node. Default 20 is comfortable for the typical
    // polling load (Android handsets at ~5 req/s/user + the dispatch console); the prior cap of
    // 5 throttled requests under any moderate concurrency. Override via DB_POOL_MAX env when
    // running multiple Node instances behind a load balancer to keep total pool size sane.
    // Parse explicitly so DB_POOL_MAX=0 is clamped to 1 (the documented floor) rather than
    // silently falling through `|| 20` and quietly opening 20 connections.
    const parsed = Number.parseInt(process.env.DB_POOL_MAX ?? "", 10);
    const max = Number.isFinite(parsed)
      ? Math.max(1, Math.min(200, parsed))
      : 20;
    // Parse the connection string so the SSL toggle keys off the hostname only — substring
    // matching on "localhost" would also skip TLS for prod URLs that happen to contain that
    // word anywhere (host segment, query param, password).
    let isLocal = false;
    try {
      const host = new URL(url).hostname;
      isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
      // Malformed URL → leave TLS on; pg will fail to connect and surface the real error.
    }
    pool = new Pool({
      connectionString: url,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max,
    });
    // Statement-level timeout would be nice to bound a runaway query against the shared pool,
    // but setting it on the Pool would also apply to ensureSchema()'s bootstrap migrations
    // (full-table backfills, CREATE INDEX) that can legitimately exceed any short ceiling on
    // a populated database. Re-introducing this safely needs either a separate migration pool
    // or per-request scoping (`SET LOCAL statement_timeout`); skip for now rather than risk a
    // half-applied schema on boot.
  }
  return pool;
}

/** Like {@link getPool} but throws `database_unavailable` when no DB is configured. */
export function requirePool(): pg.Pool {
  const p = getPool();
  if (!p) {
    throw new Error("database_unavailable");
  }
  return p;
}

/**
 * Upgrades a legacy single-column `unit_id` primary key to a tenant-scoped
 * `(agency_id, unit_id)` composite. Idempotent — a no-op once already composite.
 */
async function ensureAgencyScopedKey(p: pg.Pool, table: "unit_aliases" | "radio_positions"): Promise<void> {
  const res = await p.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary;`,
    [table],
  );
  if (Number(res.rows[0]?.n ?? "0") > 1) {
    return;
  }
  await p.query(`ALTER TABLE ${table} ALTER COLUMN agency_id SET NOT NULL;`);
  await p.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey;`);
  await p.query(`ALTER TABLE ${table} ADD PRIMARY KEY (agency_id, unit_id);`);
}

/** Whether `table` already has `column` — used to run a migration backfill exactly once. */
async function columnExists(p: pg.Pool, table: string, column: string): Promise<boolean> {
  const res = await p.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2;`,
    [table, column],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Creates every table the platform needs, migrates a single-tenant database
 * into the default agency, and seeds the default channels. Safe to run on each boot.
 */
export async function ensureSchema(): Promise<void> {
  const p = getPool();
  if (!p) {
    return;
  }

  // --- tenants -----------------------------------------------------------
  await p.query(`
    CREATE TABLE IF NOT EXISTS agencies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      radio_key TEXT UNIQUE,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Optional agency-branding logo, uploaded by an agency admin.
  await p.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS logo BYTEA;`);
  await p.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS logo_mime TEXT;`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS radio_channels (
      id SERIAL PRIMARY KEY,
      sort_order INT NOT NULL DEFAULT 0,
      name TEXT NOT NULL
    );
  `);
  await p.query(`ALTER TABLE radio_channels ADD COLUMN IF NOT EXISTS color TEXT;`);
  await p.query(`ALTER TABLE radio_channels ADD COLUMN IF NOT EXISTS zone TEXT;`);
  await p.query(
    `ALTER TABLE radio_channels ADD COLUMN IF NOT EXISTS agency_id INT REFERENCES agencies(id) ON DELETE CASCADE;`,
  );

  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'radio',
      unit_id TEXT,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Platform `owner` accounts have no agency, so this column stays nullable.
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS agency_id INT REFERENCES agencies(id) ON DELETE CASCADE;`);
  // Device category the admin assigns to an account (unit_radio, handheld, …).
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS device_type TEXT;`);
  // Newest sign-in wins: incremented on each login; tokens carry the value as
  // their `gen` claim and are rejected once the user's row moves past it.
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_generation INT NOT NULL DEFAULT 0;`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS channel_members (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INT NOT NULL REFERENCES radio_channels(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'talk',
      PRIMARY KEY (user_id, channel_id)
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id INT,
      actor_name TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail JSONB,
      ip TEXT
    );
  `);
  // Captured before the column is added: audit_log.agency_id is intentionally
  // left NULL for platform-level events, so the backfill below must run once only.
  const auditAgencyIdExisted = await columnExists(p, "audit_log", "agency_id");
  await p.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS agency_id INT REFERENCES agencies(id) ON DELETE CASCADE;`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS transmissions (
      id SERIAL PRIMARY KEY,
      channel_id INT REFERENCES radio_channels(id) ON DELETE SET NULL,
      channel_name TEXT NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      unit_id TEXT,
      display_name TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      duration_ms INT NOT NULL DEFAULT 0,
      sample_rate INT NOT NULL DEFAULT 16000,
      audio BYTEA,
      audio_mime TEXT NOT NULL DEFAULT 'audio/wav',
      transcript TEXT,
      transcript_status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  await p.query(
    `ALTER TABLE transmissions ADD COLUMN IF NOT EXISTS agency_id INT REFERENCES agencies(id) ON DELETE CASCADE;`,
  );

  // GPS positions, keyed per agency + radio unit id so handsets without an
  // account can still report position and unit ids never collide across tenants.
  await p.query(`DROP TABLE IF EXISTS radio_locations;`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS radio_positions (
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      display_name TEXT,
      channel_name TEXT,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      accuracy_m DOUBLE PRECISION,
      heading DOUBLE PRECISION,
      speed_mps DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agency_id, unit_id)
    );
  `);
  await p.query(
    `ALTER TABLE radio_positions ADD COLUMN IF NOT EXISTS agency_id INT REFERENCES agencies(id) ON DELETE CASCADE;`,
  );
  // Track the platform the unit is reporting from (ios | android | web | …) so
  // the iOS UNITS roster and other consoles can show a platform badge per row.
  // Null when the client hasn't been updated to send `client_type` yet.
  await p.query(
    `ALTER TABLE radio_positions ADD COLUMN IF NOT EXISTS client_type TEXT;`,
  );

  await p.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      channel_name TEXT,
      target_unit TEXT,
      from_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      from_name TEXT,
      from_unit TEXT,
      message TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      cleared_by TEXT,
      cleared_at TIMESTAMPTZ
    );
  `);
  await p.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS agency_id INT REFERENCES agencies(id) ON DELETE CASCADE;`);

  // Friendly labels for radio unit IDs, scoped per agency.
  await p.query(`
    CREATE TABLE IF NOT EXISTS unit_aliases (
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL,
      label TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agency_id, unit_id)
    );
  `);
  await p.query(
    `ALTER TABLE unit_aliases ADD COLUMN IF NOT EXISTS agency_id INT REFERENCES agencies(id) ON DELETE CASCADE;`,
  );

  // Per-agency custom radio tones (talk permit, channel change, emergency, busy).
  await p.query(`
    CREATE TABLE IF NOT EXISTS agency_sounds (
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      audio BYTEA NOT NULL,
      mime TEXT NOT NULL,
      byte_size INT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agency_id, kind)
    );
  `);

  // Custom soundboard tone-outs — operator-fired audio clips that supplement
  // the built-in Routine / Priority / Status tones in the console.
  await p.query(`
    CREATE TABLE IF NOT EXISTS agency_tone_outs (
      id SERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      play_mode TEXT NOT NULL DEFAULT 'once',
      icon_kind TEXT NOT NULL DEFAULT 'waveform',
      icon_color TEXT NOT NULL DEFAULT '#22c5e5',
      icon_image BYTEA,
      icon_mime TEXT,
      audio BYTEA,
      audio_mime TEXT,
      audio_bytes INT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Simulcast channels — one transmission fanned out to several real channels.
  await p.query(`
    CREATE TABLE IF NOT EXISTS simulcast_channels (
      id SERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await p.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_simulcast_agency_name ON simulcast_channels (agency_id, lower(name));`,
  );
  await p.query(`
    CREATE TABLE IF NOT EXISTS simulcast_members (
      simulcast_id INT NOT NULL REFERENCES simulcast_channels(id) ON DELETE CASCADE,
      channel_id INT NOT NULL REFERENCES radio_channels(id) ON DELETE CASCADE,
      PRIMARY KEY (simulcast_id, channel_id)
    );
  `);

  // Radio bridges — external audio sources (scanner stream URLs, line-in) fed
  // onto a channel, VOX-gated so they never hold the air during silence.
  await p.query(`
    CREATE TABLE IF NOT EXISTS radio_bridges (
      id SERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_url TEXT,
      device_hint TEXT,
      target_channel TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'inbound',
      yield_to_units BOOLEAN NOT NULL DEFAULT TRUE,
      tx_mode TEXT NOT NULL DEFAULT 'passthrough',
      vox_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.02,
      vox_hang_ms INT NOT NULL DEFAULT 1500,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Map geofences — circle or custom-polygon overlay zones an operator draws.
  await p.query(`
    CREATE TABLE IF NOT EXISTS geofences (
      id SERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      shape TEXT NOT NULL DEFAULT 'circle',
      color TEXT,
      center_lat DOUBLE PRECISION NOT NULL,
      center_lon DOUBLE PRECISION NOT NULL,
      radius_m DOUBLE PRECISION NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Polygon geofences carry a vertex list instead of a centre/radius.
  await p.query(`ALTER TABLE geofences ADD COLUMN IF NOT EXISTS points JSONB;`);
  await p.query(`ALTER TABLE geofences ALTER COLUMN center_lat DROP NOT NULL;`);
  await p.query(`ALTER TABLE geofences ALTER COLUMN center_lon DROP NOT NULL;`);
  await p.query(`ALTER TABLE geofences ALTER COLUMN radius_m DROP NOT NULL;`);

  // GPS log — every position report appended, so the console can replay a
  // radio's track. radio_positions keeps only the latest fix per unit.
  await p.query(`
    CREATE TABLE IF NOT EXISTS radio_position_history (
      id BIGSERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      accuracy_m DOUBLE PRECISION,
      heading DOUBLE PRECISION,
      speed_mps DOUBLE PRECISION,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 10-33 channel markers — a dispatcher flags a channel for emergency traffic.
  await p.query(`
    CREATE TABLE IF NOT EXISTS channel_markers (
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      channel_name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agency_id, channel_name)
    );
  `);

  // Per-agency integration secrets (API keys, webhooks) — tenant-isolated.
  await p.query(`
    CREATE TABLE IF NOT EXISTS agency_integrations (
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      integration_key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (agency_id, integration_key)
    );
  `);

  // Per-channel AI dispatcher toggle (voice loop uses platform env + agency integrations).
  await p.query(`
    CREATE TABLE IF NOT EXISTS channel_ai_dispatch (
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      channel_name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      yields_to_units BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agency_id, channel_name)
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS ai_dispatch_log (
      id BIGSERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      transmission_id INT REFERENCES transmissions(id) ON DELETE SET NULL,
      channel_name TEXT,
      unit_id TEXT,
      transcript TEXT NOT NULL,
      intent TEXT,
      summary TEXT,
      dispatcher_response TEXT,
      trigger_emergency_tone BOOLEAN NOT NULL DEFAULT FALSE,
      plate_lookup JSONB,
      ten8_actions JSONB,
      error TEXT,
      duration_ms INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_dispatch_log_agency_ts
      ON ai_dispatch_log (agency_id, created_at DESC);
  `);
  await p.query(`ALTER TABLE ai_dispatch_log ADD COLUMN IF NOT EXISTS outcome TEXT;`);

  // AI dispatcher knowledge base — admin-uploaded reference documents (post
  // orders, route sheets, policies). Original PDF kept in `content`; the
  // extracted text is split into embedded chunks (agency_kb_chunks) that the
  // dispatcher retrieves from at call time (RAG) instead of stuffing every
  // document into the cached system prompt.
  await p.query(`
    CREATE TABLE IF NOT EXISTS agency_kb_documents (
      id SERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      property_code TEXT,
      filename TEXT,
      mime TEXT NOT NULL DEFAULT 'application/pdf',
      byte_size INT NOT NULL DEFAULT 0,
      content BYTEA NOT NULL,
      extracted_text TEXT,
      status TEXT NOT NULL DEFAULT 'processing',
      error TEXT,
      chunk_count INT NOT NULL DEFAULT 0,
      uploaded_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_docs_agency ON agency_kb_documents (agency_id, created_at DESC);
  `);
  // The embedding model used to index this document's chunks. A model swap
  // leaves old vectors at a different dimension/space, so retrieval ignores
  // mismatched chunks and the admin UI flags the document for re-indexing.
  await p.query(`ALTER TABLE agency_kb_documents ADD COLUMN IF NOT EXISTS embed_model TEXT;`);

  // One embedded passage of a knowledge-base document. Similarity search runs in
  // Node (cosine over the REAL[] vector) — no pgvector extension required at this
  // scale. Chunks cascade-delete with their document.
  await p.query(`
    CREATE TABLE IF NOT EXISTS agency_kb_chunks (
      id BIGSERIAL PRIMARY KEY,
      document_id INT NOT NULL REFERENCES agency_kb_documents(id) ON DELETE CASCADE,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      embedding REAL[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_agency ON agency_kb_chunks (agency_id);
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS ten8_incidents (
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      action TEXT,
      is_closed BOOLEAN NOT NULL DEFAULT FALSE,
      incident_type TEXT,
      priority TEXT,
      status TEXT,
      location TEXT,
      payload JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agency_id, call_id)
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS ten8_webhook_log (
      id BIGSERIAL PRIMARY KEY,
      agency_id INT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      action TEXT,
      call_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}',
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ten8_webhook_log_agency_ts
      ON ten8_webhook_log (agency_id, received_at DESC);
  `);

  // --- migrate any pre-existing single-tenant data into the default agency ---
  const def = await p.query<{ id: number }>(
    `INSERT INTO agencies (name, slug)
       VALUES ('Default Agency', $1)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id;`,
    [DEFAULT_AGENCY_SLUG],
  );
  const defaultAgencyId = def.rows[0]!.id;

  await p.query(`UPDATE radio_channels SET agency_id = $1 WHERE agency_id IS NULL;`, [defaultAgencyId]);
  // Platform owners legitimately have a null agency, so they are left untouched.
  await p.query(`UPDATE users SET agency_id = $1 WHERE agency_id IS NULL AND role <> 'owner';`, [defaultAgencyId]);
  await p.query(`UPDATE transmissions SET agency_id = $1 WHERE agency_id IS NULL;`, [defaultAgencyId]);
  await p.query(`UPDATE alerts SET agency_id = $1 WHERE agency_id IS NULL;`, [defaultAgencyId]);
  // Only on the migration boot — afterwards a NULL agency_id marks a platform
  // event (e.g. agency deletion) and must not be reassigned to a tenant.
  if (!auditAgencyIdExisted) {
    await p.query(`UPDATE audit_log SET agency_id = $1 WHERE agency_id IS NULL;`, [defaultAgencyId]);
  }
  await p.query(`UPDATE unit_aliases SET agency_id = $1 WHERE agency_id IS NULL;`, [defaultAgencyId]);
  await p.query(`UPDATE radio_positions SET agency_id = $1 WHERE agency_id IS NULL;`, [defaultAgencyId]);

  await ensureAgencyScopedKey(p, "unit_aliases");
  await ensureAgencyScopedKey(p, "radio_positions");

  await p.query(`ALTER TABLE radio_channels ALTER COLUMN agency_id SET NOT NULL;`);
  // Channel names are unique per agency, not globally.
  await p.query(`ALTER TABLE radio_channels DROP CONSTRAINT IF EXISTS radio_channels_name_key;`);
  await p.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_radio_channels_agency_name ON radio_channels (agency_id, name);`,
  );

  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_agency ON audit_log (agency_id, ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_tx_started ON transmissions (started_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_tx_agency ON transmissions (agency_id, started_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_alerts_agency ON alerts (agency_id, created_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_geofences_agency ON geofences (agency_id, created_at DESC);`);
  await p.query(
    `CREATE INDEX IF NOT EXISTS idx_pos_history_unit ON radio_position_history (agency_id, unit_id, recorded_at DESC);`,
  );

  const countRes = await p.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM radio_channels WHERE agency_id = $1;`,
    [defaultAgencyId],
  );
  if (Number(countRes.rows[0]?.count ?? "0") === 0) {
    await p.query(
      `INSERT INTO radio_channels (agency_id, sort_order, name) VALUES
        ($1, 1, 'Green 1'),
        ($1, 2, 'Green 2'),
        ($1, 3, 'Green 3');`,
      [defaultAgencyId],
    );
  }
}

export async function listChannelsFromDb(agencyId: number): Promise<ChannelRow[] | null> {
  const p = getPool();
  if (!p) {
    return null;
  }
  const res = await p.query<ChannelRow>(
    "SELECT id, name FROM radio_channels WHERE agency_id = $1 ORDER BY sort_order ASC, id ASC;",
    [agencyId],
  );
  return res.rows;
}
