import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

let pool: Pool | undefined;
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('Managed database is not configured');
  pool ??= mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true });
  return pool;
}
export class Store {
  constructor(readonly connection: PoolConnection) {}
  async get<T>(collection: string, name: string): Promise<T | null> {
    const [rows] = await this.connection.execute<RowDataPacket[]>('SELECT payload FROM wc_documents WHERE collection = ? AND name = ?', [collection, name]);
    return rows.length ? JSON.parse(String(rows[0].payload)) as T : null;
  }
  async list<T>(collection: string): Promise<T[]> {
    const [rows] = await this.connection.execute<RowDataPacket[]>('SELECT payload FROM wc_documents WHERE collection = ? ORDER BY updated_at DESC', [collection]);
    return rows.map(row => JSON.parse(String(row.payload)) as T);
  }
  async put(collection: string, name: string, value: unknown): Promise<void> {
    await this.connection.execute('INSERT INTO wc_documents (collection, name, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [collection, name, JSON.stringify(value)]);
  }
  async remove(collection: string, name: string): Promise<void> {
    await this.connection.execute('DELETE FROM wc_documents WHERE collection = ? AND name = ?', [collection, name]);
  }
  async batch(values: {collection: string; name: string; value: unknown}[]): Promise<void> {
    await this.connection.beginTransaction();
    try { for (const row of values) await this.put(row.collection, row.name, row.value); await this.connection.commit(); }
    catch (error) { await this.connection.rollback(); throw error; }
  }
}
export async function withStore<T>(action: (store: Store) => Promise<T>): Promise<T> {
  const connection = await getPool().getConnection();
  try { return await action(new Store(connection)); } finally { connection.release(); }
}
// MySQL named lock belongs to the checked-out connection. It spans network calls but
// not uncommitted transactions: every external intent is durable before its request.
export async function withLifecycleLock<T>(action: (store: Store) => Promise<T>): Promise<T> {
  const connection = await getPool().getConnection();
  let acquired = false;
  try {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 2) AS acquired', ['wc_lifecycle_v1']);
    acquired = Number(rows[0].acquired) === 1;
    if (!acquired) throw new HttpError(503, 'BUSY', 'Another checkout is being prepared. Please retry shortly.');
    return await action(new Store(connection));
  } finally {
    if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', ['wc_lifecycle_v1']).catch(() => {});
    connection.release();
  }
}
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export async function closeStore(): Promise<void> { if (pool) await pool.end(); pool = undefined; }
