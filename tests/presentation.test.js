import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assuranceLabel,
  blockTypeLabel,
  connectorLabel,
  evidencePresentation,
  omissionLabel,
  operationLabel,
  statusPresentation
} from '../apps/web/presentation.js';

function luminance(hex) {
  const values = hex.match(/[a-f\d]{2}/giu).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = values.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('presentation labels never fall through to raw internal identifiers', () => {
  assert.equal(omissionLabel('SOURCE_DESCRIPTION_APPEARS_PARTIAL'), '요약만 수집됨 (본문 미확보)');
  assert.equal(omissionLabel('unknown_internal_enum'), '수집 범위 추가 확인 필요');
  assert.equal(operationLabel('planner_suggestion'), '채널 설정 추천');
  assert.equal(operationLabel('artifact_generation'), '결과물 생성');
  assert.equal(operationLabel('unknown_operation'), '운영 작업');
  assert.equal(blockTypeLabel('paragraph'), '문단');
  assert.equal(blockTypeLabel('not_a_block_type'), '콘텐츠 블록');
  assert.equal(connectorLabel('transcript_upload'), '업로드 전사');
  assert.equal(assuranceLabel('LOW_ASSURANCE'), '생성 Provider와 동일 · 보증 낮음');
  assert.equal(statusPresentation('unknown_status').label, '상태 확인 필요');
  assert.equal(evidencePresentation('unknown_state').label, '근거 상태 확인 필요');
});

test('interactive contrast tokens meet the manual WCAG contracts', async () => {
  const css = await readFile('apps/web/public/app.css', 'utf8');
  for (const token of ['--control-border:#8F8878', '--disabled-surface:#EDEAE3', '--disabled-ink:#55524B']) {
    assert.ok(css.includes(token), `required token missing: ${token}`);
  }
  assert.ok(contrast('8F8878', 'FFFFFF') >= 3);
  assert.ok(contrast('8F8878', 'FAF9F6') >= 3);
  assert.ok(contrast('8F8878', 'F6F4EF') >= 3);
  assert.ok(contrast('55524B', 'EDEAE3') >= 4.5);
});
