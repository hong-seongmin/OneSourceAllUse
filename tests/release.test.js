import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production schema contains every P0 system-of-record relation', async () => {
  const sql = await readFile('migrations/001_initial.sql', 'utf8');
  const tables = ['workspaces', 'users', 'sessions', 'sources', 'source_sync_states', 'source_items', 'source_snapshots', 'source_segments', 'content_atoms', 'creator_identity_versions', 'creator_identity_facts', 'creator_voice_versions', 'audience_persona_versions', 'model_provider_configs', 'plans', 'plan_outputs', 'runs', 'run_steps', 'artifacts', 'artifact_versions', 'artifact_blocks', 'block_source_refs', 'verifications', 'approvals', 'exports', 'domain_events', 'outbox_events'];
  for (const table of tables) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
});

test('the exact freshness dependency lookup is isolated to persisted block_source_refs', async () => {
  const implementation = await readFile('apps/shared/freshness.js', 'utf8');
  const body = implementation.match(/export async function affectedBlocksFromRefs[\s\S]*?\n}/)?.[0] || '';
  assert.match(body, /FROM block_source_refs ref/);
  assert.doesNotMatch(body, /source_segments|content_atoms.*LIKE|artifact\.content/);
  assert.match(implementation, /invalidated_at = now\(\)/);
});

test('production runtime has no harness fixture dependency and disables fixture provider at the boundary', async () => {
  const [generation, intelligence, worker, web] = await Promise.all(['apps/shared/generation.js', 'apps/shared/intelligence.js', 'apps/worker/worker.js', 'apps/web/server.js'].map((path) => readFile(path, 'utf8')));
  for (const source of [generation, intelligence, worker, web]) assert.doesNotMatch(source, /harness\/|known-bad\//);
  assert.match(intelligence, /FIXTURE_PROVIDER_IN_PRODUCTION/);
  assert.match(intelligence, /environment === 'production' \|\| !testMode/);
});

test('deployment has separate web and worker processes and no public-publish operation', async () => {
  const [compose, web, exporter] = await Promise.all(['docker-compose.yml', 'apps/web/server.js', 'apps/shared/export.js'].map((path) => readFile(path, 'utf8')));
  assert.match(compose, /web:/); assert.match(compose, /worker:/); assert.match(web, /\/health/); assert.match(web, /\/ready/);
  assert.match(exporter, /status: 'draft'/); assert.doesNotMatch(exporter, /status:\s*['"]publish/);
});
