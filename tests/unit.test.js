import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../apps/shared/crypto.js';
import { parseFeed, segmentAndAtomize } from '../apps/shared/rss.js';
import { assertProviderAllowed, bootstrapUpstageSolarProvider } from '../apps/shared/intelligence.js';
import { validateChannelOutput } from '../apps/shared/planner.js';
import { artifactMarkdown } from '../apps/shared/export.js';
import { cookieOptions } from '../apps/shared/auth.js';
import { legacyPreviewWithBlockEdit } from '../apps/shared/platform-adapters.js';

const key = Buffer.alloc(32, 7).toString('base64');

test('password hashes verify without accepting a different password', async () => {
  const encoded = await hashPassword('long-enough-passphrase');
  assert.equal(await verifyPassword('long-enough-passphrase', encoded), true);
  assert.equal(await verifyPassword('different-passphrase', encoded), false);
});

test('provider secrets are encrypted at rest', () => {
  const encrypted = encryptSecret('secret-value', key);
  assert.notEqual(encrypted, 'secret-value');
  assert.equal(decryptSecret(encrypted, key), 'secret-value');
});

test('RSS parser persists usable source text only', () => {
  const rows = parseFeed('<rss><channel><item><guid>one</guid><title>제목</title><link>https://example.test/post</link><description>첫 문장. 둘째 문장.</description></item></channel></rss>');
  assert.equal(rows.length, 1);
  const structured = segmentAndAtomize(rows[0].title, rows[0].body);
  assert.ok(structured.segments.length >= 2);
  assert.ok(structured.atoms.every((atom) => atom.positionLabel));
});

test('fixture provider is rejected in production', () => {
  assert.throws(() => assertProviderAllowed('fixture', 'production', true), { code: 'FIXTURE_PROVIDER_IN_PRODUCTION' });
  assert.throws(() => assertProviderAllowed('fixture', 'test', false), { code: 'FIXTURE_PROVIDER_IN_PRODUCTION' });
});

test('unchanged Solar bootstrap preserves the persisted live canary result across restart', async (t) => {
  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  await bootstrapAdministrator(db, {
    email: 'bootstrap@example.test',
    password: 'correct-horse-battery-staple'
  });
  const first = await bootstrapUpstageSolarProvider(db, {
    apiKey: 'same-live-key',
    environment: 'production',
    secretKey: key,
    model: 'solar-open2'
  });
  await db.query(`UPDATE model_provider_configs
    SET last_test_status='succeeded',last_tested_at=now(),last_test_model='solar-open2'
    WHERE id=$1`, [first.providerId]);

  const restarted = await bootstrapUpstageSolarProvider(db, {
    apiKey: 'same-live-key',
    environment: 'production',
    secretKey: key,
    model: 'solar-open2'
  });
  assert.equal(restarted.providerId, first.providerId);
  const persisted = (await db.query(`SELECT count(*)::int AS count,last_test_status,last_test_model
    FROM model_provider_configs
    WHERE workspace_id=$1
    GROUP BY last_test_status,last_test_model`, [first.workspaceId]))[0];
  assert.equal(persisted.count, 1);
  assert.equal(persisted.last_test_status, 'succeeded');
  assert.equal(persisted.last_test_model, 'solar-open2');
});

test('session cookies stay secure in production unless an internal HTTP operator explicitly opts out', () => {
  assert.equal(cookieOptions('production').secure, true);
  assert.equal(cookieOptions('production', false).secure, false);
  assert.equal(cookieOptions('development').secure, false);
});

test('Naver and Short use incompatible persisted schemas instead of truncation', () => {
  const atoms = new Map([['본문 1 · 문장 1', 'atom-1'], ['본문 2 · 문장 1', 'atom-2']]);
  const naver = validateChannelOutput('naver_blog', { title: '제목', intro: '도입', introSourcePositions: ['본문 1 · 문장 1'], sections: [{ heading: '소제목', body: '본문', sourcePositions: ['본문 2 · 문장 1'] }], cta: 'CTA' }, atoms, []);
  const short = validateChannelOutput('short_video', { hook: '훅', hookSourcePositions: ['본문 1 · 문장 1'], scenes: [{ durationSeconds: 10, visual: '화면', onScreenText: '자막', narration: '내레이션', sourcePositions: ['본문 2 · 문장 1'] }], ending: '마무리' }, atoms, []);
  assert.equal(naver.preview.type, 'naver_article');
  assert.equal(short.preview.type, 'short_video_script');
  assert.notDeepEqual(naver.blocks.map((block) => block.type), short.blocks.map((block) => block.type));
});

test('expanded channel catalog has distinct schemas, previews, checks, and Markdown exports', () => {
  const atoms = new Map([['본문 1 · 문장 1', 'atom-1'], ['본문 2 · 문장 1', 'atom-2']]);
  const wordpress = validateChannelOutput('wordpress_article', { title: '제목', excerpt: '발췌', intro: '도입', introSourcePositions: ['본문 1 · 문장 1'], sections: [{ heading: '실행', body: '본문', sourcePositions: ['본문 2 · 문장 1'] }], cta: 'CTA' }, atoms, []);
  const newsletter = validateChannelOutput('newsletter', { subject: '제목', preheader: '프리헤더', opening: '시작', openingSourcePositions: ['본문 1 · 문장 1'], modules: [{ heading: '모듈', body: '본문', sourcePositions: ['본문 2 · 문장 1'] }], cta: 'CTA' }, atoms, []);
  const carousel = validateChannelOutput('instagram_carousel', { coverHook: '커버 훅', coverSourcePositions: ['본문 1 · 문장 1'], slides: [{ headline: '슬라이드', body: '본문', visualDirection: '큰 숫자 카드', sourcePositions: ['본문 2 · 문장 1'] }], caption: '캡션', hashtags: ['테스트'] }, atoms, []);
  assert.equal(wordpress.preview.type, 'wordpress_article');
  assert.equal(newsletter.preview.type, 'newsletter');
  assert.equal(carousel.preview.type, 'instagram_carousel');
  assert.notDeepEqual(wordpress.blocks.map((block) => block.type), newsletter.blocks.map((block) => block.type));
  assert.notDeepEqual(newsletter.blocks.map((block) => block.type), carousel.blocks.map((block) => block.type));
  assert.match(artifactMarkdown('wordpress_article', wordpress.preview), /^# 제목/m);
  assert.match(artifactMarkdown('newsletter', newsletter.preview), /프리헤더: 프리헤더/);
  assert.match(artifactMarkdown('instagram_carousel', carousel.preview), /시각 지시: 큰 숫자 카드/);
});

test('persisted legacy artifacts remain structurally editable after profile migration', () => {
  const naver = legacyPreviewWithBlockEdit('naver_blog', {
    title: '기존 제목',
    intro: '기존 도입',
    sections: [{ heading: '기존 소제목', body: '기존 본문' }],
    cta: ''
  }, {
    blockKey: 'section-1',
    content: '새 소제목\n새 본문'
  });
  assert.deepEqual(naver.sections[0], { heading: '새 소제목', body: '새 본문' });
  const short = legacyPreviewWithBlockEdit('short_video', {
    hook: '기존 훅',
    scenes: [{ visual: '기존 화면', onScreenText: '기존 자막', narration: '기존 내레이션', durationSeconds: 10 }],
    ending: '기존 마무리'
  }, {
    blockKey: 'scene-1',
    content: '화면: 새 화면\n자막: 새 자막\n내레이션: 새 내레이션'
  });
  assert.equal(short.scenes[0].durationSeconds, 10);
  assert.equal(short.scenes[0].narration, '새 내레이션');
  const legacyCarouselMarkdown = artifactMarkdown('instagram_carousel', {
    coverHook: '기존 커버',
    slides: [{ headline: '기존 제목', body: '기존 본문', visualDirection: '기존 시각 지시' }],
    caption: '',
    hashtags: []
  });
  assert.doesNotMatch(legacyCarouselMarkdown, /undefined/u);
});
