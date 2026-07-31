import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { registerRssSource, syncRssSource } from '../apps/shared/rss.js';
import { saveModelProvider } from '../apps/shared/intelligence.js';
import { createPlan } from '../apps/shared/planner.js';
import { processNextEvent } from '../apps/worker/worker.js';
import { approveArtifact, verifyBlock } from '../apps/shared/review.js';

const secretKey = Buffer.alloc(32, 19).toString('base64');
const f = (text, ...atomRefs) => ({ text, kind: 'factual', atomRefs });
const p = (text) => ({ text, kind: 'production', atomRefs: [] });

function qualityCanary() {
  const requests = [];
  let naverEvaluatorContractBroken = false;
  let schemaRepairHandle = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const rawPrompt = request.messages.at(-1).content;
    const prompt = JSON.parse(rawPrompt);
    requests.push({ request, prompt });
    let output;
    if (prompt.task === 'EVIDENCE_PLAN') {
      output = {
        readiness: 'complete',
        supportedPurpose: prompt.requestedPurpose,
        reasons: ['두 근거가 요청 목적을 직접 지원함'],
        missingInformation: [],
        selectedSourceHandles: prompt.sourceAtoms.map((atom) => atom.handle),
        contentBudget: { maximumClaims: 2, rationale: '두 사실만 사용' }
      };
    } else if (prompt.task === 'PLATFORM_DRAFT' && prompt.profile.channel === 'naver_blog') {
      const [price, delivery] = prompt.evidencePlan.selectedSourceHandles;
      output = {
        title: f('가격과 배송을 원본대로 확인하는 방법', price, delivery),
        intro: f('가격은 100원이고 배송은 내일입니다.', price, delivery),
        sections: [
          { heading: f('가격 기준', price), body: f('공개된 가격은 100원입니다.', price) },
          { heading: f('배송 기준', delivery), body: f('공개된 배송 일정은 내일입니다.', delivery) }
        ],
        faq: [],
        cta: null,
        tags: [f('가격', price), f('배송', delivery)]
      };
    } else if (prompt.task === 'PLATFORM_DRAFT' && prompt.profile.channel === 'youtube_shorts') {
      const [price, delivery] = prompt.evidencePlan.selectedSourceHandles;
      schemaRepairHandle = price;
      output = {
        title: f('가격과 배송 30초 확인', price, delivery),
        hook: f('가격 100원, 배송 내일. 두 가지만 확인하세요.', price, delivery),
        scenes: [
          { durationSeconds: 2, narration: f('가격은 100원입니다.', price), onScreenText: f('가격 100원', price), visualDirection: p('가격표를 중앙에 표시'), safeZoneNote: p('상단과 우측 UI 영역을 비움') },
          { durationSeconds: 4, narration: f('공개된 가격 기준은 100원입니다.', price), onScreenText: f('공개 가격 기준', price), visualDirection: p('가격 원본 카드'), safeZoneNote: p('하단 자막 안전 영역 사용') },
          { durationSeconds: 3, narration: f('배송 일정은 내일입니다.', delivery), onScreenText: f('배송 내일', delivery), visualDirection: p('달력 카드'), safeZoneNote: p('우측 버튼 영역을 비움') }
        ],
        ending: f('가격 100원과 배송 내일을 기준으로 확인하세요.', price, delivery),
        caption: f('가격 100원 · 배송 내일', price, delivery),
        coverText: f('가격·배송 확인', price, delivery)
      };
      output.scenes[0].narration.kind = 'production';
      output.scenes[0].narration.atomRefs = [];
    } else if (prompt.task === 'PLATFORM_DRAFT_SCHEMA_REPAIR') {
      assert.equal(prompt.originalContract.contractVersion, 'visible-text-platform-draft.v2');
      assert.ok(prompt.priorCandidate);
      assert.match(prompt.priorCandidate.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(prompt.repairMode, 'path_operations');
      assert.deepEqual(prompt.allowedChangedPaths, ['$.scenes[0].narration.atomRefs']);
      output = {
        repairs: [{ path: '$.scenes[0].narration.atomRefs', value: [schemaRepairHandle] }]
      };
    } else if (prompt.task === 'STRICT_CLAIM_EVALUATION') {
      output = {
        purposeFit: 'supported',
        purposeReason: '모든 주장이 제시된 원본 문장 범위 안에 있음',
        blocks: prompt.factualBlocks.map((block) => ({
          blockKey: block.blockKey,
          verdict: 'supported',
          claims: [{ claim: block.text, verdict: 'supported', sourceHandles: block.evidence.map((row) => row.handle), reason: '인용 문장이 직접 뒷받침함' }]
        })),
        allVisibleBlocksReviewed: true,
        creatorIdentityClaims: [],
        platformChecks: (prompt.rubric || []).map((rubric) => ({ code: rubric.key, passed: true, reason: rubric.criterion }))
      };
      if (prompt.platform === 'naver_blog' && !naverEvaluatorContractBroken) {
        naverEvaluatorContractBroken = true;
        output.blocks[0].claims[0].verdict = 'invalid-canary-verdict';
        output.blocks[0].claims[0].reason = '계약 복구 canary';
        const unsupported = output.blocks.find((block) => block.blockKey === 'intro');
        unsupported.claims[0].verdict = 'insufficient';
        unsupported.claims[0].reason = '의미 수정 canary';
      }
    } else if (prompt.task === 'EVALUATOR_CONTRACT_REPAIR') {
      assert.ok(prompt.priorCandidate);
      assert.equal(prompt.validationFailure.code, 'EVALUATOR_CONTRACT_FAILED');
      assert.equal(prompt.repairMode, 'path_operations');
      assert.ok(prompt.allowedChangedPaths.some((path) => path.startsWith('$.blocks[')));
      const verdictPath = prompt.allowedChangedPaths.find((path) => path.endsWith('.verdict'));
      assert.ok(verdictPath);
      output = {
        repairs: [{
          path: verdictPath,
          value: 'supported'
        }]
      };
    } else if (prompt.task === 'QUALITY_REPAIR') {
      assert.equal(prompt.repairMode, 'path_operations');
      assert.equal(prompt.validationFailure.code, 'QUALITY_REPAIR_REQUIRED');
      assert.deepEqual(prompt.allowedChangedPaths, ['$.intro']);
      assert.equal(
        prompt.validationFailure.meta.failedChecks[0].details.failedClaims[0].reason,
        '의미 수정 canary'
      );
      const priceHandle = prompt.originalContract.sourceAtoms[0].handle;
      output = {
        repairs: [{
          path: '$.intro',
          value: f('가격은 100원입니다.', priceHandle)
        }]
      };
    } else {
      res.statusCode = 422;
      return res.end(JSON.stringify({ error: `unexpected task ${prompt.task}` }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'solar-open2-canary',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 }
    }));
  });
  return { server, requests };
}

function failedSchemaRepairCanary() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = JSON.parse(request.messages.at(-1).content);
    requests.push({ request, prompt });
    let output;
    if (prompt.task === 'EVIDENCE_PLAN') {
      output = {
        readiness: 'complete',
        supportedPurpose: prompt.requestedPurpose,
        reasons: ['선택한 두 문장이 요청 목적을 직접 지원함'],
        missingInformation: [],
        selectedSourceHandles: prompt.sourceAtoms.map((atom) => atom.handle),
        contentBudget: { maximumClaims: 2, rationale: '두 사실만 사용' }
      };
    } else if (prompt.task === 'PLATFORM_DRAFT') {
      const [price, delivery] = prompt.evidencePlan.selectedSourceHandles;
      const durations = prompt.generationConstraints.sceneDurationPlanSeconds;
      const denseNarration = '배송은 내일입니다. '.repeat(80).trim();
      output = {
        title: f('가격과 배송 확인', price, delivery),
        hook: f('가격과 배송을 확인하세요.', price, delivery),
        scenes: durations.map((durationSeconds, index) => ({
          durationSeconds,
          narration: index === 1
            ? f(denseNarration, delivery)
            : f(index === 0 ? '가격은 100원입니다.' : '배송은 내일입니다.', index === 0 ? price : delivery),
          onScreenText: f(index === 0 ? '가격 100원' : '배송 내일', index === 0 ? price : delivery),
          visualDirection: p(`${index + 1}번째 정보 카드를 표시`),
          safeZoneNote: p('상단과 우측 UI 영역을 비움')
        })),
        ending: f('가격은 100원이고 배송은 내일입니다.', price, delivery),
        caption: f('가격 100원 · 배송 내일', price, delivery),
        coverText: f('가격·배송 확인', price, delivery)
      };
    } else if (prompt.task === 'PLATFORM_DRAFT_SCHEMA_REPAIR') {
      assert.equal(prompt.validationFailure.code, 'CHANNEL_CONSTRAINT_FAILED');
      assert.equal(prompt.repairMode, 'server_certified_narration');
      assert.equal(prompt.narrationRepairPlan.slots.length, 1);
      output = {
        selections: [],
        unexpectedMutation: true
      };
    } else {
      res.statusCode = 422;
      return res.end(JSON.stringify({ error: `unexpected task ${prompt.task}` }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'solar-open2-schema-failure-canary',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 111, completion_tokens: 22 }
    }));
  });
  return { server, requests };
}

test('evidence-first worker creates only selected platform artifacts with persisted low-assurance checks and human approval boundary', async (t) => {
  const canary = qualityCanary();
  await new Promise((resolve) => canary.server.listen(0, '127.0.0.1', resolve));
  t.after(() => canary.server.close());
  const base = `http://127.0.0.1:${canary.server.address().port}`;
  const feedServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/rss+xml');
    res.end(`<rss xmlns:content="urn:test"><channel><item>
      <guid>quality-source</guid><title>가격과 배송</title><link>https://example.test/quality</link>
      <content:encoded><![CDATA[<p>가격은 100원입니다.</p><p>배송은 내일입니다.</p>]]></content:encoded>
    </item></channel></rss>`);
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => feedServer.close());

  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, { email: 'quality@example.test', password: 'correct-horse-battery-staple' });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  const sourceId = await registerRssSource(db, {
    workspaceId,
    userId: user.id,
    name: '품질 원본',
    feedUrl: `http://127.0.0.1:${feedServer.address().port}/feed.xml`,
    rightsStatus: 'owned'
  });
  await syncRssSource(db, sourceId, { network: { allowPrivateNetworks: true } });
  const sourceItem = (await db.query('SELECT * FROM source_items WHERE source_id=$1', [sourceId]))[0];
  const providerId = await saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'Solar protocol canary',
    providerType: 'solar',
    baseUrl: `${base}/v1`,
    model: 'solar-open2',
    apiKey: 'test-only',
    isDefault: true,
    environment: 'test',
    secretKey,
    testMode: true,
    allowInsecureCredentialTransport: true
  });
  const plan = await createPlan(db, {
    workspaceId,
    userId: user.id,
    sourceItemId: sourceItem.id,
    providerId,
    evaluatorProviderId: providerId,
    outputs: [
      { platformProfileVersionId: 'naver_blog:v2', type: 'naver_blog', settings: { purpose: '가격과 배송 기준 안내' } },
      { platformProfileVersionId: 'youtube_shorts:v1', type: 'youtube_shorts', settings: { purpose: '가격과 배송을 30초에 안내', targetSeconds: 30, visualStyle: '정보 카드', includeCaptions: true } }
    ]
  });
  assert.deepEqual(plan.selectedOutputs.sort(), ['naver_blog', 'youtube_shorts']);
  assert.equal(plan.evaluatorAssurance, 'LOW_ASSURANCE');
  const config = { environment: 'test', testMode: true, secretKey, network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true } };
  const first = await processNextEvent(db, config);
  const second = await processNextEvent(db, config);
  assert.equal(first.error, undefined, first.error?.stack || first.error?.message);
  assert.equal(second.error, undefined, second.error?.stack || second.error?.message);

  const artifacts = await db.query('SELECT * FROM artifacts ORDER BY channel');
  assert.deepEqual(artifacts.map((artifact) => artifact.channel), ['naver_blog', 'youtube_shorts']);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM plan_outputs'))[0].count, 2);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM generation_executions'))[0].count, 2);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM generation_attempts'))[0].count, 4);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM generation_attempts WHERE attempt_kind='schema_repair' AND status='accepted'"))[0].count, 1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM generation_attempts WHERE attempt_kind='content_repair' AND status='accepted'"))[0].count, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM quality_evaluation_runs WHERE assurance=$1', ['LOW_ASSURANCE']))[0].count, 3);

  for (const artifact of artifacts) {
    const version = (await db.query('SELECT * FROM artifact_versions WHERE id=$1', [artifact.current_version_id]))[0];
    const blocks = await db.query('SELECT * FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal', [version.id]);
    assert.ok(blocks.length > 4);
    assert.ok(blocks.every((block) => block.surface_path && block.content_hash));
    const factual = blocks.filter((block) => block.content_kind === 'factual');
    assert.ok(factual.length > 0);
    assert.ok(factual.every((block) => block.auto_check.automaticSupport === 'supported'));
    for (const block of factual) {
      const refs = await db.query('SELECT * FROM block_source_refs WHERE artifact_block_id=$1', [block.id]);
      assert.ok(refs.length > 0, `${artifact.channel}:${block.block_key} must have exact persisted refs`);
      assert.equal(block.evidence_state, 'review_required');
      await verifyBlock(db, { workspaceId, userId: user.id, blockId: block.id, note: '현재 스냅샷과 직접 비교함' });
    }
    await approveArtifact(db, { workspaceId, userId: user.id, artifactId: artifact.id, note: '모든 사실 블록 확인' });
  }

  const run = (await db.query('SELECT * FROM runs WHERE id=$1', [plan.runId]))[0];
  assert.equal(run.status, 'succeeded');
  assert.ok(canary.requests.every(({ request }) => request.response_format.type === 'json_object'));
  assert.ok(canary.requests.every(({ request }) => request.messages.some((message) => /\bjson\b/i.test(message.content))));
  assert.ok(canary.requests
    .filter(({ prompt }) => prompt.task === 'STRICT_CLAIM_EVALUATION')
    .every(({ request }) => request.max_tokens === 8_192));
  assert.equal(canary.requests.filter(({ prompt }) => prompt.task === 'PLATFORM_DRAFT_SCHEMA_REPAIR').length, 1);
  assert.equal(canary.requests.filter(({ prompt }) => prompt.task === 'EVALUATOR_CONTRACT_REPAIR').length, 1);
  assert.equal(canary.requests.filter(({ prompt }) => prompt.task === 'QUALITY_REPAIR').length, 1);
});

test('a parsed terminal schema-repair scope failure persists its provider attempt before the run fails', async (t) => {
  const canary = failedSchemaRepairCanary();
  await new Promise((resolve) => canary.server.listen(0, '127.0.0.1', resolve));
  t.after(() => canary.server.close());
  const providerBase = `http://127.0.0.1:${canary.server.address().port}`;
  const feedServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/rss+xml');
    res.end(`<rss xmlns:content="urn:test"><channel><item>
      <guid>failed-schema-repair-source</guid><title>가격과 배송</title><link>https://example.test/schema-repair</link>
      <content:encoded><![CDATA[<p>가격은 100원입니다.</p><p>배송은 내일입니다.</p>]]></content:encoded>
    </item></channel></rss>`);
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => feedServer.close());

  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: 'schema-repair-failure@example.test',
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  const sourceId = await registerRssSource(db, {
    workspaceId,
    userId: user.id,
    name: '스키마 복구 실패 원본',
    feedUrl: `http://127.0.0.1:${feedServer.address().port}/feed.xml`,
    rightsStatus: 'owned'
  });
  await syncRssSource(db, sourceId, { network: { allowPrivateNetworks: true } });
  const sourceItem = (await db.query('SELECT * FROM source_items WHERE source_id=$1', [sourceId]))[0];
  const providerId = await saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'Solar schema failure canary',
    providerType: 'solar',
    baseUrl: `${providerBase}/v1`,
    model: 'solar-open2',
    apiKey: 'test-only',
    isDefault: true,
    environment: 'test',
    secretKey,
    testMode: true,
    allowInsecureCredentialTransport: true
  });
  const plan = await createPlan(db, {
    workspaceId,
    userId: user.id,
    sourceItemId: sourceItem.id,
    providerId,
    evaluatorProviderId: providerId,
    outputs: [{
      platformProfileVersionId: 'youtube_shorts:v1',
      type: 'youtube_shorts',
      settings: {
        purpose: '가격과 배송을 30초에 안내',
        targetSeconds: 30,
        visualStyle: '정보 카드',
        includeCaptions: true
      }
    }]
  });
  const config = {
    environment: 'test',
    testMode: true,
    secretKey,
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  };
  const result = await processNextEvent(db, config);
  assert.equal(result.error?.code, 'QUALITY_REPAIR_SCOPE_VIOLATION');
  assert.equal(result.retry, false);

  const attempts = await db.query(`SELECT attempt_no,attempt_kind,status,error_code,raw_output,
      candidate,schema_result,usage,finish_reason
    FROM generation_attempts ORDER BY attempt_no`);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map(({ attempt_no, attempt_kind, status, error_code }) => ({
      attempt_no,
      attempt_kind,
      status,
      error_code
    })),
    [
      {
        attempt_no: 1,
        attempt_kind: 'draft',
        status: 'schema_failed',
        error_code: 'CHANNEL_CONSTRAINT_FAILED'
      },
      {
        attempt_no: 2,
        attempt_kind: 'schema_repair',
        status: 'schema_failed',
        error_code: 'QUALITY_REPAIR_SCOPE_VIOLATION'
      }
    ]
  );
  const failedRepair = attempts[1];
  assert.deepEqual(failedRepair.usage, { prompt_tokens: 111, completion_tokens: 22 });
  assert.equal(failedRepair.finish_reason, 'stop');
  assert.deepEqual(JSON.parse(failedRepair.raw_output), failedRepair.candidate);
  assert.equal(failedRepair.schema_result.passed, false);
  assert.equal(failedRepair.schema_result.code, 'QUALITY_REPAIR_SCOPE_VIOLATION');

  const execution = (await db.query(`SELECT status,error_code,completed_at
    FROM generation_executions`))[0];
  assert.equal(execution.status, 'failed');
  assert.equal(execution.error_code, 'QUALITY_REPAIR_SCOPE_VIOLATION');
  assert.ok(execution.completed_at);
  assert.deepEqual(
    await db.query('SELECT status,quality_status FROM plan_outputs'),
    [{ status: 'failed', quality_status: 'failed' }]
  );
  assert.deepEqual(
    await db.query('SELECT status FROM runs WHERE id=$1', [plan.runId]),
    [{ status: 'failed' }]
  );
  assert.equal((await db.query('SELECT count(*)::int AS count FROM artifacts'))[0].count, 0);
  assert.equal(await processNextEvent(db, config), null);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM generation_attempts'))[0].count, 2);
  assert.equal(canary.requests.filter(({ prompt }) => prompt.task === 'PLATFORM_DRAFT_SCHEMA_REPAIR').length, 1);
});
