import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { chromium } from 'playwright';
import axe from 'axe-core';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { activeChannelCatalog } from '../apps/shared/channels.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { saveModelProvider } from '../apps/shared/intelligence.js';
import { speechUnits } from '../apps/shared/platform-adapters.js';
import { processNextEvent } from '../apps/worker/worker.js';
import { createApp } from '../apps/web/server.js';

const secretKey = Buffer.alloc(32, 5).toString('base64');
const factual = (text, ...atomRefs) => ({ text, kind: 'factual', atomRefs });
const production = (text) => ({ text, kind: 'production', atomRefs: [] });

function handle(prompt, pattern) {
  const atom = (prompt.sourceAtoms || []).find((row) => pattern.test(row.text));
  assert.ok(atom, `browser canary source handle missing: ${pattern}`);
  return atom.handle;
}

function naverDraft(prompt) {
  const price = handle(prompt, /(?:100|120)원/u);
  const delivery = handle(prompt, /배송은 내일/u);
  const currentPrice = prompt.sourceAtoms.find((atom) => atom.handle === price).text.match(/(?:100|120)원/u)?.[0];
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

function youtubeDraft(prompt) {
  const price = handle(prompt, /(?:100|120)원/u);
  const delivery = handle(prompt, /배송은 내일/u);
  return {
    title: factual('가격과 배송 30초 확인', price, delivery),
    hook: factual('가격 100원, 배송 내일. 두 가지만 확인하세요.', price, delivery),
    scenes: [
      {
        durationSeconds: 2,
        narration: factual('가격은 100원입니다.', price),
        onScreenText: factual('가격 100원', price),
        visualDirection: production('가격표를 중앙에 표시'),
        safeZoneNote: production('상단과 우측 UI 영역을 비움')
      },
      {
        durationSeconds: 10,
        narration: factual('공개된 가격 기준은 100원입니다.', price),
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
    ending: factual('가격 100원과 배송 내일을 기준으로 확인하세요.', price, delivery),
    caption: factual('가격 100원 · 배송 내일', price, delivery),
    coverText: factual('가격·배송 확인', price, delivery)
  };
}

function evaluatorResult(prompt) {
  return {
    purposeFit: 'supported',
    purposeReason: '표시된 사실이 연결된 원본 근거 안에 있음',
    allVisibleBlocksReviewed: true,
    blocks: prompt.factualBlocks.map((block) => ({
      blockKey: block.blockKey,
      verdict: 'supported',
      claims: [{
        claim: block.text,
        verdict: 'supported',
        sourceHandles: block.evidence.map((row) => row.handle),
        reason: '해당 블록에 연결된 원본 문장이 직접 뒷받침함'
      }]
    })),
    creatorIdentityClaims: [],
    platformChecks: (prompt.rubric || []).map((row) => ({
      code: row.key,
      passed: true,
      reason: row.criterion,
      affectedBlockKeys: []
    }))
  };
}

function suggestedPlannerSetting(channel, key, schema) {
  const values = {
    purpose: `${channel} 독자가 가격과 배송 기준을 바로 판단하도록 안내`,
    keyword: '가격 배송 기준',
    readingTone: '근거 중심 정보형',
    includeFaq: false,
    angle: '가격과 배송 의사결정 가이드',
    cadence: '업데이트 알림',
    includePreamble: true,
    slideCount: 5,
    visualDirection: '가격표와 배송 일정을 분리한 정보 카드',
    targetSeconds: 30,
    visualStyle: '가격표와 일정표를 빠르게 대비',
    includeCaptions: true
  };
  if (Object.hasOwn(values, key)) return values[key];
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer') return schema.minimum ?? 1;
  return `${channel} ${key} 추천`;
}

function plannerSourceBatchResult(prompt) {
  return {
    sources: prompt.candidates.map((source) => {
      const included = source.atoms.some((atom) => /운영 근거/u.test(atom.text));
      return {
        sourceKey: source.sourceKey,
        include: included,
        relevanceScore: included ? 0.93 : 0.12,
        recommendationReason: included
          ? '운영 시 확인할 근거와 검토 맥락을 보완합니다.'
          : '현재 생성 목적을 직접 보완하는 근거가 부족합니다.',
        sourcePositions: included ? [source.atoms[0].handle] : []
      };
    })
  };
}

function plannerProfilesResult(prompt) {
  const sourceHandles = prompt.sources
    .map((source) => source.atoms[0]?.handle)
    .filter(Boolean);
  assert.ok(sourceHandles.length >= 2, 'planner profile fixture receives primary and supplemental sources');
  return {
    profiles: prompt.profiles.map((profile) => {
      const settings = {};
      const fieldReasons = {};
      const fieldOrigins = {};
      for (const [key, schema] of Object.entries(profile.settingsSchema.properties)) {
        settings[key] = suggestedPlannerSetting(profile.channel, key, schema);
        fieldReasons[key] = `${profile.displayName}의 구조와 원본 목적에 맞춘 값입니다.`;
        fieldOrigins[key] = {
          type: 'source_evidence',
          sourcePositions: [sourceHandles[0]]
        };
      }
      return {
        profileId: profile.profileId,
        settings,
        fieldReasons,
        fieldOrigins,
        recommendationReason: `${profile.displayName}의 고유한 구조와 사용 목적을 반영했습니다.`,
        sourcePositions: sourceHandles,
        missingContext: [],
        expectedEditingEffort: 'low',
        effortReason: '주원본과 선택 가능한 보조 원본에 필요한 근거가 있습니다.'
      };
    })
  };
}

function browserCanary() {
  const modelTasks = [];
  const wordpressRequests = [];
  const state = {
    priceText: '가격은 100원입니다.',
    feedFailures: 0,
    modelFailures: 0,
    wordpressPost: null
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/feed.xml') {
      if (state.feedFailures > 0) {
        state.feedFailures -= 1;
        response.statusCode = 503;
        response.end('temporary feed failure');
        return;
      }
      response.setHeader('content-type', 'application/rss+xml');
      response.end(`<rss xmlns:content="urn:test"><channel><item>
        <guid>browser-source</guid><title>가격과 배송</title>
        <link>https://example.test/browser-source</link>
        <content:encoded><![CDATA[<p>${state.priceText}</p><p>배송은 내일입니다.</p>]]></content:encoded>
      </item></channel></rss>`);
      return;
    }
    if (request.url?.startsWith('/oembed?')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        title: '공식 metadata 영상',
        author_name: '공식 채널',
        author_url: 'https://www.youtube.com/@official',
        provider_name: 'YouTube',
        provider_url: 'https://www.youtube.com/',
        type: 'video'
      }));
      return;
    }
    if (request.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (state.modelFailures > 0) {
        state.modelFailures -= 1;
        response.statusCode = 400;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { message: 'temporary model failure' } }));
        return;
      }
      const rawPrompt = payload.messages.at(-1).content;
      const [jsonPrompt] = rawPrompt.split(/\n\n(?=SCHEMA_REPAIR|JSON_CONTRACT_REPAIR)/u);
      const prompt = JSON.parse(jsonPrompt);
      modelTasks.push(prompt.task || prompt.contract);
      let output;
      if (prompt.contract === 'planner_suggestion_source_batch.v1') {
        output = plannerSourceBatchResult(prompt);
      } else if (prompt.contract === 'planner_suggestion_profiles.v1') {
        output = plannerProfilesResult(prompt);
      } else if (prompt.task === 'EVIDENCE_PLAN') {
        output = {
          readiness: 'complete',
          supportedPurpose: prompt.requestedPurpose,
          reasons: ['가격과 배송 문장이 목적을 지원함'],
          missingInformation: [],
          selectedSourceHandles: prompt.sourceAtoms.map((atom) => atom.handle),
          contentBudget: { maximumClaims: 2, rationale: '원본의 두 사실만 사용' }
        };
      } else if (prompt.task === 'PLATFORM_DRAFT' && prompt.profile.channel === 'naver_blog') {
        output = naverDraft(prompt);
      } else if (prompt.task === 'PLATFORM_DRAFT' && prompt.profile.channel === 'youtube_shorts') {
        output = youtubeDraft(prompt);
      } else if (prompt.task === 'STRICT_CLAIM_EVALUATION') {
        output = evaluatorResult(prompt);
      } else if (prompt.task === 'PATCH_ONLY') {
        const price = handle(prompt, /120원/u);
        output = {
          blocks: prompt.blocksToPatch.map((block) => ({
            key: block.key,
            text: `${block.key} · 최신 가격 120원`,
            kind: block.kind,
            atomRefs: block.kind === 'factual' ? [price] : []
          }))
        };
      } else {
        response.statusCode = 422;
        response.end(JSON.stringify({ error: `unexpected model task ${prompt.task}` }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        model: 'solar-open2-browser-canary',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      }));
      return;
    }
    if (request.url?.startsWith('/wp/wp-json/wp/v2/posts?')) {
      wordpressRequests.push({ method: request.method, url: request.url });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(state.wordpressPost ? [state.wordpressPost] : []));
      return;
    }
    if (request.url === '/wp/wp-json/wp/v2/posts' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      wordpressRequests.push({ method: request.method, url: request.url, payload });
      state.wordpressPost = { id: 501, status: 'draft', slug: payload.slug };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(state.wordpressPost));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return { server, modelTasks, wordpressRequests, state };
}

const TIKTOK_DENSITY_SOURCE = Object.freeze([
  '가격은 100원 공식 안내 기준을 먼저 확인하고 같은 날짜에 공개된 필수 구성품과 적용 조건과 제외 범위와 변경 고지를 차례대로 비교해야 불필요한 오해를 줄일 수 있으며 최종 선택 전에는 원본 안내를 다시 확인해야 합니다',
  '배송은 내일 공식 일정 기준으로 안내되지만 주문 시각과 접수 상태와 지역별 처리 순서와 공휴일 여부와 수령 가능 시간과 변경 공지를 함께 살펴야 하며 실제 신청 전에는 현재 원본 일정과 적용 범위를 다시 확인해야 합니다',
  '변경 사항은 원본에서 확인하고 표시된 가격과 배송 일정과 포함 구성과 제외 조건과 적용 시점과 추가 안내와 문의 경로를 순서대로 대조한 뒤 현재 시점에 유효한 내용인지 다시 검토하고 신청 직전에도 최신 공지와 예외 조건을 확인해야 합니다'
]);

function overfullTikTokDraft(prompt) {
  const atoms = TIKTOK_DENSITY_SOURCE.map((expected) => {
    const atom = (prompt.sourceAtoms || []).find((row) => row.text === expected);
    assert.ok(atom, `TikTok density source atom missing: ${expected.slice(0, 20)}`);
    return atom;
  });
  const handles = [...new Set(atoms.map((atom) => atom.handle))];
  const sharedSurface = factual(
    '공식 가격과 배송과 변경 기준을 현재 원본에서 함께 확인하는 구체적인 방법',
    ...handles
  );
  assert.ok(speechUnits(sharedSurface.text) > 18, 'hook fallback surfaces remain above the first-scene budget');
  const scenes = atoms.map((atom, index) => ({
    durationSeconds: [3, 14, 13][index],
    narration: factual(atom.text, atom.handle),
    onScreenText: factual(
      ['공식 가격 기준과 적용 조건을 원본에서 함께 확인하세요',
        '공식 배송 일정과 적용 범위를 원본에서 함께 확인하세요',
        '현재 변경 사항과 적용 시점을 원본에서 함께 확인하세요'][index],
      atom.handle
    ),
    visualDirection: production(`${index + 1}번째 원본 근거 카드를 세로 화면 중앙에 표시`),
    safeZoneNote: production('상단 제목과 우측 버튼과 하단 자막 안전 영역을 비움')
  }));
  assert.deepEqual(
    scenes.map((scene) => speechUnits(scene.narration.text) > scene.durationSeconds * 6),
    [true, true, true],
    'fixture draft deliberately exceeds all three server-owned narration budgets'
  );
  assert.ok(
    scenes.every((scene) => speechUnits(scene.onScreenText.text) > 18),
    'on-screen text cannot silently replace the overfull first narration'
  );
  return {
    title: structuredClone(sharedSurface),
    hook: structuredClone(sharedSurface),
    scenes,
    ending: structuredClone(sharedSurface),
    caption: structuredClone(sharedSurface),
    coverText: structuredClone(sharedSurface)
  };
}

function certifiedNarrationSelections(prompt) {
  const plan = prompt.narrationRepairPlan;
  assert.equal(plan?.contractVersion, 'server-certified-narration.v1');
  assert.equal(plan.slots.length, 3);
  const used = new Set();
  return plan.slots.map((slot, index) => {
    assert.equal(slot.path, `$.scenes[${index}].narration`);
    assert.equal(slot.textPath, `$.scenes[${index}].narration.text`);
    assert.ok(Array.isArray(slot.candidates) && slot.candidates.length > 0);
    const candidate = slot.candidates.find((row) => (
      typeof row?.candidateId === 'string' && !used.has(row.candidateId)
    ));
    assert.ok(candidate, `slot ${index + 1} has a distinct certified candidate`);
    assert.ok(Number.isInteger(candidate.speechUnits) && candidate.speechUnits > 0);
    assert.ok(candidate.speechUnits <= slot.maximumSpeechUnits);
    assert.ok(Array.isArray(candidate.atomRefs) && candidate.atomRefs.length > 0);
    used.add(candidate.candidateId);
    return { path: slot.path, candidateId: candidate.candidateId };
  });
}

function tiktokDensityCanary() {
  const state = {
    modelTasks: [],
    drafts: [],
    repairPlans: [],
    repairResponses: []
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(`<rss xmlns:content="urn:test"><channel><item>
        <guid>tiktok-density-source</guid><title>TikTok 발화 밀도 원본</title>
        <link>https://example.test/tiktok-density-source</link>
        <content:encoded><![CDATA[
          ${TIKTOK_DENSITY_SOURCE.map((text) => `<p>${text}</p>`).join('')}
        ]]></content:encoded>
      </item></channel></rss>`);
      return;
    }
    if (request.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const rawPrompt = payload.messages.at(-1).content;
      const [jsonPrompt] = rawPrompt.split(/\n\n(?=SCHEMA_REPAIR|JSON_CONTRACT_REPAIR)/u);
      const prompt = JSON.parse(jsonPrompt);
      state.modelTasks.push(prompt.task || prompt.contract);
      let output;
      if (prompt.task === 'EVIDENCE_PLAN') {
        output = {
          readiness: 'complete',
          supportedPurpose: prompt.requestedPurpose,
          reasons: ['가격·배송·변경 기준의 원본 문장이 영상 목적을 직접 지원함'],
          missingInformation: [],
          selectedSourceHandles: prompt.sourceAtoms.map((atom) => atom.handle),
          contentBudget: {
            maximumClaims: 3,
            rationale: '세 장면에 서로 다른 원본 근거를 하나씩 사용'
          }
        };
      } else if (prompt.task === 'PLATFORM_DRAFT' && prompt.profile.channel === 'tiktok_video') {
        output = overfullTikTokDraft(prompt);
        state.drafts.push(structuredClone(output));
      } else if (prompt.task === 'PLATFORM_DRAFT_SCHEMA_REPAIR') {
        state.repairPlans.push(structuredClone(prompt.narrationRepairPlan));
        if (state.repairPlans.length === 1) {
          // Extra legacy content reproduces a pre-contract Provider response.
          // It must be persisted as a terminal failure instead of being
          // silently accepted beside the certified-ID selection contract.
          output = {
            selections: [],
            legacyRepair: true
          };
        } else {
          output = { selections: certifiedNarrationSelections(prompt) };
        }
        state.repairResponses.push(structuredClone(output));
      } else if (prompt.task === 'STRICT_CLAIM_EVALUATION') {
        output = evaluatorResult(prompt);
      } else {
        response.statusCode = 422;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: `unexpected TikTok density task ${prompt.task}` }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        model: 'solar-open2-tiktok-density-canary',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 }
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return { server, state };
}

async function expectJob(db, config, eventType) {
  const job = await processNextEvent(db, config);
  assert.ok(job);
  assert.equal(job.eventType, eventType);
  assert.equal(job.error, undefined, job.error?.stack || job.error?.message);
}

async function waitForDatabase(check, message, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function axeViolations(page, selector = null) {
  // Playwright's evaluation world keeps the production CSP intact; no inline
  // script element or product-side CSP exception is introduced for the scan.
  await page.evaluate(axe.source);
  return page.evaluate(async (targetSelector) => (await axe.run(
    targetSelector ? document.querySelector(targetSelector) : document,
    {
    rules: { 'color-contrast': { enabled: true } }
    }
  )).violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length
  })), selector);
}

async function waitForGenerationRunUrl(page, origin, previousRunId = null) {
  await page.waitForURL((url) => (
    url.origin === origin
    && url.pathname === '/app/runs'
    && Boolean(url.searchParams.get('run'))
    && (!previousRunId || url.searchParams.get('run') !== previousRunId)
  ));
  const runId = new URL(page.url()).searchParams.get('run');
  assert.ok(runId, '생성 실행 화면에는 영속 run 식별자가 있어야 합니다.');
  return runId;
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('Planner explicitly recommends persisted settings from workspace sources without selecting or creating unrequested channels', {
  timeout: 120_000
}, async (t) => {
  let canary;
  let db;
  let appServer;
  let browser;
  let context;
  t.after(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await closeServer(appServer);
    await closeServer(canary?.server);
    await db?.close();
  });

  canary = browserCanary();
  await new Promise((resolve) => canary.server.listen(0, '127.0.0.1', resolve));
  const canaryBase = `http://127.0.0.1:${canary.server.address().port}`;

  db = createPgliteDatabase(new PGlite());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: 'planner-browser@example.test',
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  await saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'Solar Open2 planner browser canary',
    providerType: 'solar',
    baseUrl: `${canaryBase}/v1`,
    model: 'solar-open2',
    apiKey: 'test-only',
    isDefault: true,
    environment: 'test',
    secretKey,
    testMode: true,
    allowInsecureCredentialTransport: true
  });

  const config = {
    environment: 'test',
    testMode: true,
    secretKey,
    authDisabled: true,
    internalNetworkMode: true,
    plannerSuggestionBatchSize: 10,
    plannerSuggestionSourceCharBudget: 4_000,
    plannerSuggestionMaxSupplementalSources: 8,
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  };
  const app = createApp({ db, config });
  appServer = await new Promise((resolve) => {
    const listener = app.listen(0, '0.0.0.0', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${appServer.address().port}`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined
    });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/app/inbox`);

  await page.getByRole('button', { name: '전사 업로드' }).click();
  await page.locator('#transcript-dialog').getByLabel('연결 이름').fill('운영 보조 전사');
  await page.getByLabel('전사 제목').fill('운영 검토 근거');
  await page.getByLabel('또는 전사 내용').fill(
    '첫 번째 운영 근거는 가격과 배송 정보를 함께 확인하는 것입니다.\n\n두 번째 운영 근거는 생성 전에 누락 범위를 확인하는 것입니다.'
  );
  await page.locator('#transcript-dialog').getByLabel('사용 권리').selectOption('owned');
  const transcriptNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '연결 추가' }).click();
  await transcriptNavigation;
  await expectJob(db, config, 'ingest_transcript');
  const supplemental = (await db.query(`SELECT item.id AS source_item_id,
      item.latest_snapshot_id AS snapshot_id
    FROM source_items item
    JOIN sources source ON source.id=item.source_id
    WHERE source.workspace_id=$1 AND source.name='운영 보조 전사'`, [workspaceId]))[0];
  assert.ok(supplemental?.snapshot_id);
  await db.query(`UPDATE source_snapshot_assessments
    SET readiness='partial',
      omissions=$2::jsonb,
      acknowledgement_required=true
    WHERE snapshot_id=$1`, [
    supplemental.snapshot_id,
    JSON.stringify(['전사 밖의 시각 자료와 최신 변경 내역은 포함되지 않음'])
  ]);

  await page.getByRole('button', { name: 'RSS 원본 연결' }).click();
  await page.locator('#source-dialog').getByLabel('연결 이름').fill('Planner 주원본 RSS');
  await page.getByLabel('RSS 주소').fill(`${canaryBase}/feed.xml`);
  await page.locator('#source-dialog').getByLabel('사용 권리').selectOption('owned');
  const rssNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '연결 추가' }).click();
  await rssNavigation;
  await expectJob(db, config, 'sync_rss');
  await page.reload();
  const primaryRow = page.getByRole('row').filter({ hasText: '가격과 배송' });
  await primaryRow.getByRole('link', { name: '계획 만들기' }).click();
  await page.waitForURL(/\/app\/planner\//u);

  const catalog = await activeChannelCatalog(db, workspaceId);
  const expectedSettingCount = catalog.reduce(
    (count, profile) => count + Object.keys(profile.profile.settingsSchema.properties).length,
    0
  );
  const channelSelections = page.locator(
    'fieldset[data-platform-profile] input[name^="channel_"][name$="_selected"]'
  );
  assert.equal(await channelSelections.count(), catalog.length);
  assert.equal(await page.locator(
    'fieldset[data-platform-profile] input[name^="channel_"][name$="_selected"]:checked'
  ).count(), 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM plans'))[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM plan_outputs'))[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM artifacts'))[0].count, 0);

  const suggestionRequest = page.waitForResponse((response) => (
    response.url().endsWith('/api/planner-suggestions')
      && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '내 소스로 기본값 추천' }).click();
  const suggestionResponse = await suggestionRequest;
  assert.equal(suggestionResponse.status(), 200);
  const suggestion = await suggestionResponse.json();
  assert.ok(suggestion.suggestionRunId);
  await expectJob(db, config, 'prepare_planner_suggestion');
  const batches = await db.query(`SELECT id FROM planner_suggestion_batches
    WHERE suggestion_run_id=$1 ORDER BY ordinal`, [suggestion.suggestionRunId]);
  assert.equal(batches.length, 1);
  for (const _batch of batches) {
    await expectJob(db, config, 'analyze_planner_suggestion_batch');
  }
  await expectJob(db, config, 'finalize_planner_suggestion');
  await page.getByText(
    '자동 분석이 완료되었습니다. 입력값과 보조 원본을 확인하세요.',
    { exact: true }
  ).waitFor();

  assert.equal(await page.locator(
    'fieldset[data-platform-profile] input[name^="channel_"][name$="_selected"]:checked'
  ).count(), 0, 'recommendations never opt channels into persistence');
  const appliedSettings = page.locator('[data-setting-key][data-suggestion-applied="true"]');
  assert.equal(await appliedSettings.count(), expectedSettingCount);
  assert.equal(await page.locator('[data-setting-key]:not([data-suggestion-applied="true"])').count(), 0);
  for (const profile of catalog) {
    for (const [key, schema] of Object.entries(profile.profile.settingsSchema.properties)) {
      const control = page.locator(
        `fieldset[data-platform-profile="${profile.id}"] [data-setting-key="${key}"]`
      );
      assert.equal(await control.count(), 1, `${profile.channel}.${key} is rendered`);
      const expected = suggestedPlannerSetting(profile.channel, key, schema);
      if (schema.type === 'boolean') assert.equal(await control.isChecked(), expected);
      else assert.equal(await control.inputValue(), String(expected));
      assert.equal(await control.isDisabled(), true, `${profile.channel}.${key} remains inactive until selected`);
    }
    const metadata = page.locator(
      `fieldset[data-platform-profile="${profile.id}"] [data-suggestion-meta]`
    );
    assert.equal(await metadata.isVisible(), true);
    assert.match(await metadata.innerText(), /추천 이유/u);
    assert.match(await metadata.innerText(), /원본 범위/u);
    assert.match(await metadata.innerText(), /예상 편집량/u);
  }

  const supplementalChoice = page.locator('input[name="supplementalSnapshotIds"]');
  assert.equal(await supplementalChoice.count(), 1);
  assert.equal(await supplementalChoice.isChecked(), true);
  assert.equal(await supplementalChoice.inputValue(), supplemental.snapshot_id);
  assert.match(await supplementalChoice.locator('xpath=..').innerText(), /운영 보조 전사/u);
  assert.match(await supplementalChoice.locator('xpath=..').innerText(), /참조 범위/u);
  const supplementalAcknowledgement = page.locator(
    'input[name="supplementalReadinessAcknowledged"]'
  );
  assert.equal(await supplementalAcknowledgement.isVisible(), true);
  assert.equal(await supplementalAcknowledgement.isChecked(), false);
  await supplementalAcknowledgement.check();
  assert.equal((await db.query('SELECT count(*)::int AS count FROM plans'))[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM plan_outputs'))[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM artifacts'))[0].count, 0);

  await page.getByRole('checkbox', { name: 'Naver Blog Draft' }).check();
  assert.equal(await page.locator(
    'fieldset[data-platform-profile] input[name^="channel_"][name$="_selected"]:checked'
  ).count(), 1);
  const planRequest = page.waitForResponse((response) => (
    response.url().endsWith('/api/plans') && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '선택한 결과물 생성' }).click();
  const planResponse = await planRequest;
  assert.equal(planResponse.status(), 200);
  const plannedRunId = await waitForGenerationRunUrl(page, origin);
  await page.getByRole('heading', { name: '이번 생성' }).waitFor();
  assert.match(await page.locator('#current-generation').innerText(), /실제 Provider가 생성/u);

  const outputs = await db.query(`SELECT output.*,definition.channel
    FROM plan_outputs output
    JOIN channel_definition_versions definition
      ON definition.id=output.channel_definition_version_id`);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].channel, 'naver_blog');
  assert.equal(outputs[0].settings_origin, 'automatic_suggestion');
  assert.deepEqual(
    outputs[0].settings,
    Object.fromEntries(Object.entries(
      catalog.find((profile) => profile.channel === 'naver_blog').profile.settingsSchema.properties
    ).map(([key, schema]) => [key, suggestedPlannerSetting('naver_blog', key, schema)]))
  );
  assert.equal((await db.query('SELECT count(*)::int AS count FROM artifacts'))[0].count, 0);
  const planId = outputs[0].plan_id;
  assert.equal((await db.query(`SELECT id FROM runs
    WHERE plan_id=$1 AND run_type='artifact_generation'`, [planId]))[0].id, plannedRunId);
  assert.equal((await db.query(`SELECT count(*)::int AS count
    FROM plan_source_snapshots WHERE plan_id=$1`, [planId]))[0].count, 2);
  assert.ok(Number((await db.query(`SELECT count(*)::int AS count
    FROM plan_source_seed_atoms WHERE plan_id=$1`, [planId]))[0].count) > 0);

  await expectJob(db, config, 'generate_plan_output');
  await page.reload();
  assert.match(await page.locator('#current-generation').innerText(), /자동 검사 완료 · 사람 확인 필요/u);
  assert.doesNotMatch(await page.locator('#current-generation').innerText(), /저장된 결과물 연결/u);
  assert.equal(await page.getByRole('link', { name: 'Review Workbench에서 검토 시작' }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'Review Workbench 열기' }).count(), 1);
  const artifacts = await db.query('SELECT id,channel FROM artifacts');
  assert.deepEqual(artifacts.map((artifact) => artifact.channel), ['naver_blog']);
  assert.equal((await db.query(`SELECT count(*)::int AS count
    FROM artifact_version_source_snapshots version_source
    JOIN artifacts artifact ON artifact.current_version_id=version_source.artifact_version_id
    WHERE artifact.id=$1`, [artifacts[0].id]))[0].count, 2);
  assert.deepEqual(
    [...new Set(canary.modelTasks)].sort(),
    [
      'EVIDENCE_PLAN',
      'PLATFORM_DRAFT',
      'STRICT_CLAIM_EVALUATION',
      'planner_suggestion_profiles.v1',
      'planner_suggestion_source_batch.v1'
    ].sort()
  );
});

test('a TikTok density failure is preserved while a browser-selected Provider retry uses certified narration candidates and opens Review Workbench', {
  timeout: 120_000
}, async (t) => {
  let canary;
  let db;
  let appServer;
  let browser;
  let context;
  t.after(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await closeServer(appServer);
    await closeServer(canary?.server);
    await db?.close();
  });

  canary = tiktokDensityCanary();
  await new Promise((resolve) => canary.server.listen(0, '127.0.0.1', resolve));
  const canaryBase = `http://127.0.0.1:${canary.server.address().port}`;

  db = createPgliteDatabase(new PGlite());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: 'tiktok-density-browser@example.test',
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query(
    'SELECT workspace_id FROM users WHERE id=$1',
    [user.id]
  ))[0].workspace_id;
  const providerId = await saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'Solar Open2 TikTok density canary',
    providerType: 'solar',
    baseUrl: `${canaryBase}/v1`,
    model: 'solar-open2',
    apiKey: 'test-only',
    isDefault: true,
    environment: 'test',
    secretKey,
    testMode: true,
    allowInsecureCredentialTransport: true
  });
  const config = {
    environment: 'test',
    testMode: true,
    secretKey,
    authDisabled: true,
    internalNetworkMode: true,
    network: {
      allowPrivateNetworks: true,
      allowInsecureCredentialTransport: true
    }
  };
  const app = createApp({ db, config });
  appServer = await new Promise((resolve) => {
    const listener = app.listen(0, '0.0.0.0', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${appServer.address().port}`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}/app/inbox`);

  await page.getByRole('button', { name: 'RSS 원본 연결' }).click();
  await page.locator('#source-dialog').getByLabel('연결 이름').fill('TikTok 밀도 E2E 원본');
  await page.getByLabel('RSS 주소').fill(`${canaryBase}/feed.xml`);
  await page.locator('#source-dialog').getByLabel('사용 권리').selectOption('owned');
  const rssNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '연결 추가' }).click();
  await rssNavigation;
  await expectJob(db, config, 'sync_rss');
  await page.reload();

  const sourceRow = page.getByRole('row').filter({ hasText: 'TikTok 발화 밀도 원본' });
  await sourceRow.getByRole('link', { name: '계획 만들기' }).click();
  await page.waitForURL(/\/app\/planner\//u);
  await page.getByRole('checkbox', { name: 'TikTok Video' }).check();
  await page.locator('input[name="channel_tiktok_video_purpose"]')
    .fill('가격과 배송과 변경 기준을 30초 TikTok 영상으로 안내');
  await page.locator('input[name="channel_tiktok_video_targetSeconds"]').fill('30');
  await page.locator('input[name="channel_tiktok_video_visualStyle"]')
    .fill('원본 근거 카드');
  await page.locator('select[name="providerId"]').selectOption(providerId);
  await page.locator('select[name="evaluatorProviderId"]').selectOption(providerId);
  assert.equal(await page.locator(
    'fieldset[data-platform-profile] input[name^="channel_"][name$="_selected"]:checked'
  ).count(), 1);

  const planRequest = page.waitForResponse((response) => (
    response.url().endsWith('/api/plans') && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '선택한 결과물 생성' }).click();
  const plannedResponse = await planRequest;
  assert.equal(plannedResponse.status(), 200);
  const plannedRunId = await waitForGenerationRunUrl(page, origin);
  assert.equal(await page.getByRole('heading', { name: '이번 생성' }).count(), 1);

  const output = (await db.query(`SELECT output.id,output.plan_id,output.output_type,output.status
    FROM plan_outputs output`))[0];
  assert.equal(output.output_type, 'tiktok_video');
  assert.equal(output.status, 'queued');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM plan_outputs'))[0].count, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM artifacts'))[0].count, 0);

  const failedJob = await processNextEvent(db, config);
  assert.equal(failedJob.eventType, 'generate_plan_output');
  assert.ok(failedJob.error, 'a density repair response outside the certified selection contract must fail closed');
  assert.equal(failedJob.error.code, 'QUALITY_REPAIR_SCOPE_VIOLATION');
  assert.equal(failedJob.retry, false);
  assert.equal(canary.state.drafts.length, 1);
  assert.equal(canary.state.repairPlans.length, 1);
  assert.ok(canary.state.repairPlans[0].slots.length === 3);
  assert.ok(canary.state.repairPlans[0].slots.every((slot) => slot.candidates.length > 0));
  assert.deepEqual(canary.state.repairResponses[0], {
    selections: [],
    legacyRepair: true
  });

  const failedRun = (await db.query(`SELECT id,run_type,status,error_message,
      started_at::text,completed_at::text
    FROM runs WHERE plan_id=$1 AND run_type='artifact_generation'`, [output.plan_id]))[0];
  assert.equal(failedRun.id, plannedRunId);
  assert.equal(failedRun.status, 'failed');
  const failedExecution = (await db.query(`SELECT id,run_id,status,stage,error_code,error_message,
      accepted_attempt_no,artifact_version_id,completed_at::text
    FROM generation_executions WHERE run_id=$1`, [failedRun.id]))[0];
  assert.equal(failedExecution.status, 'failed');
  assert.equal(failedExecution.artifact_version_id, null);
  const failedAttempts = await db.query(`SELECT id,execution_id,attempt_no,attempt_kind,status,
      error_code,error_message,schema_result,completed_at::text
    FROM generation_attempts WHERE execution_id=$1 ORDER BY attempt_no`, [failedExecution.id]);
  assert.equal(failedAttempts.length, 2);
  assert.deepEqual(failedAttempts.map((attempt) => attempt.status), ['schema_failed', 'schema_failed']);
  const failedOutbox = (await db.query(`SELECT id,event_type,status,attempts,last_error
    FROM outbox_events WHERE payload->>'runId'=$1`, [failedRun.id]))[0];
  assert.equal(failedOutbox.status, 'failed');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM artifact_versions'))[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM artifact_blocks'))[0].count, 0);

  await page.reload();
  assert.match(await page.locator('#current-generation').innerText(), /생성에 실패했습니다/u);
  const failedOutputRow = page.getByRole('row').filter({ hasText: 'TikTok Video' }).last();
  assert.equal(
    await failedOutputRow.getByLabel('재시도 생성 Provider').inputValue(),
    providerId
  );
  await failedOutputRow.getByLabel('재시도 생성 Provider').selectOption(providerId);
  await failedOutputRow.getByLabel('재시도 평가 Provider').selectOption(providerId);

  const retryRequest = page.waitForResponse((response) => (
    /\/api\/plan-outputs\/[^/]+\/retry$/u.test(response.url())
      && response.request().method() === 'POST'
  ));
  await failedOutputRow.getByRole('button', { name: '실패한 결과물 다시 생성' }).click();
  const retryResponse = await retryRequest;
  assert.equal(retryResponse.status(), 200);
  const retryRunId = await waitForGenerationRunUrl(page, origin, plannedRunId);
  await page.getByRole('heading', { name: '재시도 생성 결과' }).waitFor();

  const retryRun = (await db.query(`SELECT id,run_type,status,error_message
    FROM runs WHERE plan_id=$1 AND run_type='artifact_generation_retry'`, [output.plan_id]))[0];
  assert.ok(retryRun.id && retryRun.id !== failedRun.id);
  assert.equal(retryRun.id, retryRunId);
  assert.equal(retryRun.status, 'queued');
  assert.equal((await db.query(`SELECT count(*)::int AS count
    FROM run_source_snapshots WHERE run_id=$1`, [retryRun.id]))[0].count, 1);
  assert.deepEqual(
    (await db.query(`SELECT id,run_type,status,error_message,started_at::text,completed_at::text
      FROM runs WHERE id=$1`, [failedRun.id]))[0],
    failedRun,
    'enqueueing a retry does not rewrite the failed run'
  );

  await expectJob(db, config, 'generate_plan_output');
  assert.equal(canary.state.drafts.length, 2);
  assert.equal(canary.state.repairPlans.length, 2);
  assert.ok(Array.isArray(canary.state.repairResponses[1].selections));
  assert.equal(canary.state.repairResponses[1].selections.length, 3);
  assert.equal(new Set(
    canary.state.repairResponses[1].selections.map((selection) => selection.candidateId)
  ).size, 3);

  const completedRetryRun = (await db.query(`SELECT id,run_type,status,error_message
    FROM runs WHERE id=$1`, [retryRun.id]))[0];
  assert.equal(completedRetryRun.status, 'succeeded');
  const completedOutput = (await db.query(`SELECT id,status,quality_status,artifact_id
    FROM plan_outputs WHERE id=$1`, [output.id]))[0];
  assert.equal(completedOutput.status, 'succeeded');
  assert.equal(completedOutput.quality_status, 'passed');
  assert.ok(completedOutput.artifact_id);

  const artifacts = await db.query('SELECT id,channel,state,current_version_id FROM artifacts');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].channel, 'tiktok_video');
  assert.equal(artifacts[0].state, 'review_required');
  const artifactVersion = (await db.query(`SELECT content,generation_attempt_id
    FROM artifact_versions WHERE id=$1`, [artifacts[0].current_version_id]))[0];
  assert.equal(artifactVersion.content.type, 'tiktok_video_timeline_preview');
  assert.deepEqual(
    artifactVersion.content.scenes.map((scene) => scene.durationSeconds),
    [3, 14, 13]
  );
  assert.equal(artifactVersion.content.totalSeconds, 30);
  assert.ok(artifactVersion.content.scenes.every((scene) => (
    speechUnits(scene.narration) > 0
      && speechUnits(scene.narration) <= scene.durationSeconds * 6
  )));

  const retryExecution = (await db.query(`SELECT id,status,accepted_attempt_no,artifact_version_id
    FROM generation_executions WHERE run_id=$1`, [retryRun.id]))[0];
  assert.equal(retryExecution.status, 'succeeded');
  assert.equal(Number(retryExecution.accepted_attempt_no), 2);
  assert.equal(retryExecution.artifact_version_id, artifacts[0].current_version_id);
  const retryAttempts = await db.query(`SELECT attempt_no,attempt_kind,status,schema_result
    FROM generation_attempts WHERE execution_id=$1 ORDER BY attempt_no`, [retryExecution.id]);
  assert.deepEqual(
    retryAttempts.map((attempt) => [Number(attempt.attempt_no), attempt.attempt_kind, attempt.status]),
    [[1, 'draft', 'schema_failed'], [2, 'schema_repair', 'accepted']]
  );
  assert.equal(retryAttempts[1].schema_result.passed, true);
  assert.equal(
    retryAttempts[1].schema_result.repairDiagnostics[0].contractVersion,
    'server-certified-narration.v1'
  );
  assert.equal(retryAttempts[1].schema_result.repairDiagnostics[0].slots.length, 3);
  assert.ok(retryAttempts[1].schema_result.repairDiagnostics[0].slots.every((slot) => (
    slot.origin === 'provider_selected'
      && slot.speechUnits > 0
      && slot.speechUnits <= slot.maximumSpeechUnits
  )));

  const narrationBlocks = await db.query(`SELECT block.id,block.content,block.auto_check,
      count(ref.content_atom_id)::int AS ref_count
    FROM artifact_blocks block
    JOIN block_source_refs ref ON ref.artifact_block_id=block.id
    WHERE block.artifact_version_id=$1 AND block.block_type='narration'
    GROUP BY block.id,block.content,block.auto_check
    ORDER BY block.ordinal`, [artifacts[0].current_version_id]);
  assert.equal(narrationBlocks.length, 3);
  assert.ok(narrationBlocks.every((block) => Number(block.ref_count) >= 1));
  assert.ok(narrationBlocks.every((block) => block.auto_check.automaticOnly === true));
  assert.ok(narrationBlocks.every((block) => block.auto_check.humanVerified === false));
  const evaluations = await db.query(`SELECT assurance,status,summary
    FROM quality_evaluation_runs WHERE execution_id=$1`, [retryExecution.id]);
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].assurance, 'LOW_ASSURANCE');
  assert.equal(evaluations[0].status, 'passed');
  assert.equal(evaluations[0].summary.automaticOnly, true);
  assert.equal(evaluations[0].summary.humanVerified, false);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM verifications'))[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM approvals'))[0].count, 0);

  assert.deepEqual(
    (await db.query(`SELECT id,run_type,status,error_message,started_at::text,completed_at::text
      FROM runs WHERE id=$1`, [failedRun.id]))[0],
    failedRun,
    'successful retry leaves the original run immutable'
  );
  assert.deepEqual(
    (await db.query(`SELECT id,run_id,status,stage,error_code,error_message,
        accepted_attempt_no,artifact_version_id,completed_at::text
      FROM generation_executions WHERE id=$1`, [failedExecution.id]))[0],
    failedExecution,
    'successful retry leaves the original execution immutable'
  );
  assert.deepEqual(
    await db.query(`SELECT id,execution_id,attempt_no,attempt_kind,status,
        error_code,error_message,schema_result,completed_at::text
      FROM generation_attempts WHERE execution_id=$1 ORDER BY attempt_no`, [failedExecution.id]),
    failedAttempts,
    'successful retry leaves all original generation attempts immutable'
  );
  assert.deepEqual(
    (await db.query(`SELECT id,event_type,status,attempts,last_error
      FROM outbox_events WHERE id=$1`, [failedOutbox.id]))[0],
    failedOutbox,
    'successful retry leaves the original failed outbox event immutable'
  );

  await page.reload();
  assert.match(await page.locator('#current-generation').innerText(), /자동 검사 완료 · 사람 확인 필요/u);
  assert.doesNotMatch(await page.locator('#current-generation').innerText(), /저장된 결과물 연결/u);
  assert.equal(await page.getByRole('link', { name: 'Review Workbench에서 검토 시작' }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'Review Workbench 열기' }).count(), 1);
  await page.getByRole('link', { name: 'Review Workbench에서 검토 시작' }).click();
  await page.getByText('TikTok For You·댓글 대화 초안 · 9:16', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Review Workbench' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '승인' }).isDisabled(), true);
  assert.match(await page.locator('#approval-blockers').innerText(), /현재 원본 스냅샷과 직접 비교하지 않은 사실 블록/u);
  assert.match(
    await page.locator('.automatic-summary,.review-boundary').allTextContents()
      .then((values) => values.join(' ')),
    /자동.*사람|사람.*자동/u
  );
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    new RegExp(artifacts[0].id, 'u'),
    'internal artifact IDs are not rendered in the recovery UI'
  );
});

test('an internal-network operator completes ingestion, generation, review, approval, draft export, freshness, and recovery without login', {
  timeout: 120_000
}, async (t) => {
  let canary;
  let db;
  let appServer;
  let browser;
  let context;
  t.after(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await closeServer(appServer);
    await closeServer(canary?.server);
    await db?.close();
  });

  canary = browserCanary();
  await new Promise((resolve) => canary.server.listen(0, '127.0.0.1', resolve));
  const canaryBase = `http://127.0.0.1:${canary.server.address().port}`;

  db = createPgliteDatabase(new PGlite());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: 'operator@example.test',
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  await saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'Solar Open2 browser canary',
    providerType: 'solar',
    baseUrl: `${canaryBase}/v1`,
    model: 'solar-open2',
    apiKey: 'test-only',
    isDefault: true,
    environment: 'test',
    secretKey,
    testMode: true,
    allowInsecureCredentialTransport: true
  });

  const config = {
    environment: 'test',
    testMode: true,
    secretKey,
    authDisabled: true,
    internalNetworkMode: true,
    youtubeOembedBaseUrl: `${canaryBase}/oembed`,
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  };
  const app = createApp({ db, config });
  appServer = await new Promise((resolve) => {
    const listener = app.listen(0, '0.0.0.0', () => resolve(listener));
  });
  assert.equal(appServer.address().address, '0.0.0.0');
  const origin = `http://127.0.0.1:${appServer.address().port}`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${origin}/login`);
  await page.waitForURL(`${origin}/app/inbox`);
  assert.equal(await page.getByRole('heading', { name: '원본 인박스' }).count(), 1);
  assert.equal(await page.getByText('내부 네트워크 운영 모드', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '로그인' }).count(), 0);
  assert.equal(await page.getByText('로그아웃', { exact: true }).count(), 0);
  console.log('e2e accessibility: desktop inbox scan started');
  assert.deepEqual(await axeViolations(page), []);
  console.log('e2e accessibility: desktop inbox scan passed');

  await page.getByRole('button', { name: '전사 업로드' }).click();
  await page.locator('#transcript-dialog').getByLabel('연결 이름').fill('운영 웨비나 전사');
  await page.getByLabel('전사 제목').fill('운영 웨비나');
  await page.getByLabel('또는 전사 내용').fill('첫 번째 운영 근거입니다.\n\n두 번째 운영 근거는 현재 스냅샷에 저장됩니다.');
  await page.locator('#transcript-dialog').getByLabel('사용 권리').selectOption('owned');
  const transcriptNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '연결 추가' }).click();
  await transcriptNavigation;
  await expectJob(db, config, 'ingest_transcript');
  await page.reload();
  await page.getByText('운영 웨비나', { exact: true }).waitFor();
  assert.equal((await db.query("SELECT count(*)::int AS count FROM sources WHERE connector_type='transcript_upload'"))[0].count, 1);

  await page.getByRole('button', { name: 'YouTube metadata' }).click();
  await page.getByLabel('YouTube 영상 주소 또는 ID').fill('https://youtu.be/abcDEF123_-');
  await page.locator('#youtube-dialog').getByLabel('사용 권리').selectOption('licensed');
  const youtubeNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '연결 추가' }).click();
  await youtubeNavigation;
  await expectJob(db, config, 'ingest_youtube_metadata');
  await page.reload();
  await page.getByText('공식 metadata 영상', { exact: true }).waitFor();
  await page.getByLabel('큐 상태').selectOption('missing_transcript');
  await page.getByRole('button', { name: '필터 적용' }).click();
  await page.getByText('전사 누락 · metadata만 수집', { exact: true }).waitFor();
  assert.equal((await db.query("SELECT count(*)::int AS count FROM sources WHERE connector_type='youtube_metadata'"))[0].count, 1);
  await page.getByRole('link', { name: '초기화' }).click();

  const sourceButton = page.getByRole('button', { name: 'RSS 원본 연결' });
  await sourceButton.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#source-dialog').evaluate((dialog) => dialog.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#source-dialog').evaluate((dialog) => dialog.open), false);

  await sourceButton.click();
  await page.locator('#source-dialog').getByLabel('연결 이름').fill('운영 RSS');
  await page.getByLabel('RSS 주소').fill(`${canaryBase}/feed.xml`);
  await page.locator('#source-dialog').getByLabel('사용 권리').selectOption('owned');
  const rssNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '연결 추가' }).click();
  await rssNavigation;
  const persistedSource = (await db.query("SELECT * FROM sources WHERE name='운영 RSS'"))[0];
  assert.equal(persistedSource.rights_status, 'owned');

  await expectJob(db, config, 'sync_rss');
  await page.reload();
  await page.getByText('가격과 배송', { exact: true }).waitFor();
  const sourceRow = page.getByRole('row').filter({ hasText: '가격과 배송' });
  await sourceRow.getByRole('link', { name: '계획 만들기' }).click();
  await page.waitForURL(/\/app\/planner\//u);
  assert.equal(await page.getByRole('heading', { name: '계획 만들기' }).count(), 1);

  for (const name of [
    'Naver Blog Draft',
    'WordPress Article',
    'Newsletter',
    'Instagram Carousel',
    'YouTube Shorts',
    'Instagram Reels',
    'TikTok Video'
  ]) {
    assert.equal(await page.getByRole('checkbox', { name }).count(), 1, `${name} is selectable`);
  }
  assert.equal(await page.getByText('Short Video Script', { exact: true }).count(), 0);

  await page.getByRole('checkbox', { name: 'Naver Blog Draft' }).check();
  await page.locator('input[name="channel_naver_blog_purpose"]').fill('가격과 배송 기준을 검색 독자에게 안내');
  await page.locator('input[name="channel_naver_blog_keyword"]').fill('가격 배송');
  await page.getByRole('checkbox', { name: 'YouTube Shorts' }).check();
  await page.locator('input[name="channel_youtube_shorts_purpose"]').fill('가격과 배송을 30초 안에 자막으로 안내');
  await page.locator('input[name="channel_youtube_shorts_targetSeconds"]').fill('30');
  const planResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/plans') && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '선택한 결과물 생성' }).click();
  const persistedPlanResponse = await planResponse;
  assert.equal(persistedPlanResponse.status(), 200);
  const plannedRunId = await waitForGenerationRunUrl(page, origin);
  assert.match(await page.locator('#current-generation').innerText(), /2개 선택 결과물 중 2개를 실제 Provider가 생성/u);

  assert.equal((await db.query('SELECT count(*)::int AS count FROM plan_outputs'))[0].count, 2);
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM runs
    WHERE id=$1 AND run_type='artifact_generation'`, [plannedRunId]))[0].count, 1);
  await expectJob(db, config, 'generate_plan_output');
  await expectJob(db, config, 'generate_plan_output');
  await page.reload();
  assert.match(await page.locator('#current-generation').innerText(), /2개 선택 결과물이 자동 검사와 함께 저장/u);
  assert.equal(await page.getByRole('link', { name: 'Naver Blog Draft 검토 시작' }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'YouTube Shorts 검토 시작' }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'Review Workbench에서 검토 시작' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Review Workbench 열기' }).count(), 2);
  const artifacts = await db.query('SELECT id,channel FROM artifacts ORDER BY channel');
  assert.deepEqual(artifacts.map((artifact) => artifact.channel), ['naver_blog', 'youtube_shorts']);
  const naverId = artifacts.find((artifact) => artifact.channel === 'naver_blog').id;
  const youtubeId = artifacts.find((artifact) => artifact.channel === 'youtube_shorts').id;

  await page.getByRole('link', { name: 'Naver Blog Draft 검토 시작' }).click();
  await page.getByText('Naver 모바일 문서 초안', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Review Workbench' }).count(), 1);
  assert.match(await page.locator('.automatic-summary,.review-boundary').allTextContents().then((values) => values.join(' ')), /자동/u);
  assert.match(await page.locator('#approval-blockers').innerText(), /현재 원본 스냅샷과 직접 비교하지 않은 사실 블록/u);
  assert.equal(await page.getByRole('button', { name: '승인' }).isDisabled(), true);
  assert.ok(await page.locator('.source-ref.selected-source').count() > 0, 'selected block highlights only its persisted refs');
  assert.equal(await page.getByText('새 버전으로 전체 결과물 재생성', { exact: true }).count(), 1);

  const previewTab = page.getByRole('tab', { name: '미리보기', exact: true });
  await previewTab.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '검사', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#context-checks').isVisible(), true);
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: '실행', exact: true }).getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#context-run').innerText(), /결과물 저장/u);
  await page.keyboard.press('Home');
  assert.equal(await previewTab.getAttribute('aria-selected'), 'true');

  await page.getByLabel('결과물 전체 의견').fill('브라우저에서 저장한 실제 검토 의견');
  const commentNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '의견 저장', exact: true }).click();
  await commentNavigation;
  await page.getByText('브라우저에서 저장한 실제 검토 의견', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(naverId, 'u'), 'internal artifact IDs are not rendered as UI content');
  console.log('e2e accessibility: desktop review scan started');
  assert.deepEqual(await axeViolations(page), []);
  console.log('e2e accessibility: desktop review scan passed');

  const factualBlocks = await db.query(`SELECT block.id
    FROM artifacts artifact
    JOIN artifact_blocks block ON block.artifact_version_id=artifact.current_version_id
    WHERE artifact.id=$1 AND block.content_kind='factual'
    ORDER BY block.ordinal,block.block_key`, [naverId]);
  assert.ok(factualBlocks.length > 0);
  assert.match(
    await page.locator('[data-verification-progress]').innerText(),
    new RegExp(`0/${factualBlocks.length}`, 'u')
  );
  assert.equal(await page.locator('.verification-queue-item').count(), factualBlocks.length);
  assert.equal(
    await page.locator('.artifact-block.selected').getAttribute('data-block-select'),
    factualBlocks[0].id,
    'the persisted first pending factual block is selected without exposing its ID in UI text'
  );
  assert.equal(await page.getByRole('tab', { name: '미리보기', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '다음 미확인 사실 블록 검토' }).click();
  assert.equal(
    await page.locator('.artifact-block.selected').getAttribute('data-block-select'),
    factualBlocks[0].id,
    'the next-review action opens the first persisted pending block'
  );
  assert.equal(await page.getByRole('tab', { name: '검사', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok(await page.locator('.source-ref.selected-source').count() > 0, 'the queue action keeps exact source refs highlighted');

  const mobileReview = await context.newPage();
  await mobileReview.setViewportSize({ width: 390, height: 844 });
  await mobileReview.goto(`${origin}/app/review/${naverId}`);
  await mobileReview.getByRole('tab', { name: '검토', exact: true }).click();
  await mobileReview.getByRole('button', { name: '다음 미확인 사실 블록 검토' }).click();
  assert.equal(await mobileReview.getByRole('tab', { name: '원본', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok(await mobileReview.locator('.source-ref.selected-source').count() > 0);
  await mobileReview.getByRole('tab', { name: '검토', exact: true }).click();
  assert.equal(await mobileReview.locator('#context-checks').isVisible(), true);
  await mobileReview.close();

  for (const [index, block] of factualBlocks.entries()) {
    assert.equal(
      await page.locator('.artifact-block.selected').getAttribute('data-block-select'),
      block.id,
      `the next persisted factual block ${index + 1} is selected`
    );
    assert.equal(await page.getByRole('tab', { name: '검사', exact: true }).getAttribute('aria-selected'), 'true');
    const checkPanel = page.locator(`[data-check-for="${block.id}"]`);
    assert.equal(await checkPanel.isVisible(), true);
    await checkPanel.getByLabel('사람 확인 메모').fill(`브라우저 현재 스냅샷 대조 ${index + 1}`);
    const verifyResponse = page.waitForResponse((response) => (
      response.url().endsWith(`/api/blocks/${block.id}/verify`) && response.request().method() === 'POST'
    ));
    const verificationNavigation = page.waitForNavigation();
    await checkPanel.getByRole('button', { name: '현재 스냅샷과 대조 기록' }).click();
    assert.equal((await verifyResponse).status(), 200);
    await verificationNavigation;
    await waitForDatabase(async () => Number((await db.query(`SELECT count(*)::int AS count
      FROM verifications WHERE artifact_block_id=$1 AND invalidated_at IS NULL`, [block.id]))[0].count) === 1,
    `factual block ${index + 1} verification was not persisted`);
    if (index + 1 < factualBlocks.length) {
      assert.match(
        await page.locator('[data-verification-progress]').innerText(),
        new RegExp(`${index + 1}/${factualBlocks.length}`, 'u')
      );
      assert.equal(
        await page.locator('.artifact-block.selected').getAttribute('data-block-select'),
        factualBlocks[index + 1].id,
        'reload selects the next persisted pending block rather than auto-verifying it'
      );
      assert.equal(await page.getByRole('button', { name: '승인' }).isDisabled(), true);
    }
  }
  assert.equal((await db.query(`SELECT count(*)::int AS count
    FROM verifications verification
    JOIN artifact_blocks block ON block.id=verification.artifact_block_id
    JOIN artifacts artifact ON artifact.current_version_id=block.artifact_version_id
  WHERE artifact.id=$1 AND block.content_kind='factual' AND verification.invalidated_at IS NULL`, [naverId]))[0].count, factualBlocks.length);
  assert.equal(await page.locator('#human-verification-queue').count(), 0);
  assert.equal(await page.getByRole('button', { name: '승인' }).isDisabled(), false);
  await page.getByLabel('승인 메모').fill('모든 사실 블록을 현재 원본 스냅샷과 직접 대조함');
  const approvalResponse = page.waitForResponse((response) => (
    response.url().endsWith(`/api/artifacts/${naverId}/approve`) && response.request().method() === 'POST'
  ));
  const approvalNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '승인' }).click();
  assert.equal((await approvalResponse).status(), 200);
  await approvalNavigation;
  await waitForDatabase(async () => Number((await db.query(`SELECT count(*)::int AS count
    FROM approvals approval JOIN artifacts artifact ON artifact.current_version_id=approval.artifact_version_id
    WHERE artifact.id=$1 AND approval.revoked_at IS NULL`, [naverId]))[0].count) === 1,
  'approval was not persisted');
  await page.getByText('승인됨', { exact: true }).waitFor();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '승인 버전 Markdown 다운로드' }).click();
  const download = await downloadPromise;
  const markdown = await readFile(await download.path(), 'utf8');
  assert.match(markdown, /^# 가격 100원과 배송 내일을 확인하는 방법/mu);
  assert.match(markdown, /공개된 가격은 100원/u);

  await page.getByRole('button', { name: 'WordPress 비공개 초안 만들기' }).click();
  await page.getByLabel('WordPress 주소').fill(`${canaryBase}/wp`);
  await page.getByLabel('사용자명').fill('draft-operator');
  await page.getByLabel('Application Password').fill('test-application-password');
  const wordpressResponse = page.waitForResponse((response) => (
    response.url().endsWith(`/api/artifacts/${naverId}/wordpress`) && response.request().method() === 'POST'
  ));
  const wordpressNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: 'draft 생성 요청' }).click();
  assert.equal((await wordpressResponse).status(), 200);
  await wordpressNavigation;
  await waitForDatabase(async () => Number((await db.query(`SELECT count(*)::int AS count
    FROM exports export
    JOIN artifact_versions version ON version.id=export.artifact_version_id
    WHERE version.artifact_id=$1 AND export.target='wordpress_draft' AND export.status='succeeded'`, [naverId]))[0].count) === 1,
  'WordPress draft export was not persisted');
  assert.equal(canary.state.wordpressPost.id, 501);
  assert.equal(canary.wordpressRequests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(canary.wordpressRequests.find((request) => request.method === 'POST').payload.status, 'draft');

  const versionBeforeRecovery = Number((await db.query(`SELECT version.version_no
    FROM artifacts artifact JOIN artifact_versions version ON version.id=artifact.current_version_id
    WHERE artifact.id=$1`, [naverId]))[0].version_no);
  canary.state.modelFailures = 1;
  const regenerationResponse = page.waitForResponse((response) => (
    response.url().endsWith(`/api/artifacts/${naverId}/regenerate`) && response.request().method() === 'POST'
  ));
  await page.getByText('새 버전으로 전체 결과물 재생성', { exact: true }).click();
  await page.getByRole('button', { name: '재생성 설정 열기' }).click();
  await page.getByLabel('새 불변 버전에서 사람 원본 대조가 다시 필요하다는 점을 확인했습니다.').check();
  await page.getByRole('button', { name: '새 버전 재생성 요청' }).click();
  assert.equal((await regenerationResponse).status(), 200);
  await page.waitForURL(`${origin}/app/runs`);
  const failedGeneration = await processNextEvent(db, config);
  assert.equal(failedGeneration.eventType, 'regenerate_artifact');
  assert.equal(failedGeneration.error?.code, 'MODEL_REQUEST_FAILED');
  assert.equal(failedGeneration.retry, false);
  await page.reload();
  await page.getByRole('button', { name: '실패한 결과물 다시 생성' }).waitFor();
  assert.match(await page.locator('body').innerText(), /모델 endpoint가 HTTP 400/u);

  const retryResponse = page.waitForResponse((response) => (
    /\/api\/plan-outputs\/[^/]+\/retry$/u.test(response.url()) && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '실패한 결과물 다시 생성' }).click();
  const retriedResponse = await retryResponse;
  assert.equal(retriedResponse.status(), 200);
  const retriedRunId = await waitForGenerationRunUrl(page, origin);
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM runs
    WHERE id=$1 AND run_type='artifact_generation_retry'`, [retriedRunId]))[0].count, 1);
  assert.equal(await page.getByRole('heading', { name: '재시도 생성 결과' }).count(), 1);
  await expectJob(db, config, 'generate_plan_output');
  await page.reload();
  assert.equal(await page.getByRole('link', { name: 'Review Workbench에서 검토 시작' }).count(), 1);
  const recoveredOutput = (await db.query(`SELECT output.status,version.version_no
    FROM plan_outputs output
    JOIN artifacts artifact ON artifact.id=output.artifact_id
    JOIN artifact_versions version ON version.id=artifact.current_version_id
    WHERE artifact.id=$1`, [naverId]))[0];
  assert.equal(recoveredOutput.status, 'succeeded');
  assert.equal(Number(recoveredOutput.version_no), versionBeforeRecovery + 1);

  canary.state.priceText = '가격은 120원입니다.';
  await page.goto(`${origin}/app/inbox`);
  const updatedSourceRow = page.getByRole('row').filter({ hasText: '가격과 배송' });
  const sourceSyncResponse = page.waitForResponse((response) => (
    response.url().endsWith(`/api/sources/${persistedSource.id}/sync`) && response.request().method() === 'POST'
  ));
  const sourceSyncNavigation = page.waitForNavigation();
  await updatedSourceRow.getByRole('button', { name: '지금 동기화' }).click();
  assert.equal((await sourceSyncResponse).status(), 200);
  await sourceSyncNavigation;
  await expectJob(db, config, 'sync_rss');
  await expectJob(db, config, 'apply_source_update');
  await page.goto(`${origin}/app/review/${naverId}`);
  await page.getByText('원본 변경', { exact: true }).first().waitFor();
  assert.ok(await page.locator('.artifact-block .badge').filter({ hasText: '원본 변경' }).count() > 0);
  const staleCount = Number((await db.query(`SELECT count(*)::int AS count
    FROM artifact_blocks block
    JOIN artifacts artifact ON artifact.current_version_id=block.artifact_version_id
    WHERE artifact.id=$1 AND block.stale=true`, [naverId]))[0].count);
  assert.ok(staleCount > 0);
  const changeImpactAction = page.getByRole('button', { name: '원본 변경 영향 확인' });
  assert.equal(await changeImpactAction.count(), 1);
  await changeImpactAction.click();
  assert.equal(await page.locator('#change-impact').isVisible(), true);

  await page.getByLabel('변경 영향 결정').selectOption('patch');
  const patchResponse = page.waitForResponse((response) => (
    response.url().endsWith(`/api/artifacts/${naverId}/refresh`) && response.request().method() === 'POST'
  ));
  const patchNavigation = page.waitForNavigation();
  await page.getByRole('button', { name: '변경 영향 결정 기록' }).click();
  assert.equal((await patchResponse).status(), 200);
  await patchNavigation;
  await expectJob(db, config, 'patch_artifact');
  await page.reload();
  assert.equal(Number((await db.query(`SELECT count(*)::int AS count
    FROM artifact_blocks block
    JOIN artifacts artifact ON artifact.current_version_id=block.artifact_version_id
    WHERE artifact.id=$1 AND block.stale=true`, [naverId]))[0].count), 0);
  assert.equal((await db.query('SELECT state FROM artifacts WHERE id=$1', [naverId]))[0].state, 'review_required');
  assert.match(await page.locator('body').innerText(), /최신 가격 120원/u);

  canary.state.feedFailures = 5;
  await page.goto(`${origin}/app/inbox`);
  const failureSourceRow = page.getByRole('row').filter({ hasText: '가격과 배송' });
  const failedSyncNavigation = page.waitForNavigation();
  await failureSourceRow.getByRole('button', { name: '지금 동기화' }).click();
  await failedSyncNavigation;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (attempt > 1) {
      await db.query(`UPDATE outbox_events SET available_at=now()
        WHERE event_type='sync_rss' AND status='pending'`);
    }
    const failure = await processNextEvent(db, config);
    assert.equal(failure.eventType, 'sync_rss');
    assert.equal(failure.error?.code, 'RSS_FETCH_FAILED');
    assert.equal(failure.retry, attempt < 5);
  }
  await page.reload();
  const retrySourceRow = page.getByRole('row').filter({ hasText: '가격과 배송' });
  const retrySyncNavigation = page.waitForNavigation();
  await retrySourceRow.getByRole('button', { name: '수집 재시도' }).click();
  await retrySyncNavigation;
  await expectJob(db, config, 'sync_rss');
  await page.reload();
  const recoveredSourceRow = page.getByRole('row').filter({ hasText: '가격과 배송' });
  assert.equal(await recoveredSourceRow.getByRole('button', { name: '지금 동기화' }).count(), 1);
  assert.equal((await db.query('SELECT status FROM source_sync_states WHERE source_id=$1', [persistedSource.id]))[0].status, 'succeeded');

  await page.goto(`${origin}/app/review/${youtubeId}`);
  await page.getByText(/YouTube Shorts 검색·재생 초안/u).waitFor();
  assert.equal(await page.getByText('첫 2초 검색 훅', { exact: true }).count(), 1);
  assert.ok(await page.getByText('UI safe zone', { exact: true }).count() >= 1);
  assert.equal(await page.getByText(/Instagram Reels 피드·프로필 crop/u).count(), 0);

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${origin}/app/inbox`);
  assert.equal(await mobile.getByRole('navigation', { name: '주요 메뉴' }).isVisible(), true);
  const touchTarget = await mobile.getByRole('button', { name: 'RSS 원본 연결' }).evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height
  }));
  assert.ok(touchTarget.width >= 44 && touchTarget.height >= 44);
  const inboxTableGeometry = await mobile.locator('.table-wrap table').first().evaluate((table) => ({
    scrollWidth: table.scrollWidth,
    clientWidth: table.clientWidth,
    firstRowDisplay: getComputedStyle(table.tBodies[0].rows[0]).display
  }));
  assert.ok(inboxTableGeometry.scrollWidth <= inboxTableGeometry.clientWidth, 'mobile inbox does not horizontally scroll table columns');
  assert.equal(inboxTableGeometry.firstRowDisplay, 'block', 'mobile inbox uses a readable card row');
  console.log('e2e accessibility: mobile inbox scan started');
  assert.deepEqual(await axeViolations(mobile), []);
  console.log('e2e accessibility: mobile inbox scan passed');
  await mobile.goto(`${origin}/app/review/${naverId}`);
  await mobile.getByRole('tab', { name: '검토', exact: true }).click();
  assert.equal(await mobile.locator('#review-panel').isVisible(), true);
  const mobileCheckTab = mobile.getByRole('tab', { name: '검사', exact: true });
  await mobileCheckTab.click();
  assert.equal(await mobile.locator('#context-checks').isVisible(), true);
  const reviewTouchTarget = await mobileCheckTab.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height
  }));
  assert.ok(reviewTouchTarget.width >= 44 && reviewTouchTarget.height >= 44);
  const mobileApprovalGeometry = await mobile.locator('.approval-form').evaluate((form) => {
    const rect = form.getBoundingClientRect();
    return { height: rect.height, position: getComputedStyle(form).position, viewportHeight: window.innerHeight };
  });
  assert.equal(mobileApprovalGeometry.position, 'fixed');
  assert.ok(mobileApprovalGeometry.height <= mobileApprovalGeometry.viewportHeight * 0.15, 'mobile approval bar stays below 15% of the viewport');
  console.log('e2e accessibility: mobile review scan started');
  assert.deepEqual(await axeViolations(mobile), []);
  console.log('e2e accessibility: mobile review scan passed');

  assert.deepEqual(
    [...new Set(canary.modelTasks)].sort(),
    ['EVIDENCE_PLAN', 'PATCH_ONLY', 'PLATFORM_DRAFT', 'STRICT_CLAIM_EVALUATION']
  );
});
