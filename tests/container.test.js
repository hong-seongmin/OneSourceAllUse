import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate, readiness } from '../apps/shared/db.js';

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function command(command, args, { env = process.env, timeout = 120_000 } = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 10 * 1024 * 1024
  });
}

function assertCommand(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`
  );
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function unavailableDocker(t, message) {
  if (process.env.OSAU_REQUIRE_DOCKER === '1') {
    assert.fail(`release requires a real Docker Compose runtime: ${message}`);
  }
  t.skip(message);
}

test('Compose declares the real PostgreSQL/web/worker boundary and durable restart contract', async () => {
  const [compose, dockerfile] = await Promise.all([
    readFile('docker-compose.yml', 'utf8'),
    readFile('Dockerfile', 'utf8')
  ]);
  for (const required of [
    'postgres:',
    'web:',
    'worker:',
    'postgres:16-alpine',
    'osau_postgres:/var/lib/postgresql/data',
    'condition: service_healthy',
    'DATABASE_URL:',
    'SECRET_ENCRYPTION_KEY:',
    'UPSTAGE_MODEL: ${UPSTAGE_MODEL:-solar-open2}',
    'HOST: 0.0.0.0',
    '"0.0.0.0:${OSAU_PORT:-3000}:3000"',
    'OSAU_AUTH_DISABLED:',
    'OSAU_INTERNAL_NETWORK_MODE:',
    'OSAU_INTERNAL_PEER_ADDRESS_PRESERVED:'
  ]) {
    assert.match(compose, new RegExp(escaped(required)), `Compose must declare ${required}`);
  }
  assert.match(dockerfile, /ENV NODE_ENV=production/u);
  assert.match(dockerfile, /EXPOSE 3000/u);
  assert.match(dockerfile, /npm ci --omit=dev/u);
  assert.match(compose, /OSAU_COOKIE_SECURE: \$\{OSAU_COOKIE_SECURE:-true\}/u, 'authenticated production cookies default to Secure');
  assert.doesNotMatch(compose, /postgresql:\/\/\$\$\{POSTGRES_/u, 'DATABASE_URL must be resolved by Compose, not passed as literal ${POSTGRES_*}');

  const dataDirectory = await mkdtemp(join(tmpdir(), 'osau-db-restart-'));
  try {
    let db = createPgliteDatabase(new PGlite(dataDirectory));
    await migrate(db, process.cwd());
    await bootstrapAdministrator(db, {
      email: 'restart@example.test',
      password: 'correct-horse-battery-staple'
    });
    await db.close();

    db = createPgliteDatabase(new PGlite(dataDirectory));
    const users = await db.query("SELECT email FROM users WHERE email='restart@example.test'");
    assert.equal(users[0].email, 'restart@example.test', 'database data survives a process restart');
    const health = await readiness(db);
    assert.equal(health.database, 'ready');
    await db.close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('Docker Compose runtime starts PostgreSQL, web, and worker and preserves the administrator across web restart', {
  timeout: 300_000
}, async (t) => {
  const dockerInfo = command('docker', ['info'], { timeout: 15_000 });
  if (dockerInfo.error?.code === 'ENOENT') {
    unavailableDocker(t, 'Docker CLI is not installed; static Compose and embedded restart contracts were still validated.');
    return;
  }
  if (dockerInfo.status !== 0) {
    unavailableDocker(t, `Docker daemon is unavailable; static Compose and embedded restart contracts were still validated: ${(dockerInfo.stderr || '').trim().slice(0, 300)}`);
    return;
  }
  const composeVersion = command('docker', ['compose', 'version'], { timeout: 15_000 });
  if (composeVersion.status !== 0) {
    unavailableDocker(t, 'Docker Compose v2 is unavailable; static Compose and embedded restart contracts were still validated.');
    return;
  }

  const project = `osau_release_${process.pid}`;
  const composeArgs = ['compose', '-p', project, '-f', 'docker-compose.yml'];
  const environment = {
    ...process.env,
    POSTGRES_DB: 'osau',
    POSTGRES_USER: 'osau',
    POSTGRES_PASSWORD: 'container-smoke-postgres-password',
    OSAU_ADMIN_EMAIL: 'container@example.test',
    OSAU_ADMIN_PASSWORD: 'container-smoke-administrator-password',
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
    OSAU_PORT: '0',
    OSAU_AUTH_DISABLED: 'false',
    OSAU_INTERNAL_NETWORK_MODE: 'false',
    OSAU_COOKIE_SECURE: 'false',
    UPSTAGE_API_KEY: ''
  };

  try {
    assertCommand(
      command('docker', [...composeArgs, 'config', '--quiet'], { env: environment, timeout: 30_000 }),
      'docker compose config'
    );
    assertCommand(
      command('docker', [...composeArgs, 'up', '--build', '-d'], { env: environment, timeout: 240_000 }),
      'docker compose up'
    );

    let ready = false;
    let latest = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      latest = command('docker', [
        ...composeArgs,
        'exec',
        '-T',
        'web',
        'node',
        '-e',
        "Promise.all([fetch('http://127.0.0.1:3000/health'),fetch('http://127.0.0.1:3000/ready')]).then(async r=>process.exit(r.every(x=>x.ok)?0:1)).catch(()=>process.exit(1))"
      ], { env: environment, timeout: 15_000 });
      if (latest.status === 0) {
        ready = true;
        break;
      }
      await delay(2_000);
    }
    assert.equal(ready, true, `web health/readiness did not become ready: ${latest?.stderr || latest?.stdout || ''}`);

    const running = command('docker', [...composeArgs, 'ps', '--status', 'running', '--services'], {
      env: environment,
      timeout: 15_000
    });
    assertCommand(running, 'docker compose ps');
    assert.deepEqual(
      new Set(running.stdout.trim().split(/\s+/u)),
      new Set(['postgres', 'web', 'worker'])
    );

    const beforeRestart = command('docker', [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'osau',
      '-d',
      'osau',
      '-tAc',
      "SELECT count(*) FROM users WHERE email='container@example.test'"
    ], { env: environment, timeout: 15_000 });
    assertCommand(beforeRestart, 'administrator persistence query');
    assert.equal(beforeRestart.stdout.trim(), '1');

    assertCommand(
      command('docker', [...composeArgs, 'restart', 'web'], { env: environment, timeout: 60_000 }),
      'web restart'
    );
    let restarted = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const health = command('docker', [
        ...composeArgs,
        'exec',
        '-T',
        'web',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      ], { env: environment, timeout: 15_000 });
      if (health.status === 0) {
        restarted = true;
        break;
      }
      await delay(2_000);
    }
    assert.equal(restarted, true, 'web readiness must recover after restart');

    const afterRestart = command('docker', [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'osau',
      '-d',
      'osau',
      '-tAc',
      "SELECT count(*) FROM users WHERE email='container@example.test'"
    ], { env: environment, timeout: 15_000 });
    assertCommand(afterRestart, 'post-restart administrator persistence query');
    assert.equal(afterRestart.stdout.trim(), '1');
  } finally {
    const down = command('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
      env: environment,
      timeout: 60_000
    });
    if (down.status !== 0) t.diagnostic(`container cleanup failed for scoped project ${project}: ${down.stderr || down.stdout}`);
  }
});
