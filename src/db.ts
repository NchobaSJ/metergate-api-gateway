/*
 * db.ts
 *
 * Postgres connection pool for MeterGate.
 *
 * Why a pool?
 *   Opening a new TCP connection to Postgres on every request is slow
 *   (~1-5ms) and burns file descriptors. A pool keeps a small set of
 *   connections open and lends them out.
 *
 * Why retries on startup?
 *   In Docker Compose, containers start in parallel. The gateway may
 *   boot before Postgres is ready to accept connections. We retry
 *   with backoff so the gateway doesn't crash on first start.
 */

import { Pool } from 'pg';

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://metergate:metergate@localhost:5432/metergate';

export const pool = new Pool({
  connectionString,
  max: 10,                     // max connections in the pool
  idleTimeoutMillis: 30_000,   // close idle connections after 30s
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

/*
 * Wait for Postgres to accept connections.
 * Retries up to 30 times with a 1-second delay — 30s total.
 * Enough for any reasonable Docker startup race.
 */
export async function waitForPostgres(maxAttempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log(`[db] connected to Postgres on attempt ${attempt}`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[db] Postgres not ready (attempt ${attempt}/${maxAttempts}): ${msg}`
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('Could not connect to Postgres after retries');
}
