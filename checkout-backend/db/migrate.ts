import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';

export async function migrate(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('Managed database is not configured');
  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS wc_migrations (
      version VARCHAR(100) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT version FROM wc_migrations WHERE version = ?', ['001_documents']);
    if (rows.length) return;
    await connection.query(`CREATE TABLE IF NOT EXISTS wc_documents (
      collection VARCHAR(40) NOT NULL, name VARCHAR(128) NOT NULL,
      payload LONGTEXT NOT NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (collection, name), KEY collection_updated (collection, updated_at)
    ) ENGINE=InnoDB`);
    await connection.execute('INSERT IGNORE INTO wc_migrations (version) VALUES (?)', ['001_documents']);
  } finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().then(() => console.log('Watch checkout schema is ready')).catch(() => { console.error('Database migration failed; inspect protected database configuration'); process.exitCode = 1; });
}
