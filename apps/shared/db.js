import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { Pool } = pg;

export function createPostgresDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for the production runtime.');
  const pool = new Pool({ connectionString, max: 12, idleTimeoutMillis: 20_000 });
  return {
    dialect: 'postgres',
    async query(text, params = []) {
      const result = await pool.query(text, params);
      return result.rows;
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = { query: async (text, params = []) => (await client.query(text, params)).rows };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

export function createPgliteDatabase(pglite) {
  return {
    dialect: 'pglite',
    query: (text, params = []) => pglite.query(text, params).then((result) => result.rows),
    transaction: async (fn) => pglite.transaction(async (inner) => fn({
      query: (text, params = []) => inner.query(text, params).then((result) => result.rows)
    })),
    close: () => pglite.close()
  };
}

export async function migrate(db, root = process.cwd()) {
  const directory = join(root, 'migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  await db.transaction(async (tx) => {
    // Docker starts web and worker independently. A transaction-scoped
    // PostgreSQL advisory lock prevents both processes from applying the same
    // migration at once while leaving PGlite test databases deterministic.
    if (db.dialect === 'postgres') {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('osau:schema-migrations'))");
    }
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const applied = new Set((await tx.query('SELECT version FROM schema_migrations')).map((row) => row.version));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(directory, file), 'utf8');
      // Execute statement-by-statement so PostgreSQL protocol clients that prepare each query
      // (including the local PostgreSQL-compatible canary) see the exact same migration.
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    }
  });
}

export async function readiness(db) {
  await db.query('SELECT 1 AS ok');
  const pending = await db.query("SELECT count(*)::int AS count FROM outbox_events WHERE status = 'pending'");
  return { database: 'ready', pendingJobs: pending[0]?.count ?? 0 };
}
