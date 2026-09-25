const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    throw new Error('Нужен DATABASE_URL или POSTGRES_PASSWORD');
  }
  const user = process.env.POSTGRES_USER || 'naryad';
  const host = process.env.POSTGRES_HOST || 'db';
  const port = process.env.POSTGRES_PORT || '5432';
  const db = process.env.POSTGRES_DB || 'naryad';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

const pool = new Pool({ connectionString: databaseUrl() });

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, withTx, databaseUrl };
