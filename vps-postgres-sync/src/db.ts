import { Pool, type PoolClient } from 'pg';

export const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'mchannel_pms_sync',
  user: process.env.PGUSER || 'mchannel_sync',
  password: process.env.PGPASSWORD || '',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[pg-pool] idle client error:', err.message);
});

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function logSyncEvent(
  propertyId: string,
  level: 'info' | 'warning' | 'error',
  kind: string,
  message: string,
  extra?: { requestId?: string | null; batchId?: string | null; bookingId?: string | null }
) {
  await pool.query(
    `INSERT INTO mchannel_sync_logs (property_id, level, kind, message, request_id, batch_id, booking_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      propertyId,
      level,
      kind,
      message.slice(0, 500),
      extra?.requestId ?? null,
      extra?.batchId ?? null,
      extra?.bookingId ?? null,
    ]
  );
}
