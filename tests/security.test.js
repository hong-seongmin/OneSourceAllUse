import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { createApp } from '../apps/web/server.js';
import { exportMarkdown, exportWordPressDraft } from '../apps/shared/export.js';
import { requestCompletion, saveModelProvider } from '../apps/shared/intelligence.js';
import { currentVersionDriftFromRefs } from '../apps/shared/freshness.js';
import { id, sha256 } from '../apps/shared/ids.js';
import {
  assertCredentialedHttps,
  assertSafeExternalUrl,
  boundedText,
  redact,
  safeFetch
} from '../apps/shared/security.js';

const secretKey = Buffer.alloc(32, 9).toString('base64');

async function databaseFixture(t, email) {
  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  return { db, user, workspaceId };
}

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function rawRequest(origin, { path, method = 'GET', headers = {}, body = '' }) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method,
      headers: {
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('authenticated mode enforces session hashing, same-origin CSRF, SSRF, fixture isolation, and approval boundaries', async (t) => {
  const { db, user, workspaceId } = await databaseFixture(t, 'security@example.test');
  const app = createApp({
    db,
    config: {
      environment: 'test',
      testMode: true,
      secretKey,
      network: { allowPrivateNetworks: true }
    }
  });
  const origin = await listen(t, app);

  const denied = await fetch(`${origin}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(denied.status, 401, 'state-changing API requires authentication in normal mode');

  const login = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=security%40example.test&password=correct-horse-battery-staple'
  });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Lax/iu);
  const rawToken = setCookie.match(/^osau_session=([^;]+)/u)?.[1];
  assert.ok(rawToken);
  const cookie = `osau_session=${rawToken}`;
  const session = (await db.query('SELECT token_hash,csrf_token FROM sessions'))[0];
  assert.equal(session.token_hash, sha256(rawToken), 'database stores only the session token hash');
  assert.notEqual(rawToken, session.token_hash);

  const crossOrigin = await fetch(`${origin}/api/sources`, {
    method: 'POST',
    headers: {
      cookie,
      origin: 'https://attacker.example',
      'x-csrf-token': session.csrf_token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'x',
      feedUrl: 'https://example.test/feed',
      rightsStatus: 'owned'
    })
  });
  assert.equal(crossOrigin.status, 403, 'authenticated writes reject a foreign Origin');
  assert.equal((await crossOrigin.json()).error.code, 'CSRF_ORIGIN_REJECTED');

  const missingCsrf = await fetch(`${origin}/api/sources`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'x',
      feedUrl: 'https://example.test/feed',
      rightsStatus: 'owned'
    })
  });
  assert.equal(missingCsrf.status, 403, 'same-origin writes still require the session CSRF token');
  assert.equal((await missingCsrf.json()).error.code, 'CSRF_REJECTED');

  await assert.rejects(() => assertSafeExternalUrl('http://127.0.0.1'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://169.254.169.254/latest/meta-data'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://0.0.0.0'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://198.18.0.1'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://224.0.0.1'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://[::]'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://[::1]'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://[::ffff:127.0.0.1]'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://[fc00::1]'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://[fe80::1]'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(() => assertSafeExternalUrl('http://[ff02::1]'), { code: 'SSRF_BLOCKED' });
  await assert.doesNotReject(() => assertSafeExternalUrl('https://8.8.8.8'));
  await assert.doesNotReject(() => assertSafeExternalUrl('https://[2606:4700:4700::1111]'));
  await assert.rejects(() => saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'fixture',
    providerType: 'fixture',
    baseUrl: 'https://example.test/v1',
    model: 'fixture',
    apiKey: 'test-only',
    environment: 'production',
    secretKey,
    testMode: true
  }), { code: 'FIXTURE_PROVIDER_IN_PRODUCTION' });
  await assert.rejects(() => exportMarkdown(db, {
    workspaceId: 'missing',
    userId: user.id,
    artifactId: 'missing'
  }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(
    redact('Authorization: Bearer abc123 api_key=secret password=hunter2'),
    'Authorization: Bearer [REDACTED] api_key=[REDACTED] password=[REDACTED]'
  );
  const health = await fetch(`${origin}/health`);
  assert.equal(health.headers.has('x-powered-by'), false);
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

  const hostileReferer = await fetch(`${origin}/missing-page`, {
    headers: { cookie, referer: 'javascript:alert(document.domain)' }
  });
  const hostileRefererHtml = await hostileReferer.text();
  assert.doesNotMatch(hostileRefererHtml, /javascript:alert/u);
  assert.match(hostileRefererHtml, /href="\/app\/inbox"/u);
});

test('outbound requests pin one validated address and bound the complete response body', async (t) => {
  let receivedHost = null;
  const healthy = createServer((request, response) => {
    receivedHost = request.headers.host;
    response.setHeader('content-type', 'text/plain');
    response.end('pinned');
  });
  const healthyOrigin = await listen(t, healthy);
  let resolverCalls = 0;
  const resolver = async () => {
    resolverCalls += 1;
    return [{
      address: resolverCalls === 1 ? '127.0.0.1' : '127.0.0.2',
      family: 4
    }];
  };
  const pinned = await safeFetch(`http://rebind.test:${new URL(healthyOrigin).port}/resource`, {}, {
    allowPrivateNetworks: true,
    resolver,
    timeoutMs: 1_000
  });
  assert.equal(await boundedText(pinned), 'pinned');
  assert.equal(resolverCalls, 1, 'the actual socket uses the already-validated address without a second DNS decision');
  assert.match(receivedHost, /^rebind\.test:/u, 'HTTP Host remains the validated logical hostname');

  const stalled = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('headers arrived');
  });
  const stalledOrigin = await listen(t, stalled);
  const startedAt = Date.now();
  await assert.rejects(
    safeFetch(stalledOrigin, {}, {
      allowPrivateNetworks: true,
      timeoutMs: 75
    }),
    { code: 'REMOTE_TIMEOUT' }
  );
  assert.ok(Date.now() - startedAt < 1_000, 'the deadline continues after response headers');

  const oversized = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('0123456789abcdef');
  });
  const oversizedOrigin = await listen(t, oversized);
  await assert.rejects(
    safeFetch(oversizedOrigin, {}, {
      allowPrivateNetworks: true,
      timeoutMs: 1_000,
      maxBytes: 8
    }),
    { code: 'RESPONSE_TOO_LARGE' }
  );
});

test('credentialed HTTP is available only behind the explicit test-only boundary', async () => {
  assert.throws(
    () => assertCredentialedHttps('http://127.0.0.1/model', {
      environment: 'production',
      testMode: true,
      allowInsecureCredentialTransport: true
    }),
    { code: 'CREDENTIAL_TRANSPORT_HTTPS_REQUIRED' }
  );
  assert.throws(
    () => assertCredentialedHttps('http://127.0.0.1/model', {
      environment: 'test',
      testMode: true
    }),
    { code: 'CREDENTIAL_TRANSPORT_HTTPS_REQUIRED' }
  );
  assert.doesNotThrow(() => assertCredentialedHttps('http://127.0.0.1/model', {
    environment: 'test',
    testMode: true,
    allowInsecureCredentialTransport: true
  }));
  assert.doesNotThrow(() => assertCredentialedHttps('https://provider.example/model', {
    environment: 'production'
  }));

  await assert.rejects(
    saveModelProvider(null, {
      workspaceId: 'workspace',
      userId: 'user',
      name: 'cleartext provider',
      providerType: 'openai_compatible',
      baseUrl: 'http://127.0.0.1/v1',
      model: 'model',
      apiKey: 'sentinel',
      environment: 'production',
      secretKey
    }),
    { code: 'CREDENTIAL_TRANSPORT_HTTPS_REQUIRED' }
  );
  await assert.rejects(
    requestCompletion({
      providerType: 'openai_compatible',
      baseUrl: 'http://127.0.0.1/v1',
      model: 'model',
      secret: 'sentinel',
      capabilities: { structuredOutput: 'json_object' }
    }, {
      messages: [{ role: 'user', content: 'Return JSON.' }]
    }, {
      environment: 'production',
      testMode: false,
      network: { allowPrivateNetworks: true }
    }),
    { code: 'CREDENTIAL_TRANSPORT_HTTPS_REQUIRED' }
  );
  await assert.rejects(
    exportWordPressDraft(null, {
      workspaceId: 'workspace',
      userId: 'user',
      artifactId: 'artifact',
      wordpressBaseUrl: 'http://127.0.0.1',
      username: 'wordpress-user',
      applicationPassword: 'sentinel',
      environment: 'production',
      testMode: true,
      network: {
        allowPrivateNetworks: true,
        allowInsecureCredentialTransport: true
      }
    }),
    { code: 'CREDENTIAL_TRANSPORT_HTTPS_REQUIRED' }
  );
});

test('login-disabled operation is explicit, private-network scoped, CSRF-protected, and uses a persisted administrator actor', async (t) => {
  const { db, user, workspaceId } = await databaseFixture(t, 'internal-operator@example.test');
  assert.throws(
    () => createApp({
      db,
      config: {
        environment: 'test',
        testMode: true,
        secretKey,
        authDisabled: true,
        internalNetworkMode: false
      }
    }),
    { code: 'AUTH_DISABLED_REQUIRES_INTERNAL_NETWORK_MODE' }
  );
  assert.throws(
    () => createApp({
      db,
      config: {
        environment: 'test',
        testMode: true,
        secretKey,
        authDisabled: true,
        internalNetworkMode: true,
        internalPeerAddressPreserved: false
      }
    }),
    { code: 'AUTH_DISABLED_REQUIRES_PRESERVED_CLIENT_IP' }
  );

  const app = createApp({
    db,
    config: {
      environment: 'test',
      testMode: true,
      secretKey,
      authDisabled: true,
      internalNetworkMode: true,
      network: { allowPrivateNetworks: true }
    }
  });
  const origin = await listen(t, app);

  const reboundBody = JSON.stringify({
    name: '재바인딩 공격 원본',
    feedUrl: 'https://example.test/rebind.xml',
    rightsStatus: 'owned'
  });
  const rebound = await rawRequest(origin, {
    path: '/api/sources',
    method: 'POST',
    headers: {
      host: 'rebind.attacker.test:3000',
      origin: 'http://rebind.attacker.test:3000',
      'x-csrf-token': 'internal-network-csrf',
      'content-type': 'application/json'
    },
    body: reboundBody
  });
  assert.equal(rebound.status, 403);
  assert.equal(JSON.parse(rebound.body).error.code, 'INTERNAL_HOST_REJECTED');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM sources WHERE name='재바인딩 공격 원본'"))[0].count, 0);

  const privateLiteralHost = await rawRequest(origin, {
    path: '/app/inbox',
    headers: { host: '192.168.50.130:3000' }
  });
  assert.equal(privateLiteralHost.status, 200, 'a real private IPv4 literal Host remains supported');

  const login = await fetch(`${origin}/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/app/inbox');
  assert.equal(login.headers.get('set-cookie'), null, 'internal mode does not mint a login session');

  const inbox = await fetch(`${origin}/app/inbox`, {
    headers: { 'x-forwarded-for': '203.0.113.10' }
  });
  assert.equal(inbox.status, 200);
  const inboxHtml = await inbox.text();
  assert.match(inboxHtml, /내부 네트워크 운영 모드/u);
  assert.doesNotMatch(inboxHtml, /로그아웃/u);

  const missingCsrf = await fetch(`${origin}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '내부 원본',
      feedUrl: 'https://example.test/feed.xml',
      rightsStatus: 'owned'
    })
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, 'CSRF_REJECTED');

  const created = await fetch(`${origin}/api/sources`, {
    method: 'POST',
    headers: {
      origin,
      'x-csrf-token': 'internal-network-csrf',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: '내부 원본',
      feedUrl: 'https://example.test/feed.xml',
      rightsStatus: 'owned'
    })
  });
  assert.equal(created.status, 200);
  const source = (await db.query('SELECT workspace_id,created_by,rights_status FROM sources'))[0];
  assert.equal(source.workspace_id, workspaceId);
  assert.equal(source.created_by, user.id);
  assert.equal(source.rights_status, 'owned');

  const bypassLogin = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=wrong%40example.test&password=wrong-password'
  });
  assert.equal(bypassLogin.status, 302);
  assert.equal(bypassLogin.headers.get('location'), '/app/inbox');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM sessions'))[0].count, 0);
});

test('non-stale Review regeneration requires the exact latest partial source acknowledgement without exposing its id', async (t) => {
  const { db, user, workspaceId } = await databaseFixture(t, 'review-source-ack@example.test');
  const sourceId = id();
  const sourceItemId = id();
  const originalSnapshotId = id();
  const latestSnapshotId = id();
  const originalSegmentId = id();
  const latestSegmentId = id();
  const originalAtomId = id();
  const latestAtomId = id();
  const providerId = id();
  const planId = id();
  const outputId = id();
  const runId = id();
  const artifactId = id();
  const versionId = id();
  const blockId = id();

  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,rights_status,created_by)
      VALUES ($1,$2,'운영 소식 원본','rss','https://example.test/feed.xml','owned',$3)`, [
      sourceId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO source_items
      (id,source_id,external_key,title)
      VALUES ($1,$2,'review-regeneration-source','7월 운영 소식')`, [
      sourceItemId,
      sourceId
    ]);
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES
      ($1,$3,1,'review-original','7월 운영 소식','배송은 내일입니다.'),
      ($2,$3,2,'review-latest','7월 운영 소식','배송은 내일입니다.')`, [
      originalSnapshotId,
      latestSnapshotId,
      sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES
      ($1,$3,'본문 1',1,'paragraph','배송은 내일입니다.'),
      ($2,$4,'본문 1',1,'paragraph','배송은 내일입니다.')`, [
      originalSegmentId,
      latestSegmentId,
      originalSnapshotId,
      latestSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES
      ($1,$3,$5,'본문 1 · 문장 1','claim','배송은 내일입니다.','unchanged-delivery'),
      ($2,$4,$6,'본문 1 · 문장 1','claim','배송은 내일입니다.','unchanged-delivery')`, [
      originalAtomId,
      latestAtomId,
      originalSnapshotId,
      latestSnapshotId,
      originalSegmentId,
      latestSegmentId
    ]);
    await tx.query(`INSERT INTO source_snapshot_assessments
      (snapshot_id,readiness,rights_status,usable_atom_ids,omissions,signals,
       acknowledgement_required)
      VALUES
      ($1,'complete','owned',$3::jsonb,'[]'::jsonb,'[]'::jsonb,false),
      ($2,'partial','owned',$4::jsonb,'["BODY_TRUNCATED"]'::jsonb,'[]'::jsonb,true)`, [
      originalSnapshotId,
      latestSnapshotId,
      JSON.stringify([originalAtomId]),
      JSON.stringify([latestAtomId])
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      sourceItemId,
      latestSnapshotId
    ]);
    await tx.query(`INSERT INTO model_provider_configs
      (id,workspace_id,name,provider_type,base_url,model,secret_ciphertext,enabled,
       created_by)
      VALUES
      ($1,$2,'재생성 Provider','openai_compatible','https://example.test/v1',
       'review-model','encrypted-test-secret',true,$3)`, [
      providerId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO plans
      (id,workspace_id,source_item_id,snapshot_id,language,common_cta,created_by)
      VALUES ($1,$2,$3,$4,'ko','',$5)`, [
      planId,
      workspaceId,
      sourceItemId,
      originalSnapshotId,
      user.id
    ]);
    await tx.query(`INSERT INTO plan_source_snapshots
      (plan_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
       readiness_acknowledged)
      VALUES ($1,$2,$3,'source_1',1,true,false)`, [
      planId,
      sourceItemId,
      originalSnapshotId
    ]);
    await tx.query(`INSERT INTO runs
      (id,workspace_id,plan_id,run_type,status,created_by,started_at,completed_at)
      VALUES ($1,$2,$3,'artifact_generation','succeeded',$4,now(),now())`, [
      runId,
      workspaceId,
      planId,
      user.id
    ]);
    await tx.query(`INSERT INTO plan_outputs
      (id,plan_id,output_type,channel_definition_version_id,selected,settings,status,
       quality_status)
      VALUES
      ($1,$2,'naver_blog','naver_blog:v1',true,'{}'::jsonb,'succeeded','passed')`, [
      outputId,
      planId
    ]);
    await tx.query(`INSERT INTO artifacts
      (id,workspace_id,source_item_id,channel,state,created_by)
      VALUES ($1,$2,$3,'naver_blog','review_required',$4)`, [
      artifactId,
      workspaceId,
      sourceItemId,
      user.id
    ]);
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,created_by_run_id,
       channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES
      ($1,$2,1,$3,
       '{"type":"naver_article","title":"7월 운영 소식","intro":"배송은 내일입니다.","sections":[],"faq":[],"cta":null,"tags":[]}'::jsonb,
       $4,'naver_blog:v1','prompt.v1','evaluator.v1')`, [
      versionId,
      artifactId,
      originalSnapshotId,
      runId
    ]);
    await tx.query(`INSERT INTO artifact_version_source_snapshots
      (artifact_version_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
       readiness_acknowledged)
      VALUES ($1,$2,$3,'source_1',1,true,false)`, [
      versionId,
      sourceItemId,
      originalSnapshotId
    ]);
    await tx.query('UPDATE artifacts SET current_version_id=$2 WHERE id=$1', [
      artifactId,
      versionId
    ]);
    await tx.query('UPDATE plan_outputs SET artifact_id=$2 WHERE id=$1', [
      outputId,
      artifactId
    ]);
    await tx.query(`INSERT INTO artifact_blocks
      (id,artifact_version_id,block_key,block_type,ordinal,content,evidence_state,
       auto_check,surface_path,content_kind,content_hash)
      VALUES
      ($1,$2,'intro','paragraph',1,'배송은 내일입니다.','review_required',
       '{"automaticSupport":"supported"}'::jsonb,'$.intro','factual',
       'review-regeneration-block')`, [
      blockId,
      versionId
    ]);
    await tx.query(`INSERT INTO block_source_refs
      (artifact_block_id,content_atom_id) VALUES ($1,$2)`, [
      blockId,
      originalAtomId
    ]);
  });

  assert.deepEqual(
    await currentVersionDriftFromRefs(db, { workspaceId, artifactId }),
    [],
    'an unchanged referenced fingerprint must keep the current artifact non-stale'
  );
  assert.equal(
    (await db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [blockId]))[0].stale,
    false
  );

  const app = createApp({
    db,
    config: {
      environment: 'test',
      testMode: true,
      secretKey,
      authDisabled: true,
      internalNetworkMode: true,
      network: { allowPrivateNetworks: true }
    }
  });
  const origin = await listen(t, app);
  const response = await fetch(`${origin}/app/review/${artifactId}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const regenerationForm = html.match(
    new RegExp(`<form[^>]+data-api="/api/artifacts/${artifactId}/regenerate"[\\s\\S]*?</form>`, 'u')
  )?.[0];
  assert.ok(regenerationForm, 'the non-stale workbench renders the direct regenerate form');
  assert.equal(
    [...regenerationForm.matchAll(/name="acknowledgedSourceSnapshotIds"/gu)].length,
    1,
    'the exact changed partial source requires one acknowledgement'
  );
  assert.match(
    regenerationForm,
    new RegExp(`name="acknowledgedSourceSnapshotIds" value="${latestSnapshotId}" required`, 'u')
  );
  assert.match(regenerationForm, /운영 소식 원본 · 7월 운영 소식/u);
  assert.match(regenerationForm, /수집 크기 제한으로 본문 일부가 잘림/u);

  const visibleText = html
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
  assert.doesNotMatch(
    visibleText,
    new RegExp(latestSnapshotId, 'u'),
    'the acknowledgement value is operational metadata, not visible UI copy'
  );
});

test('WordPress export rejects a non-draft status or invalid post id from the upstream contract', async (t) => {
  let upstreamPost = { id: 999, status: 'publish' };
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before returning the protocol-compatible response.
    }
    response.setHeader('content-type', 'application/json');
    response.end(request.method === 'GET' ? '[]' : JSON.stringify(upstreamPost));
  });
  const origin = await listen(t, upstream);
  const updates = [];
  const tx = {
    query: async (sql) => {
      if (sql.includes('SELECT a.id AS artifact_id')) {
        return [{
          artifact_id: 'artifact-1',
          channel: 'naver_blog',
          state: 'approved',
          source_item_id: 'source-item-1',
          current_version_id: 'version-1',
          content: {
            title: '검증 제목',
            intro: '검증 도입',
            sections: []
          }
        }];
      }
      if (sql.includes('SELECT a.current_version_id')) {
        return [{
          current_version_id: 'version-1',
          source_snapshot_id: 'snapshot-1',
          source_readiness_acknowledged: true,
          readiness: 'complete'
        }];
      }
      if (sql.includes("count(*) FILTER (WHERE evidence_state = 'conflict'")) {
        return [{ affected: 0, conflicts: 0, stale: 0, held: 0 }];
      }
      if (sql.includes('FROM artifact_version_source_snapshots version_source')) {
        return [{
          artifact_version_id: 'version-1',
          source_item_id: 'source-item-1',
          snapshot_id: 'snapshot-1',
          source_key: 'source_1',
          ordinal: 1,
          is_primary: true,
          readiness_acknowledged: false,
          readiness: 'complete',
          acknowledgement_required: false
        }];
      }
      if (sql.includes('SELECT count(DISTINCT finding.id)::int AS count')) return [{ count: 0 }];
      if (sql.includes('SELECT block.id, block.block_key, block.ordinal')) return [];
      if (sql.includes('FROM source_items')) return [{
        id: 'source-item-1',
        latest_snapshot_id: 'snapshot-1'
      }];
      if (sql.includes('SELECT DISTINCT block.id AS block_id')) return [];
      if (sql.includes('SELECT * FROM exports')) return [{ status: 'pending', external_id: null }];
      if (sql.includes('SELECT 1 AS ok')) return [{ ok: 1 }];
      if (sql.includes("UPDATE exports SET status='failed'")) updates.push('failed');
      if (sql.includes("UPDATE exports SET status='succeeded'")) updates.push('succeeded');
      return [];
    }
  };
  const fakeDb = { transaction: (fn) => fn(tx) };
  const request = () => exportWordPressDraft(fakeDb, {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    artifactId: 'artifact-1',
    wordpressBaseUrl: origin,
    username: 'wp-user',
    applicationPassword: 'application-password',
    environment: 'test',
    testMode: true,
    network: {
      allowPrivateNetworks: true,
      allowInsecureCredentialTransport: true
    }
  });

  await assert.rejects(request, { code: 'WORDPRESS_DRAFT_CONTRACT_FAILED' });
  assert.deepEqual(updates, ['failed']);

  updates.length = 0;
  upstreamPost = { id: 'not-an-id', status: 'draft' };
  await assert.rejects(request, { code: 'WORDPRESS_DRAFT_CONTRACT_FAILED' });
  assert.deepEqual(updates, ['failed']);
});
