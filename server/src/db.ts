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

export async function ensureChannelSchema(): Promise<void> {
  const p = getPool();
  if (!p) {
    return;
  }
  await p.query(`
    CREATE TABLE IF NOT EXISTS radio_channels (
      id SERIAL PRIMARY KEY,
      sort_order INT NOT NULL,
      name TEXT NOT NULL UNIQUE
    );
  `);

  const countRes = await p.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM radio_channels;");
  const count = Number(countRes.rows[0]?.count ?? "0");
  if (count === 0) {
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
