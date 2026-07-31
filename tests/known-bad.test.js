import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectIssues } from '../apps/shared/known-bad.js';

async function discoverFixtures() {
  const directory = join(process.cwd(), 'harness', 'known-bad');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}

test('known-bad cases are dynamically discovered and fail with the exact expected issue codes', async () => {
  const fixtures = await discoverFixtures();
  assert.ok(fixtures.length >= 15);
  for (const fixture of fixtures) {
    const actual = detectIssues(fixture.id, fixture.payload).sort();
    assert.deepEqual(actual, [...fixture.expectedIssueCodes].sort(), `${fixture.id} must emit its exact issue code set`);
  }
});

test('new regression cases are detected from payloads and not case IDs', async () => {
  const fixtures = await discoverFixtures();
  for (const fixture of fixtures) {
    assert.deepEqual(
      detectIssues(`renamed-${fixture.id}`, fixture.payload).sort(),
      [...fixture.expectedIssueCodes].sort(),
      `${fixture.id} must still be detected after its case ID changes`
    );
    assert.deepEqual(
      detectIssues(fixture.id, {}),
      [],
      `${fixture.id} must not be detected from its case ID alone`
    );
  }
});
