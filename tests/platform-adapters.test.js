import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import {
  SELECTABLE_PLATFORM_PROFILE_IDS,
  loadPlatformProfile
} from '../apps/shared/channel-registry.js';
import {
  previewWithBlockEdits,
  resolvePlatformAdapter,
  speechUnits,
  validateEditedPreview
} from '../apps/shared/platform-adapters.js';
import {
  evaluatorAssurance,
  semanticFindings,
  validateEvidencePlan
} from '../apps/shared/quality.js';

const HANDLES = Object.freeze([
  '본문 1 · 문장 1',
  '본문 1 · 문장 2',
  '본문 2 · 문장 1'
]);
const ATOMS = Object.freeze(HANDLES.map((position_label, index) => ({
  id: `atom-${index + 1}`,
  position_label,
  atom_type: 'claim',
  text: [
    'OSAU는 원본 스냅샷을 영속 저장한다.',
    '승인된 결과만 WordPress 초안으로 전송한다.',
    '출처 변경 영향은 저장된 블록-원본 관계에서 계산한다.'
  ][index]
})));
const ATOM_BY_HANDLE = new Map(ATOMS.map((atom) => [atom.position_label, atom.id]));
const COMMON_CONTEXT = Object.freeze({
  audience: { name: '소규모 콘텐츠 운영팀', needs: ['원본 근거를 잃지 않는 채널 재사용'] },
  creatorVoiceGuidance: '과장 없이 짧고 구체적으로 설명한다.',
  lockedCreatorIdentityFacts: [],
  commonCta: '원본과 대조한 뒤 초안을 저장하세요.'
});

const factual = (text, handle = HANDLES[0]) => ({ text, kind: 'factual', atomRefs: [handle] });
const production = (text) => ({ text, kind: 'production', atomRefs: [] });
const editorial = (text = COMMON_CONTEXT.commonCta) => ({ text, kind: 'editorial', atomRefs: [] });

function settingsFor(channel) {
  if (channel === 'naver_blog') return { purpose: '근거 기반 운영 방법 설명', keyword: '콘텐츠 재사용', readingTone: '정보형', includeFaq: false };
  if (channel === 'wordpress_article') return { purpose: '근거 기반 운영 가이드', angle: '실행 가이드', includeFaq: false };
  if (channel === 'newsletter') return { purpose: '이번 주 운영 핵심 전달', cadence: '주간', includePreamble: true };
  if (channel === 'instagram_carousel') return { purpose: '근거 보존 흐름을 카드로 설명', slideCount: 4, visualDirection: '간결한 정보 카드' };
  return { purpose: '근거 보존 흐름을 세로 영상으로 설명', targetSeconds: 20, visualStyle: '정보 카드', includeCaptions: true };
}

function articleCandidate(channel, includeFaq = false) {
  const wordpress = channel === 'wordpress_article';
  return {
    title: factual(wordpress ? 'WordPress 초안의 승인 경계' : '원본 근거를 지키는 콘텐츠 재사용'),
    ...(wordpress ? { excerpt: factual('원본 연결과 승인 경계를 함께 유지하는 방법', HANDLES[1]) } : {}),
    intro: factual('OSAU는 원본 스냅샷과 결과물의 연결을 보존한다.'),
    sections: [
      {
        heading: factual('원본을 먼저 고정한다'),
        body: factual('재사용 전에 원본 스냅샷을 영속 저장한다.'),
        ...(wordpress ? { headingLevel: 2 } : {})
      },
      {
        heading: factual('승인 뒤 초안을 전송한다', HANDLES[1]),
        body: factual('승인된 결과만 WordPress 초안으로 전송한다.', HANDLES[1]),
        ...(wordpress ? { headingLevel: 3 } : {})
      }
    ],
    faq: includeFaq ? [{
      question: factual('변경 영향은 어디에서 계산하나요?', HANDLES[2]),
      answer: factual('저장된 블록-원본 관계에서 계산한다.', HANDLES[2])
    }] : [],
    cta: editorial(),
    ...(wordpress
      ? { imageAltGuidance: production('이미지의 의미와 화면에 보이는 텍스트를 간결하게 기술') }
      : { tags: [factual('콘텐츠재사용'), factual('원본근거')] })
  };
}

function newsletterCandidate(includePreamble = true) {
  return {
    subject: factual('이번 주: 원본 근거를 지키는 재사용'),
    preheader: includePreamble ? factual('승인 경계와 변경 영향 계산을 확인하세요.', HANDLES[1]) : null,
    opening: factual('OSAU는 원본 스냅샷을 영속 저장한다.'),
    modules: [
      {
        heading: factual('승인 경계', HANDLES[1]),
        body: factual('승인된 결과만 WordPress 초안으로 전송한다.', HANDLES[1])
      },
      {
        heading: factual('정확한 변경 영향', HANDLES[2]),
        body: factual('저장된 블록-원본 관계에서 변경 영향을 계산한다.', HANDLES[2])
      }
    ],
    cta: editorial()
  };
}

function carouselCandidate(slideCount = 4) {
  return {
    cover: factual('원본 근거를 잃지 않는 3단계'),
    slides: Array.from({ length: slideCount }, (_, index) => ({
      headline: factual(`${index + 1}단계 · 근거 연결`, HANDLES[index % HANDLES.length]),
      body: factual(ATOMS[index % ATOMS.length].text, HANDLES[index % HANDLES.length]),
      visualDirection: production(`${index + 1}단계를 나타내는 단순 선형 도식`),
      altText: production(`${index + 1}단계 근거 연결을 설명하는 정보 카드`)
    })),
    caption: factual('원본 저장, 승인 경계, 변경 영향 계산을 카드별로 확인한다.', HANDLES[2]),
    hashtags: [factual('콘텐츠운영'), factual('원본근거')]
  };
}

function videoCandidate(channel, includeCaptions = true) {
  const hooks = {
    youtube_shorts: '검색한 답, 원본까지 이어지나요?',
    instagram_reels: '이 선이 끊기면 근거도 끊깁니다.',
    tiktok_video: '초안부터 만들면 근거를 놓칩니다.'
  };
  return {
    title: factual(`${channel} 근거 보존 흐름`),
    hook: factual(hooks[channel]),
    scenes: [
      {
        durationSeconds: 2,
        narration: factual('원본을 저장한다.'),
        onScreenText: factual('원본 고정'),
        visualDirection: production('원본 카드가 화면 중앙에 고정된다.'),
        safeZoneNote: production('핵심 문구를 중앙 안전 영역에 둔다.')
      },
      {
        durationSeconds: 9,
        narration: factual('승인된 결과만 초안으로 보낸다.', HANDLES[1]),
        onScreenText: factual('승인 뒤 초안', HANDLES[1]),
        visualDirection: production('검토 표시가 초안 카드로 이동한다.'),
        safeZoneNote: production('우측 UI 영역을 비우고 중앙에 자막을 둔다.')
      },
      {
        durationSeconds: 9,
        narration: factual('변경 영향은 저장된 관계로 계산한다.', HANDLES[2]),
        onScreenText: factual('정확한 변경 영향', HANDLES[2]),
        visualDirection: production('원본과 영향 블록 사이의 선을 강조한다.'),
        safeZoneNote: production('하단 설명 UI 위로 핵심 문구를 올린다.')
      }
    ],
    ending: factual('원본 관계를 먼저 확인한다.', HANDLES[2]),
    caption: includeCaptions ? factual('원본 관계를 보존한 채 채널별 결과를 만든다.', HANDLES[2]) : null,
    coverText: factual('근거가 남는 재사용')
  };
}

function overfullVideoCandidate(channel) {
  const candidate = videoCandidate(channel);
  const narrationUnits = [12, 60, 60];
  const durations = [3, 9, 8];
  const baseScenes = structuredClone(candidate.scenes);
  candidate.scenes = narrationUnits.map((units, index) => {
    const handle = HANDLES[index % HANDLES.length];
    const base = baseScenes[index % baseScenes.length];
    return {
      ...base,
      durationSeconds: durations[index],
      narration: factual('가'.repeat(units), handle),
      onScreenText: factual(`근거 ${index + 1}`, handle),
      visualDirection: production(`${index + 1}번째 근거 장면을 순서대로 보여준다.`),
      safeZoneNote: production(`${index + 1}번째 핵심 문구를 중앙 안전 영역에 둔다.`)
    };
  });
  return candidate;
}

function candidateFor(channel, settings = settingsFor(channel)) {
  if (channel === 'naver_blog' || channel === 'wordpress_article') return articleCandidate(channel, settings.includeFaq);
  if (channel === 'newsletter') return newsletterCandidate(settings.includePreamble);
  if (channel === 'instagram_carousel') return carouselCandidate(settings.slideCount);
  return videoCandidate(channel, settings.includeCaptions);
}

let database;
let pglite;
const profiles = new Map();

before(async () => {
  pglite = new PGlite();
  database = createPgliteDatabase(pglite);
  await migrate(database, process.cwd());
  for (const id of SELECTABLE_PLATFORM_PROFILE_IDS) profiles.set(id, await loadPlatformProfile(database, id));
});

after(async () => {
  await database?.close();
});

test('seven selectable profiles create persisted-block-ready, channel-specific structures', () => {
  const results = [];
  for (const profile of profiles.values()) {
    const adapter = resolvePlatformAdapter(profile);
    const settings = adapter.normalizeSettings(settingsFor(profile.channel));
    const structured = adapter.validateCandidate({
      candidate: candidateFor(profile.channel, settings),
      settings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    });
    results.push(structured);
    assert.equal(structured.channel, profile.channel);
    assert.ok(structured.blocks.length > 0);
    assert.ok(structured.deterministicChecks.every((check) => check.passed));
    assert.ok(structured.blocks.every((block) => block.surfacePath.startsWith('$.')));
    assert.ok(structured.blocks
      .filter((block) => block.contentKind === 'factual')
      .every((block) => block.refs.length > 0 && block.evidenceState === 'review_required'));
    assert.ok(structured.blocks
      .filter((block) => block.contentKind !== 'factual')
      .every((block) => block.refs.length === 0 && block.evidenceState === 'not_required'));
  }

  assert.equal(new Set(results.map((result) => result.preview.type)).size, 7);
  assert.equal(new Set(results.map((result) => JSON.stringify(result.adaptationOperations))).size, 7);
  assert.deepEqual(results.map((result) => result.channel).sort(), [
    'instagram_carousel',
    'instagram_reels',
    'naver_blog',
    'newsletter',
    'tiktok_video',
    'wordpress_article',
    'youtube_shorts'
  ]);
});

test('YouTube Shorts, Instagram Reels, and TikTok keep distinct purposes and preview contracts', () => {
  const channels = ['youtube_shorts', 'instagram_reels', 'tiktok_video'];
  const results = channels.map((channel) => {
    const profile = [...profiles.values()].find((entry) => entry.channel === channel);
    const adapter = resolvePlatformAdapter(profile);
    const settings = adapter.normalizeSettings(settingsFor(channel));
    return adapter.validateCandidate({
      candidate: videoCandidate(channel),
      settings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    });
  });
  assert.deepEqual(results.map((result) => result.preview.type), [
    'youtube_shorts_timeline_preview',
    'instagram_reels_timeline_preview',
    'tiktok_video_timeline_preview'
  ]);
  assert.ok(results[0].adaptationOperations.includes('long_form_discovery_cta'));
  assert.ok(results[1].adaptationOperations.includes('save_share_sequence'));
  assert.ok(results[2].adaptationOperations.includes('comment_conversation_cta'));
  assert.ok(results.every((result) => result.preview.totalSeconds === 20));
  assert.notEqual(results[0].preview.hook, results[1].preview.hook);
  assert.notEqual(results[1].preview.hook, results[2].preview.hook);

  const shorts = resolvePlatformAdapter(profiles.get('youtube_shorts:v1'));
  const prompt = JSON.parse(shorts.buildDraftPrompt({
    settings: shorts.normalizeSettings(settingsFor('youtube_shorts')),
    commonContext: COMMON_CONTEXT,
    evidencePlan: {
      supportedPurpose: '근거 보존 흐름 설명',
      missingInformation: [],
      contentBudget: { maximumClaims: 3 },
      selectedSourceHandles: HANDLES,
      selectedAtoms: ATOMS
    }
  }));
  assert.equal(prompt.generationConstraints.firstSceneNarration.maximumSpeechUnits, 12);
  assert.equal(prompt.generationConstraints.firstSceneDurationSeconds.maximum, 2);
});

test('settings change structure and invalid settings cannot silently create unselected surfaces', () => {
  const naver = resolvePlatformAdapter(profiles.get('naver_blog:v2'));
  const withFaq = naver.normalizeSettings({ ...settingsFor('naver_blog'), includeFaq: true });
  const naverResult = naver.validateCandidate({
    candidate: articleCandidate('naver_blog', true),
    settings: withFaq,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  });
  assert.equal(naverResult.preview.faq.length, 1);

  const newsletter = resolvePlatformAdapter(profiles.get('newsletter:v2'));
  const withoutPreamble = newsletter.normalizeSettings({ ...settingsFor('newsletter'), includePreamble: false });
  const newsletterResult = newsletter.validateCandidate({
    candidate: newsletterCandidate(false),
    settings: withoutPreamble,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  });
  assert.equal(newsletterResult.preview.preheader, '');
  assert.equal(newsletterResult.blocks.some((block) => block.key === 'preheader'), false);

  const carousel = resolvePlatformAdapter(profiles.get('instagram_carousel:v2'));
  const carouselSettings = carousel.normalizeSettings(settingsFor('instagram_carousel'));
  assert.throws(() => carousel.validateCandidate({
    candidate: carouselCandidate(3),
    settings: carouselSettings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }), { code: 'CHANNEL_CONSTRAINT_FAILED' });

  const reels = resolvePlatformAdapter(profiles.get('instagram_reels:v1'));
  const noCaptions = reels.normalizeSettings({ ...settingsFor('instagram_reels'), includeCaptions: false });
  const reelsResult = reels.validateCandidate({
    candidate: videoCandidate('instagram_reels', false),
    settings: noCaptions,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  });
  assert.equal(reelsResult.blocks.some((block) => block.key === 'caption'), false);
});

test('profile-owned assembly canonicalizes non-content metadata and plans feasible video timing without rewriting text', () => {
  const carousel = resolvePlatformAdapter(profiles.get('instagram_carousel:v2'));
  const carouselSettings = carousel.normalizeSettings(settingsFor('instagram_carousel'));
  const rawCarousel = carouselCandidate(carouselSettings.slideCount);
  const originalVisualText = rawCarousel.slides[0].visualDirection.text;
  rawCarousel.slides[0].visualDirection.kind = 'factual';
  rawCarousel.slides[0].visualDirection.atomRefs = [HANDLES[0]];
  const assembledCarousel = carousel.assembleCandidate({
    candidate: rawCarousel,
    settings: carouselSettings,
    commonContext: COMMON_CONTEXT
  });
  assert.equal(assembledCarousel.slides[0].visualDirection.text, originalVisualText);
  assert.equal(assembledCarousel.slides[0].visualDirection.kind, 'production');
  assert.deepEqual(assembledCarousel.slides[0].visualDirection.atomRefs, []);
  assert.doesNotThrow(() => carousel.validateCandidate({
    candidate: assembledCarousel,
    settings: carouselSettings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }));

  const reels = resolvePlatformAdapter(profiles.get('instagram_reels:v1'));
  const videoSettings = reels.normalizeSettings({
    ...settingsFor('instagram_reels'),
    targetSeconds: 20
  });
  const rawVideo = videoCandidate('instagram_reels');
  const originalHookText = rawVideo.hook.text;
  const originalHookRefs = [...rawVideo.hook.atomRefs];
  rawVideo.hook = originalHookText;
  rawVideo.hookSourcePositions = originalHookRefs;
  rawVideo.ending.atomRefs = [{ handle: HANDLES[2], text: ATOMS[2].text }];
  rawVideo.scenes.forEach((scene) => {
    scene.durationSeconds = 1;
    scene.visualDirection.kind = 'factual';
    scene.visualDirection.atomRefs = [HANDLES[0]];
  });
  const originalNarration = rawVideo.scenes.map((scene) => scene.narration.text);
  const assembledVideo = reels.assembleCandidate({
    candidate: rawVideo,
    settings: videoSettings,
    commonContext: COMMON_CONTEXT
  });
  assert.deepEqual(assembledVideo.scenes.map((scene) => scene.narration.text), originalNarration);
  assert.deepEqual(assembledVideo.hook, {
    text: originalHookText,
    kind: 'factual',
    atomRefs: originalHookRefs
  });
  assert.deepEqual(assembledVideo.ending.atomRefs, [HANDLES[2]]);
  assert.equal(Object.hasOwn(assembledVideo, 'hookSourcePositions'), false);
  assert.ok(assembledVideo.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) >= 12);
  assert.ok(assembledVideo.scenes.every((scene) => scene.visualDirection.kind === 'production'));
  assert.doesNotThrow(() => reels.validateCandidate({
    candidate: assembledVideo,
    settings: videoSettings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }));

  const shorts = resolvePlatformAdapter(profiles.get('youtube_shorts:v1'));
  const shortsSettings = shorts.normalizeSettings(settingsFor('youtube_shorts'));
  const longHookNarration = videoCandidate('youtube_shorts');
  longHookNarration.scenes[0].narration.text = '첫 장면의 내레이션이 이초 안에 발화하기에는 지나치게 깁니다.';
  longHookNarration.scenes[0].onScreenText.text = '첫 장면의 화면 문구도 훅 창에서 읽기에는 지나치게 깁니다.';
  const extractiveCandidates = [
    longHookNarration.hook,
    longHookNarration.coverText,
    longHookNarration.title,
    longHookNarration.ending,
    ...longHookNarration.scenes.map((scene) => scene.onScreenText)
  ].map((surface) => JSON.stringify(surface));
  const assembledShorts = shorts.assembleCandidate({
    candidate: longHookNarration,
    settings: shortsSettings,
    commonContext: COMMON_CONTEXT
  });
  assert.ok(extractiveCandidates.includes(JSON.stringify(assembledShorts.scenes[0].narration)));
  assert.ok(speechUnits(assembledShorts.scenes[0].narration.text) <= 12);
  assert.equal(assembledShorts.scenes[0].durationSeconds, 2);
  assert.doesNotThrow(() => shorts.validateCandidate({
    candidate: assembledShorts,
    settings: shortsSettings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }));
});

test('timed-video density feedback freezes valid timing and preserves exact source handles', () => {
  const adapter = resolvePlatformAdapter(profiles.get('tiktok_video:v1'));
  const settings = adapter.normalizeSettings({
    ...settingsFor('tiktok_video'),
    targetSeconds: 20
  });
  const candidate = overfullVideoCandidate('tiktok_video');
  const original = structuredClone(candidate);
  const assembled = adapter.assembleCandidate({
    candidate,
    settings,
    commonContext: COMMON_CONTEXT
  });

  assert.deepEqual(
    assembled.scenes.map((scene) => scene.narration),
    candidate.scenes.map((scene) => scene.narration)
  );
  assert.deepEqual(
    assembled.scenes.map((scene) => scene.durationSeconds),
    candidate.scenes.map((scene) => scene.durationSeconds)
  );
  assert.deepEqual(candidate, original);
  let failure;
  try {
    adapter.validateCandidate({
      candidate: assembled,
      settings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'CHANNEL_CONSTRAINT_FAILED');
  assert.ok(failure.meta.affectedSurfacePaths.length > 0);
  assert.ok(failure.meta.affectedSurfacePaths.every((path) => path.endsWith('.narration.text')));
  for (const constraint of failure.meta.allowed.timingConstraints) {
    assert.equal(constraint.code, 'NARRATION_DENSITY');
    const index = Number(constraint.paths[0].match(/\[(\d+)\]/u)[1]);
    assert.equal(constraint.maximumSpeechUnits, candidate.scenes[index].durationSeconds * 6);
    assert.equal(constraint.fixedDurationSeconds, candidate.scenes[index].durationSeconds);
    assert.deepEqual(constraint.preserveSourceHandles, [
      candidate.scenes[index].narration.atomRefs[0]
    ]);
  }
});

test('TikTok reports all three simultaneous 53/169/169-unit narration violations against the 3/14/13 server timing plan', () => {
  const adapter = resolvePlatformAdapter(profiles.get('tiktok_video:v1'));
  const settings = adapter.normalizeSettings({
    ...settingsFor('tiktok_video'),
    targetSeconds: 30
  });
  const candidate = videoCandidate('tiktok_video');
  const expectedDurations = [3, 14, 13];
  const expectedUnits = [53, 169, 169];
  const expectedBudgets = [18, 84, 78];
  const exactEvidence = (base, target) => {
    const remaining = target - speechUnits(base);
    assert.ok(remaining > 0);
    const text = `${base} ${'근'.repeat(remaining)}`;
    assert.equal(speechUnits(text), target);
    return text;
  };
  const evidenceTexts = [
    exactEvidence('원본을 저장합니다. 바뀐 결과만 다시 확인합니다.', expectedUnits[0]),
    exactEvidence('근거 위치를 보존합니다. 저장된 관계로 영향 문장을 찾습니다. 자동 검사는 사람 확인이 아닙니다.', expectedUnits[1]),
    exactEvidence('승인 뒤 WordPress 초안을 만듭니다. 재시도해도 실패와 사용자 편집은 보존합니다.', expectedUnits[2])
  ];
  const atomByHandle = new Map(ATOMS.map((atom, index) => [
    atom.position_label,
    { ...atom, text: evidenceTexts[index] }.id
  ]));
  candidate.scenes.forEach((scene, index) => {
    scene.durationSeconds = expectedDurations[index];
    scene.narration = factual(evidenceTexts[index], HANDLES[index]);
  });

  let failure;
  try {
    adapter.validateCandidate({
      candidate,
      settings,
      atomByHandle,
      commonContext: COMMON_CONTEXT
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, 'CHANNEL_CONSTRAINT_FAILED');
  assert.deepEqual(failure.meta.affectedSurfacePaths, [
    '$.scenes[0].narration.text',
    '$.scenes[1].narration.text',
    '$.scenes[2].narration.text'
  ]);
  const densityConstraints = failure.meta.allowed.timingConstraints
    .filter((constraint) => constraint.code === 'NARRATION_DENSITY');
  assert.equal(densityConstraints.length, 3);
  assert.deepEqual(
    densityConstraints.map((constraint) => constraint.fixedDurationSeconds),
    expectedDurations
  );
  assert.deepEqual(
    densityConstraints.map((constraint) => constraint.maximumSpeechUnits),
    expectedBudgets
  );
  assert.deepEqual(
    densityConstraints.map((constraint) => constraint.preserveSourceHandles),
    HANDLES.map((handle) => [handle])
  );
  assert.deepEqual(
    failure.meta.observed.timingViolations.map((violation) => violation.speechUnits),
    expectedUnits
  );
});

test('correlated total-duration and density feedback never authorizes duration changes for density', () => {
  const adapter = resolvePlatformAdapter(profiles.get('tiktok_video:v1'));
  const settings = adapter.normalizeSettings({
    ...settingsFor('tiktok_video'),
    targetSeconds: 20
  });
  const candidate = overfullVideoCandidate('tiktok_video');
  candidate.scenes[0].durationSeconds = 4;
  candidate.scenes[1].durationSeconds = 9;
  candidate.scenes[2].durationSeconds = 11;
  let failure;
  try {
    adapter.validateCandidate({
      candidate,
      settings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, 'CHANNEL_CONSTRAINT_FAILED');
  const constraints = failure.meta.allowed.timingConstraints;
  assert.ok(constraints.some((constraint) => constraint.code === 'TOTAL_DURATION'));
  const densityConstraints = constraints.filter((constraint) => constraint.code === 'NARRATION_DENSITY');
  assert.ok(densityConstraints.length > 0);
  assert.ok(densityConstraints.every((constraint) => (
    constraint.paths.length === 1
    && constraint.paths[0].endsWith('.narration.text')
    && Number.isInteger(constraint.maximumSpeechUnits)
    && Array.isArray(constraint.preserveSourceHandles)
    && constraint.preserveSourceHandles.length > 0
    && !Object.hasOwn(constraint, 'fixedDurationSeconds')
  )));
});

test('timed-video minimum scene count includes the reduced first-hook capacity', () => {
  for (const profileId of ['youtube_shorts:v1', 'instagram_reels:v1', 'tiktok_video:v1']) {
    const adapter = resolvePlatformAdapter(profiles.get(profileId));
    const settings = adapter.normalizeSettings({
      ...settingsFor(adapter.profile.channel),
      targetSeconds: adapter.profile.channel === 'instagram_reels' ? 90 : 180
    });
    const prompt = JSON.parse(adapter.buildDraftPrompt({
      settings,
      commonContext: COMMON_CONTEXT,
      evidencePlan: {
        supportedPurpose: '근거 보존 흐름 설명',
        missingInformation: [],
        contentBudget: { maximumClaims: 3 },
        selectedSourceHandles: HANDLES,
        selectedAtoms: ATOMS
      }
    }));
    const minimumDuration = Math.max(10, settings.targetSeconds - 8);
    const hookMaximum = prompt.generationConstraints.firstSceneDurationSeconds.maximum;
    const expectedMinimum = Math.max(3, 1 + Math.ceil((minimumDuration - hookMaximum) / 20));
    assert.equal(prompt.generationConstraints.sceneCount.exact, expectedMinimum);
    assert.equal(prompt.generationConstraints.sceneDurationPlanSeconds.length, expectedMinimum);
    assert.equal(
      prompt.generationConstraints.sceneDurationPlanSeconds.reduce((sum, value) => sum + value, 0),
      Math.min(settings.targetSeconds, hookMaximum + ((expectedMinimum - 1) * 20))
    );

    const tooFew = videoCandidate(adapter.profile.channel);
    const sceneTemplates = tooFew.scenes;
    tooFew.scenes = Array.from({ length: expectedMinimum - 1 }, (_, index) => ({
      ...structuredClone(sceneTemplates[index % sceneTemplates.length]),
      durationSeconds: index === 0 ? hookMaximum : 20
    }));
    assert.throws(() => adapter.validateCandidate({
      candidate: tooFew,
      settings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    }), { code: 'CHANNEL_CONSTRAINT_FAILED' });
  }
});

test('video validation reports every malformed visible surface in one bounded-repair contract', () => {
  const shorts = resolvePlatformAdapter(profiles.get('youtube_shorts:v1'));
  const settings = shorts.normalizeSettings(settingsFor('youtube_shorts'));
  const candidate = videoCandidate('youtube_shorts');
  candidate.title = candidate.title.text;
  candidate.hook = candidate.hook.text;
  candidate.ending = candidate.ending.text;
  candidate.coverText = candidate.coverText.text;
  let failure;
  try {
    shorts.validateCandidate({
      candidate,
      settings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'CHANNEL_CONSTRAINT_FAILED');
  assert.deepEqual(failure.meta.affectedSurfacePaths, [
    '$.title',
    '$.hook',
    '$.ending',
    '$.coverText'
  ]);
  assert.equal(failure.meta.allowed.valuesByPath.length, 4);
});

test('article and card validation aggregate all malformed visible surfaces before bounded repair', () => {
  const wordpress = resolvePlatformAdapter(profiles.get('wordpress_article:v2'));
  const wordpressSettings = wordpress.normalizeSettings(settingsFor('wordpress_article'));
  const article = articleCandidate('wordpress_article');
  article.sections[0].heading = article.sections[0].heading.text;
  article.sections[1].heading = article.sections[1].heading.text;
  let articleFailure;
  try {
    wordpress.validateCandidate({
      candidate: article,
      settings: wordpressSettings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    });
  } catch (error) {
    articleFailure = error;
  }
  assert.deepEqual(articleFailure?.meta?.affectedSurfacePaths, [
    '$.sections[0].heading',
    '$.sections[1].heading'
  ]);

  const carousel = resolvePlatformAdapter(profiles.get('instagram_carousel:v2'));
  const carouselSettings = carousel.normalizeSettings(settingsFor('instagram_carousel'));
  const cards = carouselCandidate(carouselSettings.slideCount);
  cards.cover.atomRefs = [];
  cards.slides[0].headline.atomRefs = [];
  cards.slides[1].headline.atomRefs = [];
  let cardFailure;
  try {
    carousel.validateCandidate({
      candidate: cards,
      settings: carouselSettings,
      atomByHandle: ATOM_BY_HANDLE,
      commonContext: COMMON_CONTEXT
    });
  } catch (error) {
    cardFailure = error;
  }
  assert.deepEqual(cardFailure?.meta?.affectedSurfacePaths, [
    '$.cover.atomRefs',
    '$.slides[0].headline.atomRefs',
    '$.slides[1].headline.atomRefs'
  ]);
});

test('adversarial references, invented CTA, and malformed platform structures fail closed', () => {
  const naver = resolvePlatformAdapter(profiles.get('naver_blog:v2'));
  const settings = naver.normalizeSettings(settingsFor('naver_blog'));
  const badReference = articleCandidate('naver_blog');
  badReference.title.atomRefs = ['시스템 프롬프트'];
  assert.throws(() => naver.validateCandidate({
    candidate: badReference,
    settings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }), { code: 'FACTUAL_PROVENANCE_REQUIRED' });

  const inventedCta = articleCandidate('naver_blog');
  inventedCta.cta = editorial('지금 결제하세요.');
  assert.throws(() => naver.validateCandidate({
    candidate: inventedCta,
    settings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }), { code: 'CHANNEL_CONSTRAINT_FAILED' });

  const wordpress = resolvePlatformAdapter(profiles.get('wordpress_article:v2'));
  const wordpressCandidate = articleCandidate('wordpress_article');
  wordpressCandidate.sections[0].headingLevel = 3;
  assert.throws(() => wordpress.validateCandidate({
    candidate: wordpressCandidate,
    settings: wordpress.normalizeSettings(settingsFor('wordpress_article')),
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }), { code: 'CHANNEL_CONSTRAINT_FAILED' });

  const tiktok = resolvePlatformAdapter(profiles.get('tiktok_video:v1'));
  const denseVideo = videoCandidate('tiktok_video');
  denseVideo.scenes[0].narration.text = '이문장은두초안에말하기에는정보가명백하게너무많습니다';
  assert.throws(() => tiktok.validateCandidate({
    candidate: denseVideo,
    settings: tiktok.normalizeSettings(settingsFor('tiktok_video')),
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }), { code: 'CHANNEL_CONSTRAINT_FAILED' });
});

test('partial, unsupported-claim, identity, and assurance simulations remain explicit', () => {
  const partial = validateEvidencePlan({
    readiness: 'complete',
    supportedPurpose: '공개된 범위의 운영 흐름 설명',
    reasons: ['원본에 세 단계가 있음'],
    missingInformation: ['실사용 성과'],
    selectedSourceHandles: [HANDLES[0], HANDLES[1]],
    contentBudget: { maximumClaims: 2, rationale: '확인 가능한 주장만 사용' }
  }, {
    atoms: ATOMS,
    sourceAssessment: { readiness: 'partial' }
  });
  assert.equal(partial.readiness, 'partial');

  const findings = semanticFindings({
    purposeFit: 'mismatch',
    purposeReason: '원본에 성과 수치가 없다.',
    blocks: [{
      blockKey: 'title',
      verdict: 'insufficient',
      claims: [{ claim: '전환율이 30% 증가한다.', verdict: 'insufficient', reason: '성과 수치 근거가 없다.' }]
    }],
    creatorIdentityClaims: ['10년 경력의 콘텐츠 전문가'],
    platformChecks: []
  }, []);
  assert.deepEqual(new Set(findings.map((finding) => finding.code)), new Set([
    'SOURCE_PURPOSE_MISMATCH',
    'UNSUPPORTED_FACTUAL_CLAIM',
    'PERSONA_FABRICATION'
  ]));
  assert.equal(evaluatorAssurance('solar-generator', 'solar-generator'), 'LOW_ASSURANCE');
  assert.equal(evaluatorAssurance('solar-generator', 'independent-evaluator'), 'HIGH_ASSURANCE');

  const naver = resolvePlatformAdapter(profiles.get('naver_blog:v2'));
  const structured = naver.validateCandidate({
    candidate: articleCandidate('naver_blog'),
    settings: naver.normalizeSettings(settingsFor('naver_blog')),
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  });
  const edited = previewWithBlockEdits(structured.preview, [{
    surfacePath: '$.sections[0].body',
    content: '사람이 편집한 후속 버전'
  }]);
  assert.equal(edited.sections[0].body, '사람이 편집한 후속 버전');
  assert.notEqual(structured.preview.sections[0].body, edited.sections[0].body);
});

test('persisted user edits rerun the active platform structure instead of bypassing release checks', () => {
  const profile = profiles.get('naver_blog:v2');
  const adapter = resolvePlatformAdapter(profile);
  const settings = adapter.normalizeSettings(settingsFor('naver_blog'));
  const structured = adapter.validateCandidate({
    candidate: articleCandidate('naver_blog'),
    settings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  });
  const handleById = new Map([...ATOM_BY_HANDLE].map(([handle, atomId]) => [atomId, handle]));
  const persisted = structured.blocks.map((block) => ({
    key: block.key,
    surfacePath: block.surfacePath,
    content: block.content,
    contentKind: block.contentKind,
    sourceHandles: block.refs.map((atomId) => handleById.get(atomId))
  }));
  const title = persisted.find((block) => block.key === 'title');
  title.content = '가'.repeat(8_000);
  const invalidPreview = previewWithBlockEdits(structured.preview, [{
    surfacePath: title.surfacePath,
    content: title.content
  }]);
  assert.throws(() => validateEditedPreview({
    profile,
    preview: invalidPreview,
    blocks: persisted,
    settings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  }), { code: 'CHANNEL_CONSTRAINT_FAILED' });

  title.content = '사람이 검토할 수 있는 플랫폼 적합 제목';
  const valid = validateEditedPreview({
    profile,
    preview: previewWithBlockEdits(structured.preview, [{
      surfacePath: title.surfacePath,
      content: title.content
    }]),
    blocks: persisted,
    settings,
    atomByHandle: ATOM_BY_HANDLE,
    commonContext: COMMON_CONTEXT
  });
  assert.equal(valid.preview.title, title.content);
  assert.ok(valid.deterministicChecks.every((check) => check.passed));
});
