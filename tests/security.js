import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { createApp } from '../apps/web/server.js';
import { exportMarkdown } from '../apps/shared/export.js';
import { saveModelProvider } from '../apps/shared/intelligence.js';
import { assertSafeExternalUrl, redact } from '../apps/shared/security.js';

const secretKey = Buffer.alloc(32, 9).toString('base64');
const pglite = new PGlite(); const db = createPgliteDatabase(pglite);
await migrate(db, process.cwd());
const user = await bootstrapAdministrator(db, { email: 'security@example.com', password: 'correct-horse-battery-staple' });
const app = createApp({ db, config: { environment: 'test', testMode: true, secretKey, network: { allowPrivateNetworks: true } } });
const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const origin = `http://127.0.0.1:${server.address().port}`;
const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
try {
  const denied = await fetch(`${origin}/api/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401, 'state-changing API requires an authenticated session');
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=security%40example.com&password=correct-horse-battery-staple' });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie');
  const cookie = setCookie.split(';')[0];
  const session = (await db.query('SELECT token_hash, csrf_token FROM sessions'))[0];
  assert.ok(!setCookie.includes(session.token_hash), 'only a random session token is sent to the client; the database stores its hash');
  const crossOrigin = await fetch(`${origin}/api/sources`, { method: 'POST', headers: { cookie, origin: 'https://attacker.example', 'x-csrf-token': session.csrf_token, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', feedUrl: 'https://example.com/feed' }) });
  assert.equal(crossOrigin.status, 403, 'cross-origin authenticated writes are rejected');
  const missingCsrf = await fetch(`${origin}/api/sources`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', feedUrl: 'https://example.com/feed' }) });
  assert.equal(missingCsrf.status, 403, 'same-origin writes still require the session CSRF token');
  await assert.rejects(() => assertSafeExternalUrl('http://127.0.0.1'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://169.254.169.254/latest/meta-data'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => saveModelProvider(db, { workspaceId, userId: user.id, name: 'fixture', providerType: 'fixture', baseUrl: 'https://example.com/v1', model: 'fixture', environment: 'production', secretKey, testMode: true }), { code: 'FIXTURE_PROVIDER_IN_PRODUCTION' });
  await assert.rejects(() => exportMarkdown(db, { workspaceId: 'missing', userId: user.id, artifactId: 'missing' }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(redact('Authorization: Bearer abc123 api_key=secret'), 'Authorization: Bearer [REDACTED] api_key=[REDACTED]');
  console.log('security: PASS (auth/session, CSRF, SSRF, fixture isolation, approval boundary, redaction)');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
}
