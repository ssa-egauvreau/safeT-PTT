import pg from "pg";

const { Pool } = pg;

export type ChannelRow = { id: number; name: string };

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

/** Creates every table the platform needs and seeds the default channels. Safe to run on each boot. */
export async function ensureSchema(): Promise<void> {
  const p = getPool();
  if (!p) {
    return;
  }

  await p.query(`
    CREATE TABLE IF NOT EXISTS radio_channels (
      id SERIAL PRIMARY KEY,
      sort_order INT NOT NULL DEFAULT 0,
      name TEXT NOT NULL UNIQUE
    );
  `);

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

  // Used by phase 3 (transmission log + transcription); created now so no migration is needed later.
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

  // Used by phase 4 (GPS map).
  await p.query(`
    CREATE TABLE IF NOT EXISTS radio_locations (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      unit_id TEXT,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      accuracy_m DOUBLE PRECISION,
      heading DOUBLE PRECISION,
      speed_mps DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_tx_started ON transmissions (started_at DESC);`);

  const countRes = await p.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM radio_channels;");
  if (Number(countRes.rows[0]?.count ?? "0") === 0) {
    await p.query(
      `INSERT INTO radio_channels (sort_order, name) VALUES
        (1, 'Green 1'),
        (2, 'Green 2'),
        (3, 'Green 3');`,
    );
  }
}

export async function listChannelsFromDb(): Promise<ChannelRow[] | null> {
  const p = getPool();
  if (!p) {
    return null;
  }
  const res = await p.query<ChannelRow>(
    "SELECT id, name FROM radio_channels ORDER BY sort_order ASC, id ASC;",
  );
  return res.rows;
}
