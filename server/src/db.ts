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
    pool = new Pool({
      connectionString: url,
      ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
    });
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
