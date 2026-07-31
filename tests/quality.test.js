import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import {
  applyCertifiedNarrationRepair,
  applyBoundedCandidateRepair,
  assertBoundedCandidateRepair,
  assertRepairScope,
  boundedContractRepairPrompt,
  boundedQualityRepairPlan,
  buildCertifiedNarrationRepairPlan,
  commonDeterministicFindings,
  evaluatorAssurance,
  evidencePlanPrompt,
  semanticFindings,
  validateEvaluatorResult,
  validateEvidencePlan
} from '../apps/shared/quality.js';
import { issue } from '../apps/shared/errors.js';
import { requestCompletion, saveModelProvider, testProvider } from '../apps/shared/intelligence.js';
import { requestPatchEvaluation } from '../apps/shared/patch.js';
import { speechUnits } from '../apps/shared/platform-adapters.js';

const atoms = [
  { id: 'atom-1', position_label: '본문 1 · 문장 1', atom_type: 'claim', text: '제품은 7월 29일 출시됐다.' },
  { id: 'atom-2', position_label: '본문 2 · 문장 1', atom_type: 'claim', text: '기본 요금은 월 10,000원이다.' }
];

const DENSE_NARRATION_HANDLES = Object.freeze([
  'owned_1::본문 1 · 문장 1',
  'owned_1::본문 2 · 문장 1',
  'owned_1::본문 3 · 문장 1'
]);
const DENSE_NARRATION_DURATIONS = Object.freeze([3, 14, 13]);
const DENSE_NARRATION_UNITS = Object.freeze([53, 169, 169]);
const DENSE_NARRATION_BUDGETS = Object.freeze([18, 84, 78]);

function exactOwnedKoreanEvidence(parts, targetSpeechUnits) {
  const base = parts.join(' ');
  const remaining = targetSpeechUnits - speechUnits(base);
  assert.ok(remaining > 0, 'fixture base must leave deterministic Korean padding');
  const value = `${base} ${'근'.repeat(remaining)}`;
  assert.equal(speechUnits(value), targetSpeechUnits);
  return value;
}

function denseNarrationRepairFixture() {
  const sourceTexts = [
    exactOwnedKoreanEvidence([
      '원본을 먼저 저장합니다.',
      '바뀐 원본과 연결된 결과만 다시 확인합니다.',
      '검토 이력은 남습니다.'
    ], DENSE_NARRATION_UNITS[0]),
    exactOwnedKoreanEvidence([
      '결과물은 사용한 근거 위치를 보존합니다.',
      '원본이 바뀌면 저장된 블록 원본 관계로 영향 문장을 찾습니다.',
      '자동 검사는 사람의 확인이 아닙니다.',
      '이전 검토 기록은 이력으로 남습니다.'
    ], DENSE_NARRATION_UNITS[1]),
    exactOwnedKoreanEvidence([
      '승인되지 않은 결과는 외부로 보내지 않습니다.',
      '운영자가 현재 버전을 승인한 뒤 WordPress 초안을 만듭니다.',
      '재시도해도 실패와 사용자 편집은 보존합니다.',
      '같은 승인 버전은 초안을 중복 생성하지 않습니다.'
    ], DENSE_NARRATION_UNITS[2])
  ];
  const priorCandidate = {
    title: {
      text: '근거와 승인을 지키는 콘텐츠 운영',
      kind: 'factual',
      atomRefs: [DENSE_NARRATION_HANDLES[0]]
    },
    scenes: sourceTexts.map((text, index) => ({
      durationSeconds: DENSE_NARRATION_DURATIONS[index],
      narration: {
        text,
        kind: 'factual',
        atomRefs: [DENSE_NARRATION_HANDLES[index]]
      }
    }))
  };
  const error = issue('CHANNEL_CONSTRAINT_FAILED', '내레이션 밀도 계약을 충족해야 합니다.', 422, {
    affectedSurfacePaths: sourceTexts.map((_, index) => `$.scenes[${index}].narration.text`),
    observed: {
      timingViolations: sourceTexts.map((_, index) => ({
        code: 'NARRATION_DENSITY',
        paths: [`$.scenes[${index}].narration.text`],
        speechUnits: DENSE_NARRATION_UNITS[index],
        speechUnitsPerSecond: DENSE_NARRATION_UNITS[index] / DENSE_NARRATION_DURATIONS[index]
      }))
    },
    allowed: {
      timingConstraints: sourceTexts.map((_, index) => ({
        code: 'NARRATION_DENSITY',
        paths: [`$.scenes[${index}].narration.text`],
        maximumSpeechUnits: DENSE_NARRATION_BUDGETS[index],
        maximumSpeechUnitsPerSecond: 6,
        fixedDurationSeconds: DENSE_NARRATION_DURATIONS[index],
        preserveSourceHandles: [DENSE_NARRATION_HANDLES[index]]
      }))
    }
  });
  return {
    priorCandidate,
    error,
    originalContract: {
      contractVersion: 'visible-text-platform-draft.v2',
      sourceAtoms: sourceTexts.map((text, index) => ({
        handle: DENSE_NARRATION_HANDLES[index],
        text
      }))
    }
  };
}

test('evidence plans accept only allowlisted source handles and preserve partial readiness', () => {
  const prompt = evidencePlanPrompt({
    purpose: '출시 정보 안내',
    atoms,
    sourceAssessment: { readiness: 'partial', omissions: ['SOURCE_DESCRIPTION_APPEARS_PARTIAL'], signals: [] },
    profile: { channel: 'naver_blog' }
  });
  assert.match(prompt, /UNTRUSTED_SOURCE_DATA|untrusted source data/i);
  const plan = validateEvidencePlan({
    readiness: 'complete',
    supportedPurpose: '공개된 출시 정보 안내',
    reasons: ['출시일은 명시됨'],
    missingInformation: ['세부 기능'],
    selectedSourceHandles: ['본문 1 · 문장 1'],
    contentBudget: { maximumClaims: 4, rationale: '근거 범위만 사용' }
  }, { atoms, sourceAssessment: { readiness: 'partial' } });
  assert.equal(plan.readiness, 'partial');
  assert.deepEqual(plan.selectedAtomIds, ['atom-1']);
  assert.equal(plan.contentBudget.maximumClaims, 4);
  assert.throws(() => validateEvidencePlan({
    readiness: 'complete',
    selectedSourceHandles: ['내부에서 만든 위치']
  }, { atoms, sourceAssessment: { readiness: 'complete' } }), { code: 'EVALUATOR_CONTRACT_FAILED' });
});

test('multi-source evidence uses qualified handles and always retains primary evidence', () => {
  const multiSourceAtoms = [
    {
      id: 'primary-atom',
      source_key: 'source_1',
      position_label: '본문 1 · 문장 1',
      atom_type: 'claim',
      text: '주 원본 사실'
    },
    {
      id: 'supplemental-atom',
      source_key: 'source_2',
      position_label: '본문 1 · 문장 1',
      atom_type: 'claim',
      text: '보조 원본 사실'
    }
  ];
  const prompt = JSON.parse(evidencePlanPrompt({
    purpose: '두 원본의 범위 안에서 안내',
    atoms: multiSourceAtoms,
    sourceAssessment: { readiness: 'complete', omissions: [], signals: [] },
    profile: { channel: 'naver_blog' }
  }));
  assert.deepEqual(
    prompt.sourceAtoms.map((atom) => atom.handle),
    ['source_1::본문 1 · 문장 1', 'source_2::본문 1 · 문장 1']
  );
  const plan = validateEvidencePlan({
    readiness: 'complete',
    supportedPurpose: '두 원본의 범위 안에서 안내',
    reasons: ['주 원본과 보조 원본을 함께 사용'],
    missingInformation: [],
    selectedSourceHandles: [
      'source_1::본문 1 · 문장 1',
      'source_2::본문 1 · 문장 1'
    ],
    contentBudget: { maximumClaims: 2, rationale: '선택한 근거만 사용' }
  }, {
    atoms: multiSourceAtoms,
    sourceAssessment: { readiness: 'complete' }
  });
  assert.deepEqual(plan.selectedAtomIds, ['primary-atom', 'supplemental-atom']);
  assert.throws(() => validateEvidencePlan({
    readiness: 'complete',
    supportedPurpose: '보조 원본만 사용',
    selectedSourceHandles: ['source_2::본문 1 · 문장 1'],
    contentBudget: { maximumClaims: 1 }
  }, {
    atoms: multiSourceAtoms,
    sourceAssessment: { readiness: 'complete' }
  }), { code: 'EVALUATOR_CONTRACT_FAILED' });
  assert.throws(() => validateEvidencePlan({
    readiness: 'complete',
    selectedSourceHandles: ['본문 1 · 문장 1']
  }, {
    atoms: multiSourceAtoms,
    sourceAssessment: { readiness: 'complete' }
  }), { code: 'EVALUATOR_CONTRACT_FAILED' });
});

test('deterministic provenance checks reject missing and out-of-plan factual references', () => {
  const findings = commonDeterministicFindings({
    blocks: [
      { key: 'title', surfacePath: '$.title', content: '출시 안내', contentKind: 'factual', refs: [] },
      { key: 'body', surfacePath: '$.body', content: '가격 안내', contentKind: 'factual', refs: ['atom-2'] },
      { key: 'cta', surfacePath: '$.cta', content: '자세히 보기', contentKind: 'editorial', refs: [] }
    ]
  }, { selectedAtomIds: ['atom-1'] });
  assert.deepEqual(findings.map((finding) => finding.code), ['FACTUAL_PROVENANCE_REQUIRED', 'FACTUAL_PROVENANCE_REQUIRED']);
});

test('the evaluator contract covers every factual block and never becomes human verification', () => {
  const structured = {
    blocks: [
      { key: 'title', contentKind: 'factual', refs: ['atom-1'] },
      { key: 'cta', contentKind: 'editorial' }
    ]
  };
  const result = validateEvaluatorResult({
    purposeFit: 'supported',
    purposeReason: '목적과 근거가 일치함',
    blocks: [{
      blockKey: 'title',
      verdict: 'insufficient',
      claims: [{ claim: '효과가 크다', verdict: 'insufficient', sourceHandles: ['본문 1 · 문장 1'], reason: '효과 근거가 없음' }]
    }],
    allVisibleBlocksReviewed: true,
    creatorIdentityClaims: [],
    platformChecks: [{ code: 'TITLE_PURPOSE_FIT', passed: true, reason: '일치함' }]
  }, structured, {
    rubric: [{ key: 'TITLE_PURPOSE_FIT' }],
    atoms
  });
  const findings = semanticFindings(result, []);
  assert.equal(result.blocks[0].verdict, 'insufficient');
  assert.equal(findings[0].code, 'UNSUPPORTED_FACTUAL_CLAIM');
  assert.equal(Object.hasOwn(result, 'humanVerified'), false);
  assert.throws(() => validateEvaluatorResult({
    purposeFit: 'supported',
    blocks: [],
    allVisibleBlocksReviewed: true,
    creatorIdentityClaims: [],
    platformChecks: []
  }, structured, { rubric: [{ key: 'TITLE_PURPOSE_FIT' }], atoms }), { code: 'EVALUATOR_CONTRACT_FAILED' });
});

test('evaluator block-set failures expose one aggregate bounded-repair surface', () => {
  const structured = {
    blocks: [
      { key: 'title', contentKind: 'factual', refs: ['atom-1'] },
      { key: 'body', contentKind: 'factual', refs: ['atom-2'] },
      { key: 'cta', contentKind: 'editorial', refs: [] }
    ]
  };
  let failure;
  try {
    validateEvaluatorResult({
      purposeFit: 'supported',
      blocks: [
        { blockKey: 'title', claims: [] },
        { blockKey: 'cta', claims: [] }
      ],
      allVisibleBlocksReviewed: true,
      creatorIdentityClaims: [],
      platformChecks: []
    }, structured, { atoms });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'EVALUATOR_CONTRACT_FAILED');
  assert.deepEqual(failure.meta.affectedSurfacePaths, ['$.blocks']);
  assert.deepEqual(failure.meta.observed.invalidBlockKeys, ['cta']);
  assert.deepEqual(failure.meta.observed.missingBlockKeys, ['body']);
  assert.deepEqual(failure.meta.allowed.blockKeys, ['title', 'body']);
});

test('bounded repair cannot alter blocks that already passed', () => {
  const previous = { blocks: [
    { key: 'a', content: '유지', contentKind: 'factual', refs: ['atom-1'] },
    { key: 'b', content: '수정 전', contentKind: 'factual', refs: ['atom-2'] }
  ] };
  const valid = { blocks: [
    { key: 'a', content: '유지', contentKind: 'factual', refs: ['atom-1'] },
    { key: 'b', content: '수정 후', contentKind: 'factual', refs: ['atom-2'] }
  ] };
  assert.doesNotThrow(() => assertRepairScope(previous, valid, ['b']));
  const invalid = structuredClone(valid);
  invalid.blocks[0].content = '몰래 변경';
  assert.throws(() => assertRepairScope(previous, invalid, ['b']), { code: 'QUALITY_REPAIR_SCOPE_VIOLATION' });
  assert.equal(evaluatorAssurance('same', 'same'), 'LOW_ASSURANCE');
  assert.equal(evaluatorAssurance('generator', 'evaluator'), 'HIGH_ASSURANCE');
});

test('semantic repair uses persisted block surface paths and never asks for a complete candidate rewrite', () => {
  const priorCandidate = {
    title: { text: '근거보다 넓은 제목', kind: 'factual', atomRefs: ['본문 1 · 문장 1'] },
    intro: { text: '통과한 도입', kind: 'factual', atomRefs: ['본문 2 · 문장 1'] }
  };
  const plan = boundedQualityRepairPlan({
    originalContract: JSON.stringify({
      task: 'PLATFORM_DRAFT',
      sourceAtoms: atoms.map((atom) => ({ handle: atom.position_label, text: atom.text }))
    }),
    priorCandidate,
    structured: {
      blocks: [
        { key: 'title', surfacePath: '$.title' },
        { key: 'intro', surfacePath: '$.intro' }
      ]
    },
    findings: [{
      code: 'UNSUPPORTED_FACTUAL_CLAIM',
      severity: 'fail',
      blockKey: 'title',
      message: '원본이 제목의 효과 주장을 뒷받침하지 않습니다.',
      details: {
        failedClaims: [{
          claim: '효과가 크게 증가한다.',
          verdict: 'insufficient',
          sourceHandles: ['본문 1 · 문장 1'],
          reason: '효과 근거가 없다.'
        }]
      }
    }]
  });
  const prompt = JSON.parse(plan.prompt);
  assert.deepEqual(plan.targetBlockKeys, ['title']);
  assert.deepEqual(plan.allowedChangedPaths, ['$.title']);
  assert.equal(prompt.repairMode, 'path_operations');
  assert.equal(prompt.task, 'QUALITY_REPAIR');
  assert.deepEqual(prompt.priorCandidate.affectedValues, [{ path: '$.title', value: priorCandidate.title }]);
  assert.equal(
    prompt.validationFailure.meta.failedChecks[0].details.failedClaims[0].claim,
    '효과가 크게 증가한다.'
  );
  assert.equal(Object.hasOwn(prompt, 'currentCandidate'), false);
});

test('contract repair includes the prior candidate and permits only validator-identified surfaces', () => {
  const previous = {
    title: { text: '유지할 제목', kind: 'factual', atomRefs: ['본문 1 · 문장 1'] },
    slides: [{
      headline: { text: '유지할 제목', kind: 'factual', atomRefs: ['본문 1 · 문장 1'] },
      visualDirection: { text: '선형 도식', kind: 'factual', atomRefs: ['본문 1 · 문장 1'] }
    }]
  };
  const validationError = issue('CHANNEL_CONSTRAINT_FAILED', '시각 지시는 production이어야 합니다.', 422, {
    path: '$.slides[0].visualDirection.kind',
    affectedSurfacePaths: [
      '$.slides[0].visualDirection.kind',
      '$.slides[0].visualDirection.atomRefs'
    ],
    expectedKind: 'production',
    allowed: {
      valuesByPath: [{
        paths: ['$.slides[0].visualDirection.atomRefs'],
        value: { atomRefs: ['본문 1 · 문장 1'] }
      }]
    }
  });
  const prompt = JSON.parse(boundedContractRepairPrompt({
    task: 'PLATFORM_DRAFT_SCHEMA_REPAIR',
    originalContract: JSON.stringify({
      contractVersion: 'visible-text-platform-draft.v2',
      generationConstraints: {
        firstSceneDurationSeconds: { maximum: 2 },
        narrationDensity: { maximumSpeechUnitsPerSecond: 6 }
      }
    }),
    priorCandidate: previous,
    error: validationError
  }));
  assert.match(prompt.priorCandidate.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(prompt.priorCandidate.affectedValues, [
    { path: '$.slides[0].visualDirection.kind', value: 'factual' },
    { path: '$.slides[0].visualDirection.atomRefs', value: ['본문 1 · 문장 1'] }
  ]);
  assert.equal(prompt.validationFailure.code, 'CHANNEL_CONSTRAINT_FAILED');
  assert.equal(prompt.originalContract.generationConstraints.firstSceneDurationSeconds.maximum, 2);
  assert.deepEqual(
    prompt.validationFailure.meta.allowed.valuesByPath[0].value.atomRefs,
    ['본문 1 · 문장 1']
  );
  assert.equal(JSON.stringify(prompt).includes('[depth-limited]'), false);
  assert.deepEqual(prompt.allowedChangedPaths, [
    '$.slides[0].visualDirection.kind',
    '$.slides[0].visualDirection.atomRefs'
  ]);

  const repaired = structuredClone(previous);
  repaired.slides[0].visualDirection.kind = 'production';
  repaired.slides[0].visualDirection.atomRefs = [];
  assert.doesNotThrow(() => assertBoundedCandidateRepair(previous, repaired, prompt.allowedChangedPaths));

  const unrelated = structuredClone(repaired);
  unrelated.slides[0].headline.text = '몰래 바꾼 제목';
  assert.throws(
    () => assertBoundedCandidateRepair(previous, unrelated, prompt.allowedChangedPaths),
    { code: 'QUALITY_REPAIR_SCOPE_VIOLATION' }
  );
});

test('wildcard repair paths allow aggregate duration repair without permitting narration rewrites', () => {
  const previous = {
    scenes: [
      { durationSeconds: 1, narration: { text: '첫 장면' } },
      { durationSeconds: 2, narration: { text: '둘째 장면' } }
    ]
  };
  const repaired = structuredClone(previous);
  repaired.scenes[0].durationSeconds = 2;
  repaired.scenes[1].durationSeconds = 10;
  assert.doesNotThrow(() => assertBoundedCandidateRepair(previous, repaired, ['$.scenes[*].durationSeconds']));
  repaired.scenes[1].narration.text = '내용까지 바꿈';
  assert.throws(
    () => assertBoundedCandidateRepair(previous, repaired, ['$.scenes[*].durationSeconds']),
    { code: 'QUALITY_REPAIR_SCOPE_VIOLATION' }
  );
});

test('density contract repair exposes only server-certified candidate IDs to the Provider', () => {
  const previous = {
    scenes: [{
      durationSeconds: 2,
      narration: {
        text: '원본 관계를 보존합니다 불필요하게 길게 설명합니다',
        kind: 'factual',
        atomRefs: ['source_1::본문 1 · 문장 1']
      }
    }]
  };
  const validationError = issue('CHANNEL_CONSTRAINT_FAILED', '내레이션 밀도 계약을 충족해야 합니다.', 422, {
    affectedSurfacePaths: ['$.scenes[0].narration.text'],
    observed: {
      timingViolations: [{
        code: 'NARRATION_DENSITY',
        paths: ['$.scenes[0].narration.text'],
        speechUnits: 29,
        speechUnitsPerSecond: 14.5
      }]
    },
    allowed: {
      timingConstraints: [{
        code: 'NARRATION_DENSITY',
        paths: ['$.scenes[0].narration.text'],
        maximumSpeechUnits: 12,
        maximumSpeechUnitsPerSecond: 6,
        fixedDurationSeconds: 2,
        preserveSourceHandles: ['source_1::본문 1 · 문장 1']
      }]
    }
  });
  const prompt = JSON.parse(boundedContractRepairPrompt({
    task: 'PLATFORM_DRAFT_SCHEMA_REPAIR',
    originalContract: {
      contractVersion: 'visible-text-platform-draft.v2',
      sourceAtoms: [{
        handle: 'source_1::본문 1 · 문장 1',
        text: '원본 관계를 보존합니다 불필요하게 길게 설명합니다'
      }]
    },
    priorCandidate: previous,
    error: validationError
  }));

  assert.equal(prompt.repairMode, 'server_certified_narration');
  assert.equal(prompt.narrationRepairPlan.contractVersion, 'server-certified-narration.v1');
  assert.deepEqual(prompt.narrationRepairPlan.allowedChangedPaths, ['$.scenes[0].narration']);
  assert.deepEqual(prompt.narrationRepairPlan.slots.map((slot) => ({
    path: slot.path,
    textPath: slot.textPath,
    fixedDurationSeconds: slot.fixedDurationSeconds,
    maximumSpeechUnits: slot.maximumSpeechUnits,
    preserveSourceHandles: slot.preserveSourceHandles
  })), [{
    path: '$.scenes[0].narration',
    textPath: '$.scenes[0].narration.text',
    fixedDurationSeconds: 2,
    maximumSpeechUnits: 12,
    preserveSourceHandles: ['source_1::본문 1 · 문장 1']
  }]);
  assert.ok(prompt.narrationRepairPlan.slots[0].candidates.length > 0);
  assert.ok(prompt.narrationRepairPlan.slots[0].candidates
    .every((candidate) => candidate.speechUnits <= 12));
  assert.match(prompt.rules.join('\n'), /candidateId/u);
  assert.deepEqual(prompt.outputContract, {
    selections: [{
      path: '$.scenes[0].narration',
      allowedCandidateIds: prompt.narrationRepairPlan.slots[0].candidates
        .map((candidate) => candidate.candidateId)
    }]
  });
  assert.match(prompt.rules.join('\n'), /\$\.narrationRepairPlan\.slots\[0\].*never/u);
  assert.deepEqual(prompt.priorCandidate.affectedValues, [{
    path: '$.scenes[0].narration.text',
    value: previous.scenes[0].narration.text
  }]);

  const selected = prompt.narrationRepairPlan.slots[0].candidates[0];
  const repaired = applyCertifiedNarrationRepair(previous, {
    selections: [{
      path: '$.scenes[0].narration',
      candidateId: selected.candidateId
    }]
  }, prompt.narrationRepairPlan);
  assert.equal(repaired.candidate.scenes[0].narration.text, selected.text);
  assert.equal(repaired.candidate.scenes[0].durationSeconds, 2);
  assert.deepEqual(
    repaired.candidate.scenes[0].narration.atomRefs,
    ['source_1::본문 1 · 문장 1']
  );
  assert.throws(() => applyCertifiedNarrationRepair(previous, {
    selections: [{
      path: '$.narrationRepairPlan.slots[0]',
      candidateId: selected.candidateId
    }]
  }, prompt.narrationRepairPlan), { code: 'QUALITY_REPAIR_SCOPE_VIOLATION' });
});

test('three simultaneous dense narrations use server-certified extractive candidates selected by opaque ID', () => {
  const fixture = denseNarrationRepairFixture();
  const plan = buildCertifiedNarrationRepairPlan(fixture);

  assert.equal(plan.contractVersion, 'server-certified-narration.v1');
  assert.deepEqual(
    plan.slots.map((slot) => slot.path),
    [
      '$.scenes[0].narration',
      '$.scenes[1].narration',
      '$.scenes[2].narration'
    ]
  );
  assert.deepEqual(
    plan.slots.map((slot) => slot.textPath),
    fixture.error.meta.affectedSurfacePaths
  );
  assert.deepEqual(
    plan.slots.map((slot) => slot.fixedDurationSeconds),
    DENSE_NARRATION_DURATIONS
  );
  assert.deepEqual(
    plan.slots.map((slot) => slot.maximumSpeechUnits),
    DENSE_NARRATION_BUDGETS
  );
  assert.deepEqual(
    plan.slots.map((slot) => slot.preserveSourceHandles),
    DENSE_NARRATION_HANDLES.map((handle) => [handle])
  );

  const allCandidateTexts = [];
  for (const [index, slot] of plan.slots.entries()) {
    assert.ok(slot.candidates.length >= 1);
    for (const candidate of slot.candidates) {
      assert.match(candidate.candidateId, /^nc_[a-f0-9]{24}$/u);
      assert.equal(candidate.speechUnits, speechUnits(candidate.text));
      assert.ok(candidate.speechUnits > 0);
      assert.ok(candidate.speechUnits <= DENSE_NARRATION_BUDGETS[index]);
      assert.ok(DENSE_NARRATION_HANDLES.includes(candidate.evidenceHandle));
      assert.deepEqual(candidate.atomRefs, [DENSE_NARRATION_HANDLES[index]]);
      assert.ok(Number.isInteger(candidate.tokenStart) && candidate.tokenStart >= 0);
      assert.ok(Number.isInteger(candidate.tokenEnd) && candidate.tokenEnd >= candidate.tokenStart);
      assert.ok(Number.isFinite(candidate.boundaryScore));
      assert.ok(fixture.originalContract.sourceAtoms[index].text.includes(candidate.text));
      allCandidateTexts.push(candidate.text);
    }
  }
  assert.equal(new Set(allCandidateTexts).size, allCandidateTexts.length);

  const response = {
    selections: plan.slots.map((slot) => ({
      path: slot.path,
      candidateId: slot.candidates[0].candidateId
    }))
  };
  const repaired = applyCertifiedNarrationRepair(fixture.priorCandidate, response, plan);

  assert.deepEqual(
    repaired.candidate.scenes.map((scene) => scene.durationSeconds),
    DENSE_NARRATION_DURATIONS
  );
  assert.deepEqual(
    repaired.selections.map((selection) => selection.origin),
    ['provider_selected', 'provider_selected', 'provider_selected']
  );
  assert.ok(repaired.diagnostics && typeof repaired.diagnostics === 'object');
  repaired.selections.forEach((selection, index) => {
    const selected = plan.slots[index].candidates[0];
    assert.equal(selection.path, plan.slots[index].path);
    assert.equal(selection.candidateId, selected.candidateId);
    assert.equal(selection.speechUnits, selected.speechUnits);
    assert.deepEqual(repaired.candidate.scenes[index].narration, {
      text: selected.text,
      kind: 'factual',
      atomRefs: selected.atomRefs
    });
  });
  assert.deepEqual(
    fixture.priorCandidate.scenes.map((scene) => speechUnits(scene.narration.text)),
    DENSE_NARRATION_UNITS
  );
});

test('unknown narration candidate IDs fall back to the top server-certified candidate', () => {
  const fixture = denseNarrationRepairFixture();
  const plan = buildCertifiedNarrationRepairPlan(fixture);
  const repaired = applyCertifiedNarrationRepair(fixture.priorCandidate, {
    selections: plan.slots.map((slot) => ({
      path: slot.path,
      candidateId: `unknown-${slot.path}`
    }))
  }, plan);

  assert.deepEqual(
    repaired.selections.map((selection) => selection.origin),
    ['server_certified_fallback', 'server_certified_fallback', 'server_certified_fallback']
  );
  repaired.selections.forEach((selection, index) => {
    assert.equal(selection.candidateId, plan.slots[index].candidates[0].candidateId);
    assert.equal(
      repaired.candidate.scenes[index].narration.text,
      plan.slots[index].candidates[0].text
    );
  });
});

test('server-certified narration rejects new handles, duration drift, and out-of-budget plan tampering', () => {
  const fixture = denseNarrationRepairFixture();
  const plan = buildCertifiedNarrationRepairPlan(fixture);
  const response = {
    selections: plan.slots.map((slot) => ({
      path: slot.path,
      candidateId: slot.candidates[0].candidateId
    }))
  };

  const newHandlePlan = structuredClone(plan);
  newHandlePlan.slots[0].candidates[0].atomRefs = ['owned_2::본문 1 · 문장 1'];
  assert.throws(
    () => applyCertifiedNarrationRepair(fixture.priorCandidate, response, newHandlePlan),
    { code: 'NARRATION_DENSITY_CERTIFICATION_INVALID' }
  );

  const changedDuration = structuredClone(fixture.priorCandidate);
  changedDuration.scenes[1].durationSeconds += 1;
  assert.throws(
    () => applyCertifiedNarrationRepair(changedDuration, response, plan),
    { code: 'NARRATION_DENSITY_CERTIFICATION_INVALID' }
  );

  const overBudgetPlan = structuredClone(plan);
  overBudgetPlan.slots[2].maximumSpeechUnits = Math.max(
    1,
    overBudgetPlan.slots[2].candidates[0].speechUnits - 1
  );
  assert.throws(
    () => applyCertifiedNarrationRepair(fixture.priorCandidate, response, overBudgetPlan),
    { code: 'NARRATION_DENSITY_CERTIFICATION_INVALID' }
  );
});

test('server-certified narration fails closed when no whole-token extractive candidate fits', () => {
  const handle = 'owned_1::본문 1 · 문장 1';
  const text = '가'.repeat(30);
  const priorCandidate = {
    scenes: [{
      durationSeconds: 2,
      narration: { text, kind: 'factual', atomRefs: [handle] }
    }]
  };
  const error = issue('CHANNEL_CONSTRAINT_FAILED', '내레이션 밀도 계약을 충족해야 합니다.', 422, {
    affectedSurfacePaths: ['$.scenes[0].narration.text'],
    observed: {
      timingViolations: [{
        code: 'NARRATION_DENSITY',
        paths: ['$.scenes[0].narration.text'],
        speechUnits: 30,
        speechUnitsPerSecond: 15
      }]
    },
    allowed: {
      timingConstraints: [{
        code: 'NARRATION_DENSITY',
        paths: ['$.scenes[0].narration.text'],
        maximumSpeechUnits: 12,
        maximumSpeechUnitsPerSecond: 6,
        fixedDurationSeconds: 2,
        preserveSourceHandles: [handle]
      }]
    }
  });

  const plan = buildCertifiedNarrationRepairPlan({
    priorCandidate,
    error,
    originalContract: {
      contractVersion: 'visible-text-platform-draft.v2',
      sourceAtoms: [{ handle, text }]
    }
  });
  assert.equal(plan.slots[0].candidates.length, 0);
  assert.throws(
    () => applyCertifiedNarrationRepair(priorCandidate, { selections: [] }, plan),
    { code: 'NARRATION_DENSITY_RECOVERY_EXHAUSTED' }
  );
});

test('path-operation repair applies only concrete allowlisted values to the prior candidate', () => {
  const previous = {
    purposeFit: 'supported',
    purposeReason: '유지',
    blocks: [{
      blockKey: 'title',
      verdict: 'supported',
      claims: [{ claim: '사실', verdict: 'insufficient' }]
    }]
  };
  const repaired = applyBoundedCandidateRepair(previous, {
    repairs: [{
      path: '$.blocks[0].claims[0].verdict',
      value: 'supported'
    }]
  }, ['$.blocks[0].claims']);
  assert.equal(repaired.blocks[0].claims[0].verdict, 'supported');
  assert.equal(repaired.blocks[0].blockKey, 'title');
  assert.equal(repaired.purposeReason, '유지');
  assert.equal(previous.blocks[0].claims[0].verdict, 'insufficient');

  assert.throws(() => applyBoundedCandidateRepair(previous, {
    repairs: [{ path: '$.purposeReason', value: '범위 밖 변경' }]
  }, ['$.blocks[0].claims']), { code: 'QUALITY_REPAIR_SCOPE_VIOLATION' });
  assert.throws(() => applyBoundedCandidateRepair(previous, {
    repairs: [{ path: '$.blocks[*].claims', value: [] }]
  }, ['$.blocks[*].claims']), { code: 'QUALITY_REPAIR_SCOPE_VIOLATION' });

  const visible = applyBoundedCandidateRepair({ hook: '문자열 훅' }, {
    repairs: [{
      path: '$.hook',
      value: JSON.stringify({
        text: '문자열 훅',
        kind: 'factual',
        atomRefs: ['본문 1 · 문장 1']
      })
    }]
  }, ['$.hook']);
  assert.deepEqual(visible.hook, {
    text: '문자열 훅',
    kind: 'factual',
    atomRefs: ['본문 1 · 문장 1']
  });
});

test('patch evaluator repair receives the prior candidate and cannot rewrite unrelated evaluation fields', async (t) => {
  const requests = [];
  const invalid = {
    purposeFit: 'supported',
    purposeReason: '원본과 목적이 일치함',
    blocks: [{
      blockKey: 'title',
      verdict: 'supported',
      claims: [{
        claim: '제품은 7월 29일 출시됐다.',
        verdict: 'invalid-canary-verdict',
        sourceHandles: ['본문 1 · 문장 1'],
        reason: '첫 응답의 claim verdict가 계약에 없음'
      }]
    }],
    allVisibleBlocksReviewed: true,
    creatorIdentityClaims: [],
    platformChecks: [{
      code: 'TITLE_PURPOSE_FIT',
      passed: true,
      reason: '제목 목적이 일치함',
      affectedBlockKeys: []
    }]
  };
  const repaired = structuredClone(invalid);
  repaired.blocks[0].claims[0].verdict = 'supported';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'solar-open2',
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify(requests.length === 1
            ? invalid
            : {
              repairs: [{
                path: '$.blocks[0].claims[0].verdict',
                value: 'supported'
              }]
            })
        }
      }]
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const structured = {
    blocks: [{
      key: 'title',
      content: '제품은 7월 29일 출시됐다.',
      contentKind: 'factual',
      refs: ['atom-1']
    }]
  };
  const result = await requestPatchEvaluation({
    providerType: 'solar',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: 'solar-open2',
    secret: 'test-only',
    capabilities: { structuredOutput: 'json_object' }
  }, {
    prompt: '{"task":"STRICT_PATCH_EVALUATION","outputContract":"evaluator.v2"}',
    structured,
    rubric: [{ key: 'TITLE_PURPOSE_FIT' }],
    atoms,
    config: {
      environment: 'test',
      testMode: true,
      network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
    }
  });

  assert.equal(result.contractAttempt, 1);
  assert.equal(result.evaluation.blocks[0].verdict, 'supported');
  assert.equal(requests.length, 2);
  const repair = JSON.parse(requests[1].messages.at(-1).content);
  assert.equal(repair.task, 'PATCH_EVALUATOR_CONTRACT_REPAIR');
  assert.equal(repair.repairMode, 'path_operations');
  assert.match(repair.priorCandidate.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(repair.priorCandidate.affectedValues, [{
    path: '$.blocks[0].claims[0].verdict',
    value: 'invalid-canary-verdict'
  }]);
  assert.equal(repair.validationFailure.code, 'EVALUATOR_CONTRACT_FAILED');
  assert.deepEqual(repair.allowedChangedPaths, ['$.blocks[0].claims[0].verdict']);

  const unrelated = structuredClone(repaired);
  unrelated.purposeReason = '수정 허용 경로 밖에서 바꿈';
  assert.throws(
    () => assertBoundedCandidateRepair(invalid, unrelated, repair.allowedChangedPaths),
    { code: 'QUALITY_REPAIR_SCOPE_VIOLATION' }
  );
});

test('Solar-compatible JSON object requests always include JSON in messages and persist provider metadata', async (t) => {
  let received;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'solar-open2',
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const completion = await requestCompletion({
    providerType: 'solar',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: 'solar-open2',
    secret: 'test-only',
    capabilities: { structuredOutput: 'json_object' }
  }, {
    messages: [{ role: 'user', content: '구조화된 결과를 반환하세요.' }],
    responseFormat: 'json_object',
    phase: 'canary'
  }, {
    environment: 'test',
    testMode: true,
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  });
  assert.ok(received.messages.some((message) => /\bjson\b/i.test(message.content)));
  assert.deepEqual(received.response_format, { type: 'json_object' });
  assert.equal(completion.model, 'solar-open2');
  assert.equal(completion.finishReason, 'stop');
  assert.equal(completion.phase, 'canary');
});

test('provider connection canary validates the contract and persists honest success and failure state', async (t) => {
  let valid = true;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the request before returning the protocol-compatible response.
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'solar-open2-live-canary',
      choices: [{
        finish_reason: 'stop',
        message: { content: valid ? '{"ok":true}' : '{"ok":false}' }
      }]
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: 'provider-canary@example.test',
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  const secretKey = Buffer.alloc(32, 23).toString('base64');
  const providerId = await saveModelProvider(db, {
    workspaceId,
    userId: user.id,
    name: 'Persisted Solar canary',
    providerType: 'solar',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: 'solar-open2',
    apiKey: 'never-render-this-key',
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
    network: { allowPrivateNetworks: true, allowInsecureCredentialTransport: true }
  };
  const success = await testProvider(db, workspaceId, providerId, config);
  assert.equal(success.ok, true);
  assert.equal(success.responseModel, 'solar-open2-live-canary');
  let persisted = (await db.query(`SELECT last_test_status,last_test_model,last_test_error,last_tested_at
    FROM model_provider_configs WHERE id=$1`, [providerId]))[0];
  assert.equal(persisted.last_test_status, 'succeeded');
  assert.equal(persisted.last_test_model, 'solar-open2-live-canary');
  assert.equal(persisted.last_test_error, null);
  assert.ok(persisted.last_tested_at);

  valid = false;
  await assert.rejects(
    testProvider(db, workspaceId, providerId, config),
    (error) => error.code === 'PROVIDER_CANARY_INVALID'
  );
  persisted = (await db.query(`SELECT last_test_status,last_test_error
    FROM model_provider_configs WHERE id=$1`, [providerId]))[0];
  assert.equal(persisted.last_test_status, 'failed');
  assert.match(persisted.last_test_error, /PROVIDER_CANARY_INVALID/);
  assert.doesNotMatch(persisted.last_test_error, /never-render-this-key/);
});
