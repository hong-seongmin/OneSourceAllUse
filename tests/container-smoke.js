import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate, readiness } from '../apps/shared/db.js';

const compose = await readFile('docker-compose.yml', 'utf8');
for (const required of ['postgres:', 'web:', 'worker:', 'osau_postgres:', 'condition: service_healthy', 'DATABASE_URL:', 'SECRET_ENCRYPTION_KEY:']) assert.match(compose, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
const dataDirectory = await mkdtemp(join(tmpdir(), 'osau-restart-'));
try {
  let first = new PGlite(dataDirectory); let db = createPgliteDatabase(first);
  await migrate(db, process.cwd());
  await bootstrapAdministrator(db, { email: 'restart@example.com', password: 'correct-horse-battery-staple' });
  await db.close();
  let second = new PGlite(dataDirectory); db = createPgliteDatabase(second);
  const users = await db.query("SELECT email FROM users WHERE email='restart@example.com'");
  assert.equal(users[0].email, 'restart@example.com', 'persisted database survives process restart');
  const health = await readiness(db);
  assert.equal(health.database, 'ready');
  await db.close();
  console.log('container: PASS (compose contract and persistent PostgreSQL-compatible restart canary)');
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}
