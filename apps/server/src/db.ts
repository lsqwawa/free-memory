import { Pool, QueryResultRow } from 'pg';
import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

export async function query<T extends QueryResultRow>(text: string, params?: unknown[]) {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function ensureDatabaseReady() {
  await pool.query('select 1');
}

export async function updateDocumentStatus(
  documentId: string,
  status: string,
  errorMessage?: string | null,
) {
  await pool.query(
    `update documents set status = $1, error_message = $2, updated_at = now() where id = $3`,
    [status, status === 'parsed' ? null : (errorMessage ?? null), documentId],
  );
}
