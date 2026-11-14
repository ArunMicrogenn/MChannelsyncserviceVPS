import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const sqlPath = path.resolve(__dirname, '../sql/001_schema.sql');
  const sql = await fs.readFile(sqlPath, 'utf8');
  console.log('[migrate] Applying PostgreSQL schema from', sqlPath);
  await pool.query(sql);
  console.log('[migrate] PostgreSQL schema applied successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
