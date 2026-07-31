import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, createPostgresDatabase, migrate } from '../apps/shared/db.js';
import { persistEntry, registerRssSource, syncRssSource } from '../apps/shared/rss.js';
import { saveModelProvider } from '../apps/shared/intelligence.js';
import { createPlan } from '../apps/shared/planner.js';
import { activeChannelCatalog, setChannelActive } from '../apps/shared/channels.js';
import { processNextEvent } from '../apps/worker/worker.js';
import {
  affectedBlocksFromRefs,
  applySourceUpdate,
  changedAtomIds,
  currentVersionDriftFromRefs,
  recordRefreshDecision
} from '../apps/shared/freshness.js';
import {
  approveArtifact,
  editArtifactBlock,
  requestRegeneration,
  setBlockHold,
  verifyBlock
} from '../apps/shared/review.js';
import { exportMarkdown, exportWordPressDraft } from '../apps/shared/export.js';
import { generatePlanOutput } from '../apps/shared/generation.js';
import { stableKey } from '../apps/shared/ids.js';

const secretKey = Buffer.alloc(32, 3).toString('base64');
const factual = (text, ...atomRefs) => ({ text, kind: 'factual', atomRefs });
const production = (text) => ({ text, kind: 'production', atomRefs: [] });

async function integrationDatabase(t) {
  const postgresUrl = process.env.OSAU_POSTGRES_TEST_URL;
  if (!postgresUrl) {
    if (process.env.OSAU_REQUIRE_POSTGRES === '1') {
      throw new Error('OSAU_POSTGRES_TEST_URL is required for the PostgreSQL integration gate.');
    }
    t.diagnostic('integration database: PGlite (set OSAU_POSTGRES_TEST_URL for the real PostgreSQL boundary)');
    const db = createPgliteDatabase(new PGlite());
    t.after(() => db.close());
    return db;
  }

  const schema = `osau_it_${process.pid}_${randomUUID().replace(/-/gu, '')}`;
  const administrator = createPostgresDatabase(postgresUrl);
  await administrator.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(postgresUrl);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = createPostgresDatabase(scopedUrl.toString());
  t.diagnostic(`integration database: PostgreSQL isolated schema ${schema}`);
  t.after(async () => {
    await db.close();
    try {
      await administrator.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await administrator.close();
    }
  });
  return db;
}

function sourceHandle(prompt, pattern) {
  const atom = prompt.sourceAtoms?.find((row) => pattern.test(row.text));
  assert.ok(atom, `provider canary could not find source atom: ${pattern}`);
  return atom.handle;
}

function draftFor(prompt) {
  const price = sourceHandle(prompt, /(?:100|120|140)원/u);
  const delivery = sourceHandle(prompt, /배송은 내일/u);
  const currentPrice = prompt.sourceAtoms.find((atom) => atom.handle === price).text.match(/(?:100|120|140)원/u)?.[0];
  if (prompt.profile.channel === 'naver_blog') {
    return {
      title: factual(`가격 ${currentPrice}과 배송 내일을 확인하는 방법`, price, delivery),
      intro: factual(`공개된 가격은 ${currentPrice}이고 배송은 내일입니다.`, price, delivery),
      sections: [
        {
          heading: factual('가격 기준', price),
          body: factual(`원본에 공개된 가격은 ${currentPrice}입니다.`, price)
        },
        {
          heading: factual('배송 기준', delivery),
          body: factual('원본에 공개된 배송 일정은 내일입니다.', delivery)
        }
      ],
      faq: [],
      cta: null,
      tags: [factual('가격', price), factual('배송', delivery)]
    };
  }
  if (prompt.profile.channel === 'youtube_shorts') {
    return {
      title: factual(`가격 ${currentPrice}과 배송 30초 확인`, price, delivery),
      hook: factual(`가격 ${currentPrice}, 배송 내일. 두 가지만 확인하세요.`, price, delivery),
      scenes: [
        {
          durationSeconds: 2,
          narration: factual(`가격은 ${currentPrice}입니다.`, price),
          onScreenText: factual(`가격 ${currentPrice}`, price),
          visualDirection: production('가격표를 중앙에 표시'),
          safeZoneNote: production('상단과 우측 UI 영역을 비움')
        },
        {
          durationSeconds: 10,
          narration: factual(`공개된 가격 기준은 ${currentPrice}입니다.`, price),
          onScreenText: factual('공개 가격 기준', price),
          visualDirection: production('가격 원본 카드'),
          safeZoneNote: production('하단 자막 안전 영역 사용')
        },
        {
          durationSeconds: 10,
          narration: factual('배송 일정은 내일입니다.', delivery),
          onScreenText: factual('배송 내일', delivery),
          visualDirection: production('달력 카드'),
          safeZoneNote: production('우측 버튼 영역을 비움')
        }
      ],
      ending: factual(`가격 ${currentPrice}과 배송 내일을 기준으로 확인하세요.`, price, delivery),
      caption: factual(`가격 ${currentPrice} · 배송 내일`, price, delivery),
      coverText: factual('가격·배송 확인', price, delivery)
    };
  }
  throw new Error(`unexpected draft profile ${prompt.profile.channel}`);
}

function evaluationFor(prompt) {
  return {
    purposeFit: 'supported',
    purposeReason: '모든 사실 주장이 함께 전달된 원본 문장 범위 안에 있음',
    allVisibleBlocksReviewed: true,
    blocks: prompt.factualBlocks.map((block) => ({
      blockKey: block.blockKey,
      verdict: 'supported',
      claims: [{
        claim: block.text,
        verdict: 'supported',
        sourceHandles: block.evidence.map((row) => row.handle),
        reason: '연결된 원본 문장이 이 주장을 직접 뒷받침함'
      }]
    })),
    creatorIdentityClaims: [],
    platformChecks: (prompt.rubric || []).map((rubric) => ({
      code: rubric.key,
      passed: true,
      reason: rubric.criterion,
      affectedBlockKeys: []
    }))
  };
}

function integrationCanary(state) {
  const modelRequests = [];
  const wordpressRequests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');

    if (req.url === '/feed.xml') {
      res.setHeader('content-type', 'application/rss+xml');
      res.end(`<rss xmlns:content="urn:test"><channel><item>
        <guid>post-1</guid><title>가격과 배송</title><link>https://example.test/post-1</link>
        <content:encoded><![CDATA[<p>${state.priceText}</p><p>배송은 내일입니다.</p>]]></content:encoded>
      </item></channel></rss>`);
      return;
    }

    if (req.url === '/v1/chat/completions') {
      const request = JSON.parse(body);
      const rawPrompt = request.messages.at(-1).content;
      const [jsonPrompt, repairInstruction = ''] = rawPrompt.split(/\n\n(?=SCHEMA_REPAIR|JSON_CONTRACT_REPAIR)/u);
      const prompt = JSON.parse(jsonPrompt);
      modelRequests.push({ request, prompt, repairInstruction });
      let output;
      if (prompt.task === 'EVIDENCE_PLAN') {
        output = {
          readiness: 'complete',
          supportedPurpose: prompt.requestedPurpose,
          reasons: ['가격과 배송 근거가 요청 목적을 직접 지원함'],
          missingInformation: [],
          selectedSourceHandles: prompt.sourceAtoms.map((atom) => atom.handle),
          contentBudget: { maximumClaims: 2, rationale: '원본의 두 사실 범위로 제한' }
        };
      } else if (prompt.task === 'PLATFORM_DRAFT') {
        output = draftFor(prompt);
      } else if (prompt.task === 'STRICT_CLAIM_EVALUATION') {
        output = evaluationFor(prompt);
      } else if (prompt.task === 'PATCH_ONLY') {
        const price = sourceHandle(prompt, /120원/u);
        output = {
          blocks: prompt.blocksToPatch.map((block) => ({
            key: block.key,
            text: `${block.key} · 최신 가격 120원`,
            kind: block.kind,
            atomRefs: [price]
          }))
        };
      } else {
        res.statusCode = 422;
        res.end(JSON.stringify({ error: `unexpected task ${prompt.task}` }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'solar-open2-canary',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      }));
      return;
    }

    if (req.url?.startsWith('/wp/wp-json/wp/v2/posts?')) {
      wordpressRequests.push({ method: req.method, url: req.url });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state.wordpressPost ? [state.wordpressPost] : []));
      return;
    }
    if (req.url === '/wp/wp-json/wp/v2/posts') {
      const payload = JSON.parse(body);
      wordpressRequests.push({ method: req.method, url: req.url, payload });
      state.wordpressPost = { id: 77, status: 'draft' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state.wordpressPost));
      return;
    }

    res.statusCode = 404;
    res.end();
  });
  return { server, modelRequests, wordpressRequests };
}

async function processJob(db, config, expectedType) {
  const job = await processNextEvent(db, config);
  assert.ok(job, `expected queued ${expectedType} job`);
  assert.equal(job.eventType, expectedType);
  assert.equal(job.error, undefined, job.error?.stack || job.error?.message);
  return job;
}

async function verifyEveryFactual(db, { workspaceId, userId, artifactId }) {
  const artifact = (await db.query('SELECT * FROM artifacts WHERE id=$1', [artifactId]))[0];
  const factualBlocks = await db.query(`SELECT * FROM artifact_blocks
    WHERE artifact_version_id=$1 AND content_kind='factual'
    ORDER BY ordinal`, [artifact.current_version_id]);
  assert.ok(factualBlocks.length > 0);
  for (const block of factualBlocks) {
    await verifyBlock(db, {
      workspaceId,
      userId,
      blockId: block.id,
      note: '현재 스냅샷의 연결된 원본 문장과 직접 비교함'
    });
  }
  return factualBlocks;
}

async function reviewConcurrencyFixture(db, {
  workspaceId,
  userId,
  factual = false
}) {
  const sourceId = randomUUID();
  const sourceItemId = randomUUID();
  const snapshotId = randomUUID();
  const artifactId = randomUUID();
  const versionId = randomUUID();
  const blockId = randomUUID();
  const segmentId = factual ? randomUUID() : null;
  const atomId = factual ? randomUUID() : null;
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,rights_status,created_by)
      VALUES ($1,$2,'review concurrency source','rss','https://example.test/feed.xml','owned',$3)`, [
      sourceId,
      workspaceId,
      userId
    ]);
    await tx.query(`INSERT INTO source_items
      (id,source_id,external_key,title)
      VALUES ($1,$2,$3,'검토 경쟁 원본')`, [
      sourceItemId,
      sourceId,
      stableKey(`review-concurrency:${sourceItemId}`)
    ]);
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,1,$3,'검토 경쟁 원본','가격은 100원입니다.')`, [
      snapshotId,
      sourceItemId,
      stableKey(`snapshot:${snapshotId}`)
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      sourceItemId,
      snapshotId
    ]);
    if (factual) {
      await tx.query(`INSERT INTO source_segments
        (id,snapshot_id,position_label,ordinal,segment_type,text)
        VALUES ($1,$2,'본문 1',1,'paragraph','가격은 100원입니다.')`, [
        segmentId,
        snapshotId
      ]);
      await tx.query(`INSERT INTO content_atoms
        (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
        VALUES ($1,$2,$3,'본문 1 · 문장 1','number','가격은 100원입니다.','price-v1')`, [
        atomId,
        snapshotId,
        segmentId
      ]);
    }
    await tx.query(`INSERT INTO artifacts
      (id,workspace_id,source_item_id,channel,state,created_by)
      VALUES ($1,$2,$3,'naver_blog','review_required',$4)`, [
      artifactId,
      workspaceId,
      sourceItemId,
      userId
    ]);
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,
       channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,1,$3,
       '{"type":"naver_draft_preview","title":"검토 경쟁","intro":"","sections":[],"cta":null,"tags":[]}'::jsonb,
       'naver_blog:v2','prompt.v1','evaluator.v1')`, [
      versionId,
      artifactId,
      snapshotId
    ]);
    await tx.query('UPDATE artifacts SET current_version_id=$2 WHERE id=$1', [
      artifactId,
      versionId
    ]);
    await tx.query(`INSERT INTO artifact_blocks
      (id,artifact_version_id,block_key,block_type,ordinal,content,evidence_state,
       auto_check,surface_path,content_kind,content_hash)
      VALUES ($1,$2,'review-boundary','paragraph',1,$3,$4,'{}'::jsonb,$5,$6,$7)`, [
      blockId,
      versionId,
      factual ? '가격은 100원입니다.' : '검토용 편집 문장',
      factual ? 'review_required' : 'not_required',
      factual ? '$.intro' : '$.cta',
      factual ? 'factual' : 'editorial',
      stableKey(`block:${blockId}`)
    ]);
    if (factual) {
      await tx.query(
        'INSERT INTO block_source_refs (artifact_block_id,content_atom_id) VALUES ($1,$2)',
        [blockId, atomId]
      );
    }
  });
  return {
    sourceItemId,
    snapshotId,
    artifactId,
    versionId,
    blockId,
    atomId
  };
}

test('the seven-profile pipeline persists grounded selected artifacts, exact freshness, human approval, and draft-only exports', async (t) => {
  const state = {
    priceText: '가격은 100원입니다.',
    wordpressPost: null
  };
  const canary = integrationCanary(state);
  await new Promise((resolve) => canary.server.listen(0, '127.0.0.1', resolve));
  t.after(() => canary.server.close());
  const base = `http://127.0.0.1:${canary.server.address().port}`;

  const db = await integrationDatabase(t);
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: 'admin@example.test',
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;

  const initialCatalog = await activeChannelCatalog(db, workspaceId);
  assert.deepEqual(initialCatalog.map((row) => row.id).sort(), [
    'instagram_carousel:v2',
    'instagram_reels:v1',
    'naver_blog:v2',
    'newsletter:v2',
    'tiktok_video:v1',
    'wordpress_article:v2',
    'youtube_shorts:v1'
  ]);
  assert.equal(initialCatalog.some((row) => row.channel === 'short_video'), false, 'legacy generic short profile is not selectable');
  await setChannelActive(db, { workspaceId, channel: 'newsletter', active: false });
  assert.equal((await activeChannelCatalog(db, workspaceId)).some((row) => row.channel === 'newsletter'), false);
  await setChannelActive(db, { workspaceId, channel: 'newsletter', active: true });

  const sourceId = await registerRssSource(db, {
    workspaceId,
    userId: user.id,
    name: '테스트 RSS',
    feedUrl: `${base}/feed.xml`,
    rightsStatus: 'owned'
  });
  await syncRssSource(db, sourceId, { network: { allowPrivateNetworks: true } });
  const sourceItem = (await db.query('SELECT * FROM source_items WHERE source_id=$1', [sourceId]))[0];
  const assessment = (await db.query('SELECT * FROM source_snapshot_assessments WHERE snapshot_id=$1', [sourceItem.latest_snapshot_id]))[0];
  assert.equal(assessment.readiness, 'complete');
  assert.equal(assessment.rights_status, 'owned');

  const providerId = await saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'Solar structured protocol canary',
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
      {
        platformProfileVersionId: 'naver_blog:v2',
        type: 'naver_blog',
        settings: { purpose: '가격과 배송 기준을 검색 독자에게 정확히 안내', keyword: '가격 배송', includeFaq: false }
      },
      {
        platformProfileVersionId: 'youtube_shorts:v1',
        type: 'youtube_shorts',
        settings: {
          purpose: '가격과 배송을 30초 안에 자막과 함께 안내',
          targetSeconds: 30,
          visualStyle: '근거 카드',
          includeCaptions: true
        }
      }
    ]
  });
  assert.deepEqual(plan.selectedOutputs.sort(), ['naver_blog', 'youtube_shorts']);
  assert.equal(plan.evaluatorAssurance, 'LOW_ASSURANCE');

  const config = {
    environment: 'test',
    testMode: true,
    secretKey,
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  };
  await processJob(db, config, 'generate_plan_output');
  await processJob(db, config, 'generate_plan_output');
  assert.equal(await processNextEvent(db, config), null, 'generation enqueues only selected outputs');

  const artifacts = await db.query('SELECT * FROM artifacts ORDER BY channel');
  assert.deepEqual(artifacts.map((row) => row.channel), ['naver_blog', 'youtube_shorts']);
  const naver = artifacts.find((row) => row.channel === 'naver_blog');
  const youtube = artifacts.find((row) => row.channel === 'youtube_shorts');
  const naverVersion = (await db.query('SELECT * FROM artifact_versions WHERE id=$1', [naver.current_version_id]))[0];
  const youtubeVersion = (await db.query('SELECT * FROM artifact_versions WHERE id=$1', [youtube.current_version_id]))[0];
  assert.equal(naverVersion.channel_definition_version_id, 'naver_blog:v2');
  assert.equal(youtubeVersion.channel_definition_version_id, 'youtube_shorts:v1');
  const naverPreview = typeof naverVersion.content === 'string' ? JSON.parse(naverVersion.content) : naverVersion.content;
  const youtubePreview = typeof youtubeVersion.content === 'string' ? JSON.parse(youtubeVersion.content) : youtubeVersion.content;
  assert.equal(naverPreview.type, 'naver_draft_preview');
  assert.equal(youtubePreview.type, 'youtube_shorts_timeline_preview');
  assert.equal(youtubePreview.totalSeconds, 30);
  assert.deepEqual(youtubePreview.previewModes, ['timeline', 'safe_zone', 'cover_crop', 'captions', 'sound_off']);

  const executions = await db.query('SELECT * FROM generation_executions ORDER BY created_at');
  assert.equal(executions.length, 2);
  assert.ok(executions.every((row) => row.status === 'succeeded' && row.evaluator_assurance === 'LOW_ASSURANCE'));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM evidence_plans'))[0].count, 2);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM generation_attempts'))[0].count, 2);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM quality_evaluation_runs WHERE status='passed'"))[0].count, 2);
  assert.deepEqual(
    [...new Set(canary.modelRequests.map((row) => row.prompt.task))].sort(),
    ['EVIDENCE_PLAN', 'PLATFORM_DRAFT', 'STRICT_CLAIM_EVALUATION']
  );
  assert.ok(canary.modelRequests.every(({ request }) => request.response_format?.type === 'json_object'));
  assert.ok(canary.modelRequests.every(({ request }) =>
    request.messages.some((message) => /\bjson\b/iu.test(message.content))));

  for (const artifact of artifacts) {
    const blocks = await db.query('SELECT * FROM artifact_blocks WHERE artifact_version_id=$1', [artifact.current_version_id]);
    assert.ok(blocks.every((block) => block.surface_path && block.content_hash));
    for (const block of blocks.filter((row) => row.content_kind === 'factual')) {
      const refs = await db.query('SELECT * FROM block_source_refs WHERE artifact_block_id=$1', [block.id]);
      assert.ok(refs.length > 0, `${artifact.channel}:${block.block_key} must persist factual refs`);
    }
  }
  const naverBlockTypes = (await db.query('SELECT block_type FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal', [naver.current_version_id])).map((row) => row.block_type);
  const youtubeBlockTypes = (await db.query('SELECT block_type FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal', [youtube.current_version_id])).map((row) => row.block_type);
  assert.notDeepEqual(naverBlockTypes, youtubeBlockTypes, 'article and video are structurally adapted, not length variants');

  await assert.rejects(
    approveArtifact(db, { workspaceId, userId: user.id, artifactId: naver.id, note: '자동 검사만 완료' }),
    (error) => error.code === 'HUMAN_VERIFICATION_REQUIRED'
  );
  const originallyVerified = await verifyEveryFactual(db, { workspaceId, userId: user.id, artifactId: naver.id });
  await approveArtifact(db, {
    workspaceId,
    userId: user.id,
    artifactId: naver.id,
    note: '모든 사실 블록을 현재 원본과 직접 확인함'
  });

  const markdown = await exportMarkdown(db, {
    workspaceId,
    userId: user.id,
    artifactId: naver.id
  });
  assert.match(markdown, /^# 가격 100원과 배송 내일을 확인하는 방법$/m);
  assert.match(markdown, /^## 가격 기준$/m);
  assert.doesNotMatch(markdown, /"atomRefs"|"kind":/);

  const wordpressResults = await Promise.all([0, 1].map(() => exportWordPressDraft(db, {
    workspaceId,
    userId: user.id,
    artifactId: naver.id,
    wordpressBaseUrl: `${base}/wp`,
    username: 'wp-user',
    applicationPassword: 'application-password',
    environment: 'test',
    testMode: true,
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  })));
  assert.ok(wordpressResults.every((result) => result.externalId === '77'));
  assert.deepEqual(wordpressResults.map((result) => result.reused).sort(), [false, true]);
  const createRequest = canary.wordpressRequests.find((row) => row.method === 'POST');
  assert.equal(createRequest.payload.status, 'draft');
  assert.match(createRequest.payload.content, /<h2>가격 기준<\/h2>/);
  assert.doesNotMatch(JSON.stringify(createRequest.payload), /"status":"publish"/);
  const repeated = await exportWordPressDraft(db, {
    workspaceId,
    userId: user.id,
    artifactId: naver.id,
    wordpressBaseUrl: `${base}/wp`,
    username: 'wp-user',
    applicationPassword: 'application-password',
    environment: 'test',
    testMode: true,
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  });
  assert.equal(repeated.reused, true);
  assert.equal(canary.wordpressRequests.filter((row) => row.method === 'POST').length, 1, 'concurrent draft export is idempotent');

  const oldSnapshotId = sourceItem.latest_snapshot_id;
  const oldVersionId = naver.current_version_id;
  const oldBlocks = await db.query('SELECT * FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal', [oldVersionId]);
  state.priceText = '가격은 120원입니다.';
  await syncRssSource(db, sourceId, { network: { allowPrivateNetworks: true } });
  const updatedItem = (await db.query('SELECT * FROM source_items WHERE id=$1', [sourceItem.id]))[0];
  const changed = await changedAtomIds(db, oldSnapshotId, updatedItem.latest_snapshot_id);
  const expectedImpact = await affectedBlocksFromRefs(db, changed);
  assert.ok(expectedImpact.length >= 1);
  await processJob(db, config, 'apply_source_update');

  const exactStale = await db.query('SELECT id FROM artifact_blocks WHERE stale=true ORDER BY id');
  assert.deepEqual(
    exactStale.map((row) => row.id).sort(),
    expectedImpact.map((row) => row.block_id).sort(),
    'only the complete persisted block_source_refs impact set becomes stale'
  );
  const staleIds = new Set(exactStale.map((row) => row.id));
  const invalidations = await db.query(`SELECT artifact_block_id,invalidated_at
    FROM verifications WHERE artifact_block_id=ANY($1::text[])`, [originallyVerified.map((row) => row.id)]);
  assert.ok(invalidations.filter((row) => staleIds.has(row.artifact_block_id)).every((row) => row.invalidated_at));
  assert.ok(invalidations.filter((row) => !staleIds.has(row.artifact_block_id)).every((row) => !row.invalidated_at));
  assert.equal((await db.query('SELECT revoked_at FROM approvals WHERE artifact_version_id=$1', [oldVersionId]))[0].revoked_at != null, true);

  const refresh = await recordRefreshDecision(db, {
    workspaceId,
    userId: user.id,
    artifactId: naver.id,
    decision: 'patch',
    providerId,
    confirmHumanVerificationReset: true
  });
  assert.equal(refresh.status, 'queued');
  assert.ok(refresh.decisionId);
  assert.ok(refresh.runId);
  assert.equal(refresh.affectedBlockCount, expectedImpact.filter((row) => row.artifact_id === naver.id).length);
  let concurrentEdit = null;
  const conflictingPatchJob = await processNextEvent(db, {
    ...config,
    beforePatchPersist: async ({ artifact }) => {
      const staleTarget = (await db.query(`SELECT block.id,block.content
        FROM artifact_blocks block
        WHERE block.artifact_version_id=$1 AND block.stale=true AND block.content_kind='factual'
        ORDER BY block.ordinal LIMIT 1`, [artifact.current_version_id]))[0];
      const sourcePositions = (await db.query(`SELECT atom.position_label
        FROM block_source_refs ref JOIN content_atoms atom ON atom.id=ref.content_atom_id
        WHERE ref.artifact_block_id=$1 ORDER BY atom.position_label`, [staleTarget.id]))
        .map((row) => row.position_label);
      concurrentEdit = await editArtifactBlock(db, {
        workspaceId,
        userId: user.id,
        artifactId: artifact.id,
        blockId: staleTarget.id,
        content: `${staleTarget.content} 사용자 검토 중`,
        sourcePositions,
        note: '부분 새로고침 완료 직전 동시 사용자 편집 canary'
      });
    }
  });
  assert.equal(conflictingPatchJob.eventType, 'patch_artifact');
  assert.equal(conflictingPatchJob.error?.code, 'PATCH_BASE_VERSION_CHANGED');
  assert.equal(
    (await db.query('SELECT current_version_id FROM artifacts WHERE id=$1', [naver.id]))[0].current_version_id,
    concurrentEdit.versionId,
    'a completed model patch cannot overwrite the concurrent user successor'
  );
  assert.equal((await db.query('SELECT status FROM runs WHERE id=$1', [refresh.runId]))[0].status, 'failed');
  const retryRefresh = await recordRefreshDecision(db, {
    workspaceId,
    userId: user.id,
    artifactId: naver.id,
    decision: 'patch',
    providerId
  });
  assert.equal(retryRefresh.baseVersionId, concurrentEdit.versionId);
  const patchJob = await processJob(db, config, 'patch_artifact');
  assert.equal(patchJob.result.held, undefined);
  assert.equal(patchJob.result.patched, retryRefresh.affectedBlockCount);

  const patchedNaver = (await db.query('SELECT * FROM artifacts WHERE id=$1', [naver.id]))[0];
  assert.notEqual(patchedNaver.current_version_id, oldVersionId);
  const patchedBlocks = await db.query('SELECT * FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal', [patchedNaver.current_version_id]);
  assert.equal(patchedBlocks.some((row) => row.stale), false);
  const expectedOldKeys = new Set(expectedImpact.filter((row) => row.artifact_id === naver.id).map((row) =>
    oldBlocks.find((block) => block.id === row.block_id)?.block_key));
  for (const block of patchedBlocks) {
    const old = oldBlocks.find((row) => row.block_key === block.block_key);
    assert.ok(old);
    if (expectedOldKeys.has(block.block_key)) {
      assert.notEqual(block.content, old.content, `stale ${block.block_key} should be replaced`);
      assert.equal(block.origin, 'source_patch');
    } else {
      assert.equal(block.content, old.content, `unaffected ${block.block_key} should stay byte-identical`);
    }
  }
  const patchedRefs = await db.query(`SELECT DISTINCT atom.snapshot_id
    FROM block_source_refs ref
    JOIN content_atoms atom ON atom.id=ref.content_atom_id
    JOIN artifact_blocks block ON block.id=ref.artifact_block_id
    WHERE block.artifact_version_id=$1`, [patchedNaver.current_version_id]);
  assert.deepEqual(patchedRefs.map((row) => row.snapshot_id), [updatedItem.latest_snapshot_id]);
  const patchExecution = (await db.query('SELECT * FROM generation_executions WHERE artifact_version_id=$1', [patchedNaver.current_version_id]))[0];
  assert.equal(patchExecution.status, 'succeeded');
  assert.equal(
    (await db.query('SELECT count(*)::int AS count FROM quality_evaluation_runs WHERE execution_id=$1', [patchExecution.id]))[0].count,
    1,
    'the new base-version decision owns a separate accepted evaluation'
  );
  assert.equal(
    (await db.query('SELECT count(*)::int AS count FROM generation_executions WHERE run_id=$1', [refresh.runId]))[0].count,
    1,
    'the obsolete base-version execution remains as immutable failure evidence'
  );
  assert.equal(
    (await db.query('SELECT count(*)::int AS count FROM generation_executions WHERE run_id=$1', [retryRefresh.runId]))[0].count,
    1,
    'the fresh decision gets one new run-scoped execution'
  );
  const patchedVerificationIds = new Set((await db.query(`SELECT verification.artifact_block_id
    FROM verifications verification
    JOIN artifact_blocks block ON block.id=verification.artifact_block_id
    WHERE block.artifact_version_id=$1 AND verification.invalidated_at IS NULL`, [patchedNaver.current_version_id])).map((row) => row.artifact_block_id));
  assert.ok(patchedBlocks.some((block) => !expectedOldKeys.has(block.block_key) && patchedVerificationIds.has(block.id)), 'unchanged content and atom fingerprints carry human verification');
  assert.ok(patchedBlocks.filter((block) => expectedOldKeys.has(block.block_key)).every((block) => !patchedVerificationIds.has(block.id)), 'changed blocks always require fresh human verification');
  assert.equal((await db.query('SELECT status FROM runs WHERE id=$1', [refresh.runId]))[0].status, 'failed');
  assert.equal((await db.query('SELECT status FROM runs WHERE id=$1', [retryRefresh.runId]))[0].status, 'succeeded');

  const regeneration = await requestRegeneration(db, {
    workspaceId,
    userId: user.id,
    artifactId: patchedNaver.id,
    providerId,
    confirmHumanVerificationReset: true
  });
  assert.equal(regeneration.baseVersionId, patchedNaver.current_version_id);
  let regenerationEdit = null;
  const staleRegeneration = await processNextEvent(db, {
    ...config,
    beforeArtifactPersist: async ({ baseVersionId }) => {
      assert.equal(baseVersionId, regeneration.baseVersionId);
      const currentArtifact = (await db.query(
        'SELECT current_version_id FROM artifacts WHERE id=$1',
        [patchedNaver.id]
      ))[0];
      const target = (await db.query(`SELECT id,content
        FROM artifact_blocks
        WHERE artifact_version_id=$1 AND content_kind='factual'
        ORDER BY ordinal
        LIMIT 1`, [currentArtifact.current_version_id]))[0];
      const sourcePositions = (await db.query(`SELECT atom.position_label
        FROM block_source_refs ref
        JOIN content_atoms atom ON atom.id=ref.content_atom_id
        WHERE ref.artifact_block_id=$1
        ORDER BY atom.position_label`, [target.id])).map((row) => row.position_label);
      regenerationEdit = await editArtifactBlock(db, {
        workspaceId,
        userId: user.id,
        artifactId: patchedNaver.id,
        blockId: target.id,
        content: `${target.content} 재생성 중 사용자 편집`,
        sourcePositions,
        note: '재생성 완료 직전 사용자 편집 canary'
      });
    }
  });
  assert.equal(staleRegeneration.eventType, 'regenerate_artifact');
  assert.equal(staleRegeneration.error?.code, 'REGENERATION_BASE_VERSION_CHANGED');
  assert.equal(
    (await db.query('SELECT current_version_id FROM artifacts WHERE id=$1', [patchedNaver.id]))[0].current_version_id,
    regenerationEdit.versionId,
    'late regeneration cannot overwrite the committed user successor'
  );
  assert.equal(
    (await db.query('SELECT status FROM runs WHERE id=$1', [regeneration.runId]))[0].status,
    'failed'
  );

  // A generation that started from an old plan can finish after the corresponding
  // apply_source_update event found no artifact yet. Artifact finalization must
  // calculate drift from its newly persisted block_source_refs and surface the
  // exact affected set as stale.
  const latePlan = await createPlan(db, {
    workspaceId,
    userId: user.id,
    sourceItemId: sourceItem.id,
    providerId,
    evaluatorProviderId: providerId,
    outputs: [{
      platformProfileVersionId: 'naver_blog:v2',
      type: 'naver_blog',
      settings: {
        purpose: '늦게 완료되는 생성도 최신 원본 변경을 정확히 표시',
        keyword: '가격 배송',
        includeFaq: false
      }
    }]
  });
  const lateOutput = (await db.query('SELECT * FROM plan_outputs WHERE plan_id=$1', [latePlan.planId]))[0];
  assert.equal(lateOutput.artifact_id, null);
  const latePlanSnapshotId = (await db.query('SELECT snapshot_id FROM plans WHERE id=$1', [latePlan.planId]))[0].snapshot_id;

  state.priceText = '가격은 140원입니다.';
  await syncRssSource(db, sourceId, { network: { allowPrivateNetworks: true } });
  const newestSnapshotId = (await db.query('SELECT latest_snapshot_id FROM source_items WHERE id=$1', [sourceItem.id]))[0].latest_snapshot_id;
  assert.notEqual(newestSnapshotId, latePlanSnapshotId);
  const earlyImpact = await applySourceUpdate(db, {
    sourceItemId: sourceItem.id,
    oldSnapshotId: latePlanSnapshotId,
    newSnapshotId: newestSnapshotId
  });
  assert.equal(earlyImpact.affectedBlockIds.includes(lateOutput.artifact_id), false);

  const lateResult = await generatePlanOutput(db, {
    planOutputId: lateOutput.id,
    providerId,
    evaluatorProviderId: providerId,
    runId: latePlan.runId
  }, config);
  assert.equal(lateResult.stale, true);
  const persistedLateOutput = (await db.query('SELECT artifact_id FROM plan_outputs WHERE id=$1', [lateOutput.id]))[0];
  const lateArtifact = (await db.query('SELECT * FROM artifacts WHERE id=$1', [persistedLateOutput.artifact_id]))[0];
  const exactLateDrift = await currentVersionDriftFromRefs(db, {
    workspaceId,
    artifactId: lateArtifact.id
  });
  const lateStaleBlocks = await db.query(`SELECT id FROM artifact_blocks
    WHERE artifact_version_id=$1 AND stale=true ORDER BY id`, [lateArtifact.current_version_id]);
  assert.ok(exactLateDrift.length > 0);
  assert.deepEqual(
    lateStaleBlocks.map((block) => block.id).sort(),
    exactLateDrift.map((block) => block.block_id).sort(),
    'late artifact stale impact is still exactly the persisted block_source_refs set'
  );
  assert.equal(lateArtifact.state, 'stale');
});

test('PostgreSQL source row locking serializes a snapshot commit that reaches approval after the drift check', {
  timeout: 30_000
}, async (t) => {
  if (!process.env.OSAU_POSTGRES_TEST_URL) {
    t.skip('real PostgreSQL is required to exercise two concurrent row-locking transactions');
    return;
  }
  const db = await integrationDatabase(t);
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: `freshness-lock-${randomUUID()}@example.test`,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  const sourceId = randomUUID();
  const sourceItemId = randomUUID();
  const snapshotId = randomUUID();
  const artifactId = randomUUID();
  const versionId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,rights_status,created_by)
      VALUES ($1,$2,'freshness lock source','rss','https://example.test/feed.xml','owned',$3)`, [
      sourceId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO source_items
      (id,source_id,external_key,title)
      VALUES ($1,$2,$3,'잠금 원본')`, [sourceItemId, sourceId, stableKey('lock-entry')]);
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,1,'lock-snapshot-one','잠금 원본','가격은 100원입니다.')`, [
      snapshotId,
      sourceItemId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      sourceItemId,
      snapshotId
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
      (id,artifact_id,version_no,source_snapshot_id,content,
       channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,1,$3,
       '{"type":"naver_draft_preview","title":"잠금 검증","intro":"","sections":[],"cta":null,"tags":[]}'::jsonb,
       'naver_blog:v2','prompt.v1','evaluator.v1')`, [
      versionId,
      artifactId,
      snapshotId
    ]);
    await tx.query('UPDATE artifacts SET current_version_id=$2 WHERE id=$1', [
      artifactId,
      versionId
    ]);
  });

  let releaseApproval;
  const approvalRelease = new Promise((resolve) => { releaseApproval = resolve; });
  let driftReached;
  const driftCheckpoint = new Promise((resolve) => { driftReached = resolve; });
  const approvalDb = {
    dialect: db.dialect,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn({
      query: async (text, params = []) => {
        const rows = await tx.query(text, params);
        if (text.includes('JOIN block_source_refs ref')) {
          driftReached();
          await approvalRelease;
        }
        return rows;
      }
    }))
  };

  let updateAttempted;
  const updateCheckpoint = new Promise((resolve) => { updateAttempted = resolve; });
  const updateDb = {
    dialect: db.dialect,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn({
      query: async (text, params = []) => {
        if (text.includes('FROM source_items') && text.includes('FOR UPDATE')) updateAttempted();
        return tx.query(text, params);
      }
    }))
  };
  const source = (await db.query('SELECT * FROM sources WHERE id=$1', [sourceId]))[0];
  let approvalSettled = false;
  const approval = approveArtifact(approvalDb, {
    workspaceId,
    userId: user.id,
    artifactId,
    note: '동시 snapshot 전환 직전 승인'
  }).finally(() => { approvalSettled = true; });
  await driftCheckpoint;
  let updateSettled = false;
  const update = persistEntry(updateDb, source, {
    key: 'lock-entry',
    title: '잠금 원본',
    body: '가격은 120원입니다.',
    url: 'https://example.test/lock-entry',
    publishedAt: null,
    raw: {},
    ingestionMeta: {}
  }).finally(() => { updateSettled = true; });
  try {
    await updateCheckpoint;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      updateSettled,
      false,
      'source_items FOR UPDATE must wait while approval holds the shared snapshot lock'
    );
  } finally {
    releaseApproval();
  }
  const updatedItemId = await update;
  assert.equal(updatedItemId, sourceItemId, 'the blocked transaction must update the intended existing source item');
  assert.equal(approvalSettled, true, 'snapshot update can settle only after the approval transaction commits');
  await approval;
  assert.notEqual(
    (await db.query('SELECT latest_snapshot_id FROM source_items WHERE id=$1', [sourceItemId]))[0].latest_snapshot_id,
    snapshotId
  );
});

test('PostgreSQL artifact-first locking serializes approval before a concurrent hold revokes it', {
  timeout: 30_000
}, async (t) => {
  if (!process.env.OSAU_POSTGRES_TEST_URL) {
    t.skip('real PostgreSQL is required to exercise approval and hold interleaving');
    return;
  }
  const db = await integrationDatabase(t);
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: `approval-hold-lock-${randomUUID()}@example.test`,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query(
    'SELECT workspace_id FROM users WHERE id=$1',
    [user.id]
  ))[0].workspace_id;
  const fx = await reviewConcurrencyFixture(db, {
    workspaceId,
    userId: user.id,
    factual: false
  });

  let releaseApproval;
  const approvalRelease = new Promise((resolve) => { releaseApproval = resolve; });
  let approvalLocked;
  const approvalCheckpoint = new Promise((resolve) => { approvalLocked = resolve; });
  let paused = false;
  const approvalDb = {
    dialect: db.dialect,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn({
      query: async (text, params = []) => {
        const rows = await tx.query(text, params);
        if (
          !paused
          && text.includes('SELECT * FROM artifacts')
          && text.includes('FOR UPDATE')
        ) {
          paused = true;
          approvalLocked();
          await approvalRelease;
        }
        return rows;
      }
    }))
  };

  let holdAttempted;
  const holdCheckpoint = new Promise((resolve) => { holdAttempted = resolve; });
  let holdQuerySeen = false;
  const holdDb = {
    dialect: db.dialect,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn({
      query: async (text, params = []) => {
        if (!holdQuerySeen) {
          holdQuerySeen = true;
          holdAttempted();
        }
        return tx.query(text, params);
      }
    }))
  };

  const approval = approveArtifact(approvalDb, {
    workspaceId,
    userId: user.id,
    artifactId: fx.artifactId,
    note: '보류 직전 승인'
  });
  await approvalCheckpoint;

  let holdSettled = false;
  const hold = setBlockHold(holdDb, {
    workspaceId,
    userId: user.id,
    blockId: fx.blockId,
    held: true
  }).finally(() => { holdSettled = true; });
  try {
    await holdCheckpoint;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(
      holdSettled,
      false,
      'hold must wait on the artifact row while approval owns the artifact-first lock'
    );
  } finally {
    releaseApproval();
  }

  await approval;
  await hold;
  assert.equal(
    (await db.query(`SELECT count(*)::int AS count
      FROM approvals WHERE artifact_version_id=$1 AND revoked_at IS NULL`, [
      fx.versionId
    ]))[0].count,
    0,
    'the hold transaction that follows approval must revoke the just-created approval'
  );
  assert.equal(
    (await db.query('SELECT state FROM artifacts WHERE id=$1', [fx.artifactId]))[0].state,
    'held'
  );
  assert.equal(
    (await db.query('SELECT held FROM artifact_blocks WHERE id=$1', [fx.blockId]))[0].held,
    true
  );
});

test('PostgreSQL artifact-first locking prevents verification after source invalidation has started', {
  timeout: 30_000
}, async (t) => {
  if (!process.env.OSAU_POSTGRES_TEST_URL) {
    t.skip('real PostgreSQL is required to exercise verification and invalidation interleaving');
    return;
  }
  const db = await integrationDatabase(t);
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: `verification-stale-lock-${randomUUID()}@example.test`,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query(
    'SELECT workspace_id FROM users WHERE id=$1',
    [user.id]
  ))[0].workspace_id;
  const fx = await reviewConcurrencyFixture(db, {
    workspaceId,
    userId: user.id,
    factual: true
  });
  const nextSnapshotId = randomUUID();
  const nextSegmentId = randomUUID();
  const nextAtomId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,2,$3,'검토 경쟁 원본','가격은 120원입니다.')`, [
      nextSnapshotId,
      fx.sourceItemId,
      stableKey(`snapshot:${nextSnapshotId}`)
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES ($1,$2,'본문 1',1,'paragraph','가격은 120원입니다.')`, [
      nextSegmentId,
      nextSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES ($1,$2,$3,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v2')`, [
      nextAtomId,
      nextSnapshotId,
      nextSegmentId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      fx.sourceItemId,
      nextSnapshotId
    ]);
  });

  let releaseInvalidation;
  const invalidationRelease = new Promise((resolve) => { releaseInvalidation = resolve; });
  let invalidated;
  const invalidationCheckpoint = new Promise((resolve) => { invalidated = resolve; });
  let paused = false;
  const invalidationDb = {
    dialect: db.dialect,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn({
      query: async (text, params = []) => {
        const rows = await tx.query(text, params);
        if (
          !paused
          && text.includes('UPDATE verifications SET invalidated_at')
          && text.includes('연결된 원본 내용이 변경됨')
        ) {
          paused = true;
          invalidated();
          await invalidationRelease;
        }
        return rows;
      }
    }))
  };

  const invalidation = applySourceUpdate(invalidationDb, {
    sourceItemId: fx.sourceItemId,
    oldSnapshotId: fx.snapshotId,
    newSnapshotId: nextSnapshotId
  });
  await invalidationCheckpoint;

  let verificationAttempted;
  const verificationCheckpoint = new Promise((resolve) => { verificationAttempted = resolve; });
  let verificationQuerySeen = false;
  const verificationDb = {
    dialect: db.dialect,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn({
      query: async (text, params = []) => {
        if (!verificationQuerySeen) {
          verificationQuerySeen = true;
          verificationAttempted();
        }
        return tx.query(text, params);
      }
    }))
  };
  let verificationSettled = false;
  const verification = verifyBlock(verificationDb, {
    workspaceId,
    userId: user.id,
    blockId: fx.blockId,
    note: '무효화와 동시에 기록되면 안 됨'
  }).finally(() => { verificationSettled = true; });
  const verificationRejected = assert.rejects(verification, { code: 'VERIFICATION_BLOCKED' });
  try {
    await verificationCheckpoint;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      verificationSettled,
      false,
      'verification must wait while invalidation owns the artifact-first lock'
    );
  } finally {
    releaseInvalidation();
  }

  const impact = await invalidation;
  await verificationRejected;
  assert.deepEqual(impact.affectedBlockIds, [fx.blockId]);
  assert.equal(
    (await db.query(`SELECT count(*)::int AS count
      FROM verifications WHERE artifact_block_id=$1 AND invalidated_at IS NULL`, [
      fx.blockId
    ]))[0].count,
    0
  );
  assert.equal(
    (await db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [fx.blockId]))[0].stale,
    true
  );
});
