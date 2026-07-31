import express from 'express';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPostgresDatabase, readiness } from '../shared/db.js';
import { asPublicError, issue } from '../shared/errors.js';
import { authenticate, bootstrapAdministrator, cookieOptions, login, logout, requireRole } from '../shared/auth.js';
import { assertSameOrigin, redact } from '../shared/security.js';
import { registerRssSource, retryFailedSourceImpact } from '../shared/rss.js';
import {
  registerTranscriptUpload,
  registerYouTubeMetadata,
  requestConnectorSync
} from '../shared/connectors.js';
import { bootstrapUpstageSolarProvider, saveAudiencePersona, saveCreatorIdentity, saveCreatorVoice, saveModelProvider, testProvider } from '../shared/intelligence.js';
import { activeChannelCatalog, channelName, setChannelActive, workspaceChannelCatalog } from '../shared/channels.js';
import { createPlan, retryPlanOutput } from '../shared/planner.js';
import {
  getPlannerSuggestion,
  requestPlannerSuggestion,
  retryPlannerSuggestion,
  sourceSelectionsFromPlannerSuggestion
} from '../shared/planner-suggestions.js';
import {
  addArtifactComment,
  approveArtifact,
  editArtifactBlock,
  getArtifactReview,
  requestRegeneration,
  resolveArtifactComment,
  setBlockConflict,
  setBlockHold,
  verifyBlock
} from '../shared/review.js';
import { recordRefreshDecision } from '../shared/freshness.js';
import { exportMarkdown, exportWordPressDraft } from '../shared/export.js';
import { parseJson } from '../shared/ids.js';
import { requestSourceReadinessReassessment } from '../shared/source-reassessment.js';
import { inboxSortOptions, resolveInboxSort } from './inbox-sort.js';
import {
  assuranceLabel,
  blockTypeLabel,
  bodyKindLabel,
  connectorLabel,
  evidencePresentation,
  iconSvg,
  omissionLabel,
  operationLabel,
  readinessLabel,
  rightsLabel,
  statusLabel,
  statusPresentation
} from './presentation.js';

const here = dirname(fileURLToPath(import.meta.url));
const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const cookieValue = (header, name) => String(header || '').split(';').map((part) => part.trim().split('=')) .find(([key]) => key === name)?.slice(1).join('=');
const generationRunTypes = new Set(['artifact_generation', 'artifact_generation_retry']);
const bool = (value) => value === true || value === 'true' || value === 'on' || value === '1';
const stringList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])
  .map((entry) => String(entry || '').trim())
  .filter(Boolean);
const displayList = (value) => parseJson(value, []).map((entry) => omissionLabel(entry));

function requiredRightsStatus(value) {
  const rightsStatus = String(value || '').trim().toLowerCase();
  if (!['owned', 'licensed', 'unknown', 'restricted'].includes(rightsStatus)) {
    throw issue('RIGHTS_STATUS_REQUIRED', '사용 권리를 선택하세요.', 422);
  }
  return rightsStatus;
}

function rightsOptions() {
  return '<option value="" selected disabled>사용 권리를 선택하세요</option><option value="owned">직접 보유한 원본</option><option value="licensed">사용 허가를 받은 원본</option><option value="unknown">아직 확인하지 못함</option><option value="restricted">파생 콘텐츠 사용 제한</option>';
}

function safeHttpHref(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function safeBackPath(req) {
  const host = req.get('host');
  const referer = req.get('referer');
  if (!host || !referer) return '/app/inbox';
  try {
    const url = new URL(referer, `http://${host}`);
    if (url.host !== host || !url.pathname.startsWith('/app/')) return '/app/inbox';
    return `${url.pathname}${url.search}`;
  } catch {
    return '/app/inbox';
  }
}

function isPrivateClientAddress(address) {
  const input = String(address || '').toLowerCase();
  const value = input.startsWith('::ffff:') ? input.slice(7) : input;
  if (value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function isAllowedInternalHost(host) {
  const input = String(host || '').trim().toLowerCase();
  const bracketed = input.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/u);
  const plain = input.match(/^([^:\s/?#]+)(?::(\d+))?$/u);
  const match = bracketed || plain;
  if (!match) return false;
  const hostname = match[1];
  const port = match[2];
  if (port && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535)) return false;
  if (hostname === 'localhost') return true;
  return net.isIP(hostname) > 0 && isPrivateClientAddress(hostname);
}

const settingLabels = Object.freeze({
  purpose: '목적',
  keyword: '핵심 키워드',
  readingTone: '읽기 톤',
  includeFaq: 'FAQ 포함',
  angle: '편집 각도',
  cadence: '발송 주기',
  includePreamble: '프리헤더 포함',
  slideCount: '슬라이드 수',
  visualDirection: '시각 방향',
  targetSeconds: '목표 길이(초)',
  visualStyle: '시각 스타일',
  includeCaptions: '게시 캡션 포함'
});

function settingControl(definition, key, schema) {
  const name = `channel_${definition.channel}_${key}`;
  const label = schema.title || settingLabels[key] || key;
  const help = schema.description ? `<small>${escape(schema.description)}</small>` : '';
  const defaults = definition.default_settings && typeof definition.default_settings === 'object'
    ? definition.default_settings
    : {};
  const defaultValue = defaults[key] ?? schema.default;
  const required = definition.profile.settingsSchema.required?.includes(key);
  if (schema.type === 'boolean') {
    return `<label><input type="checkbox" name="${escape(name)}" value="true" data-setting-key="${escape(key)}" ${defaultValue === true ? 'checked' : ''}> ${escape(label)}${help}</label>`;
  }
  if (schema.type === 'integer') {
    return `<label>${escape(label)}<input name="${escape(name)}" type="number" data-setting-key="${escape(key)}" ${schema.minimum != null ? `min="${Number(schema.minimum)}"` : ''} ${schema.maximum != null ? `max="${Number(schema.maximum)}"` : ''} ${defaultValue != null ? `value="${Number(defaultValue)}"` : ''} ${required ? 'required' : ''}>${help}</label>`;
  }
  if (schema.type === 'string' && Array.isArray(schema.enum)) {
    return `<label>${escape(label)}<select name="${escape(name)}" data-setting-key="${escape(key)}" ${required ? 'required' : ''}>${schema.enum.map((value) => `<option value="${escape(value)}" ${value === defaultValue ? 'selected' : ''}>${escape(value)}</option>`).join('')}</select>${help}</label>`;
  }
  return `<label>${escape(label)}<input name="${escape(name)}" data-setting-key="${escape(key)}" ${schema.maxLength != null ? `maxlength="${Number(schema.maxLength)}"` : ''} ${schema.minLength != null ? `minlength="${Number(schema.minLength)}"` : ''} ${defaultValue != null ? `value="${escape(defaultValue)}"` : ''} ${key === 'purpose' ? `placeholder="${escape(schema.description || definition.description)}" data-purpose-setting` : ''} ${required ? 'required' : ''}>${help}</label>`;
}

function plannerOutputHint(definition) {
  // This is derived from the persisted profile contract, rather than a list of
  // branded channel names. A new profile gets a truthful visual affordance as
  // long as it declares its primary output mode.
  const mode = String(definition.profile?.renderMetadata?.primary_mode || 'document');
  const hints = {
    carousel: ['카드 흐름', '<i></i><i></i><i></i>'],
    vertical_video: ['세로 영상', '<i></i><b></b><i></i>'],
    article: ['문서 구조', '<b></b><i></i><i></i>'],
    email: ['메일 모듈', '<b></b><i></i><i></i>'],
    document: ['문서 구조', '<b></b><i></i><i></i>']
  };
  const [label, marks] = hints[mode] || hints.document;
  return `<span class="channel-output-hint" data-output-mode="${escape(mode)}" aria-hidden="true"><span>${marks}</span><small>${escape(label)}</small></span>`;
}

export function channelPlannerFieldset(definition) {
  const schema = definition.profile?.settingsSchema;
  if (!schema?.properties) throw issue('INVALID_PLATFORM_PROFILE', '계획 화면에 표시할 채널 설정 계약이 없습니다.', 500);
  const controls = Object.entries(schema.properties)
    .map(([key, propertySchema]) => settingControl(definition, key, propertySchema))
    .join('');
  const rubric = definition.profile.rubric.map((entry) => entry.label).join(' · ');
  return `<fieldset class="channel-card" data-platform-profile="${escape(definition.id)}" data-channel="${escape(definition.channel)}"><legend><label><input type="checkbox" name="channel_${escape(definition.channel)}_selected" value="${escape(definition.id)}"> ${escape(definition.display_name)}</label></legend><div class="channel-card-summary">${plannerOutputHint(definition)}<p>${escape(definition.description)}</p></div><div class="channel-settings" data-channel-settings hidden inert>${controls}<details class="channel-rubric"><summary>검사 기준 ${definition.profile.rubric.length}개</summary><p class="help">${escape(rubric)}</p></details><section class="planner-suggestion-meta" data-suggestion-meta hidden aria-live="polite"></section></div></fieldset>`;
}

export function planOutputsFromRequest(body, catalog) {
  const outputs = [];
  for (const definition of catalog) {
    const selectedField = `channel_${definition.channel}_selected`;
    if (body[selectedField] == null) continue;
    if (Array.isArray(body[selectedField]) || body[selectedField] !== definition.id) {
      throw issue('CHANNEL_PROFILE_VERSION_MISMATCH', '선택한 채널의 Profile 버전이 현재 활성 버전과 다릅니다.', 409, {
        channel: definition.channel
      });
    }
    const settings = {};
    for (const [key, schema] of Object.entries(definition.profile.settingsSchema.properties)) {
      const raw = body[`channel_${definition.channel}_${key}`];
      if (schema.type === 'boolean') settings[key] = bool(raw);
      else if (raw !== undefined && raw !== '') settings[key] = schema.type === 'integer' ? Number(raw) : raw;
    }
    outputs.push({
      type: definition.channel,
      platformProfileVersionId: definition.id,
      settings
    });
  }
  return outputs;
}

function artifactPreview(channel, content, displayName = channelName(channel)) {
  if (channel === 'naver_blog') return `<article class="preview naver-preview"><p class="preview-label">Naver 모바일 문서 초안</p><h3>${escape(content.title)}</h3><p class="lead">${escape(content.intro)}</p>${(content.sections || []).map((section) => `<h4>${escape(section.heading)}</h4><p>${escape(section.body)}</p>`).join('')}${(content.faq || []).length ? `<section class="preview-subsection"><h4>자주 묻는 질문</h4>${content.faq.map((row) => `<h5>${escape(row.question)}</h5><p>${escape(row.answer)}</p>`).join('')}</section>` : ''}${content.cta ? `<p class="preview-cta">${escape(content.cta)}</p>` : ''}${content.tags?.length ? `<p class="tag-line">${content.tags.map((tag) => `#${escape(tag)}`).join(' ')}</p>` : ''}</article>`;
  if (channel === 'wordpress_article') return `<article class="preview article-preview"><p class="preview-label">WordPress 블록 편집기 초안</p><h3>${escape(content.title)}</h3><p class="excerpt">발췌 · ${escape(content.excerpt)}</p><p>${escape(content.intro)}</p>${(content.sections || []).map((section) => `${section.headingLevel === 3 ? `<h5>${escape(section.heading)}</h5>` : `<h4>${escape(section.heading)}</h4>`}<p>${escape(section.body)}</p>`).join('')}${(content.faq || []).map((row) => `<h4>${escape(row.question)}</h4><p>${escape(row.answer)}</p>`).join('')}${content.cta ? `<p class="preview-cta">${escape(content.cta)}</p>` : ''}${content.imageAltGuidance ? `<aside class="visual-note">이미지 대체 텍스트 제작 지침 · ${escape(content.imageAltGuidance)}</aside>` : ''}</article>`;
  if (channel === 'newsletter') return `<article class="preview newsletter-preview"><p class="preview-label">Newsletter inbox·본문 초안</p><div class="inbox-row" aria-label="받은 편지함 미리보기"><strong>${escape(content.subject)}</strong><span>${escape(content.preheader || '프리헤더를 사용하지 않음')}</span></div><p class="lead">${escape(content.opening)}</p>${(content.modules || []).map((module) => `<section><h4>${escape(module.heading)}</h4><p>${escape(module.body)}</p></section>`).join('')}${content.cta ? `<p class="preview-cta">${escape(content.cta)}</p>` : ''}<details><summary>Plain text·이미지 끔 상태 확인</summary><pre>${escape(content.plainText || '')}</pre></details></article>`;
  if (channel === 'instagram_carousel') return `<article class="preview carousel-preview"><p class="preview-label">Instagram Carousel 4:5 crop 초안</p><section class="carousel-cover"><small>커버</small><h3>${escape(content.coverHook)}</h3></section><div class="carousel-slides">${(content.slides || []).map((slide, index) => `<section><small>슬라이드 ${index + 1}</small><h4>${escape(slide.headline)}</h4><p>${escape(slide.body)}</p><p class="visual-note">시각 제작 · ${escape(slide.visualDirection)}</p><p class="alt-note">대체 텍스트 · ${escape(slide.altText)}</p></section>`).join('')}</div><h4>게시 캡션</h4><p>${escape(content.caption || '')}</p>${content.hashtags?.length ? `<p class="tag-line">${content.hashtags.map((tag) => `#${escape(tag)}`).join(' ')}</p>` : ''}</article>`;
  const timeline = (content.scenes || []).map((scene, index) => `<section><h4>장면 ${index + 1} · ${scene.startSeconds ?? 0}–${scene.endSeconds ?? scene.durationSeconds}초</h4><p><b>화면 제작</b> ${escape(scene.visualDirection || scene.visual)}</p><p><b>UI safe zone</b> ${escape(scene.safeZoneNote || '검토 필요')}</p><p><b>화면 자막</b> ${escape(scene.onScreenText || '없음')}</p><p><b>내레이션</b> ${escape(scene.narration)}</p></section>`).join('');
  if (channel === 'youtube_shorts') return `<article class="preview short-preview youtube-preview"><p class="preview-label">YouTube Shorts 검색·재생 초안 · 9:16</p><div class="video-title-row"><span>동영상 제목</span><h3>${escape(content.title || '')}</h3></div><p class="hook-window"><b>첫 2초 검색 훅</b> ${escape(content.hook)}</p>${timeline}<p><b>독립적 결론</b> ${escape(content.ending)}</p>${content.coverText ? `<p><b>Shorts 커버 문구</b> ${escape(content.coverText)}</p>` : ''}${content.caption ? `<p><b>설명</b> ${escape(content.caption)}</p>` : ''}</article>`;
  if (channel === 'instagram_reels') return `<article class="preview short-preview reels-preview"><p class="preview-label">Instagram Reels 피드·프로필 crop 초안 · 9:16</p><div class="reels-cover"><small>프로필 그리드 커버</small><h3>${escape(content.coverText || content.title || '')}</h3></div><p class="hook-window"><b>첫 2초 시각 훅</b> ${escape(content.hook)}</p>${timeline}<p><b>저장·공유 마무리</b> ${escape(content.ending)}</p>${content.caption ? `<p><b>Reels 캡션</b> ${escape(content.caption)}</p>` : ''}</article>`;
  if (channel === 'tiktok_video') return `<article class="preview short-preview tiktok-preview"><p class="preview-label">TikTok For You·댓글 대화 초안 · 9:16</p><p class="hook-window"><b>첫 3초 전제·payoff</b> ${escape(content.hook)}</p>${timeline}<p><b>댓글 대화 마무리</b> ${escape(content.ending)}</p>${content.coverText ? `<p><b>TikTok 커버</b> ${escape(content.coverText)}</p>` : ''}${content.caption ? `<p><b>게시 캡션</b> ${escape(content.caption)}</p>` : ''}</article>`;
  if (channel === 'short_video') return `<article class="preview short-preview legacy-short-preview"><p class="preview-label">이전 버전 Short Video Script · 기록 전용</p><p class="notice warning">이 결과물은 기존 v1 기록입니다. 새 계획에서는 선택할 수 없으며, 현재 저장된 구조 그대로 검토할 수 있습니다.</p><p><b>훅</b> ${escape(content.hook || '')}</p>${timeline}<p><b>마무리</b> ${escape(content.ending || '')}</p>${content.caption ? `<p><b>캡션</b> ${escape(content.caption)}</p>` : ''}</article>`;
  if (content?.title && content?.intro && Array.isArray(content.sections)) {
    return `<article class="preview article-preview"><p class="preview-label">${escape(displayName)} 구조화 아티클 초안</p><h3>${escape(content.title)}</h3>${content.excerpt ? `<p class="excerpt">${escape(content.excerpt)}</p>` : ''}<p>${escape(content.intro)}</p>${content.sections.map((section) => `<h4>${escape(section.heading)}</h4><p>${escape(section.body)}</p>`).join('')}${content.cta ? `<p class="preview-cta">${escape(content.cta)}</p>` : ''}</article>`;
  }
  if (content?.subject && content?.opening && Array.isArray(content.modules)) {
    return `<article class="preview newsletter-preview"><p class="preview-label">${escape(displayName)} 메시지 초안</p><div class="inbox-row"><strong>${escape(content.subject)}</strong><span>${escape(content.preheader || '')}</span></div><p>${escape(content.opening)}</p>${content.modules.map((module) => `<section><h4>${escape(module.heading)}</h4><p>${escape(module.body)}</p></section>`).join('')}</article>`;
  }
  if (content?.coverHook && Array.isArray(content.slides)) {
    return `<article class="preview carousel-preview"><p class="preview-label">${escape(displayName)} 카드 시퀀스 초안</p><h3>${escape(content.coverHook)}</h3>${content.slides.map((slide, index) => `<section><small>카드 ${index + 1}</small><h4>${escape(slide.headline)}</h4><p>${escape(slide.body)}</p><p class="visual-note">${escape(slide.visualDirection)}</p></section>`).join('')}</article>`;
  }
  if (content?.hook && Array.isArray(content.scenes)) {
    return `<article class="preview short-preview"><p class="preview-label">${escape(displayName)} 세로 영상 타임라인 초안</p><h3>${escape(content.title || '')}</h3><p class="hook-window"><b>훅</b> ${escape(content.hook)}</p>${timeline}<p><b>마무리</b> ${escape(content.ending || '')}</p></article>`;
  }
  return `<article class="preview"><p class="notice danger">현재 버전의 채널 Preview를 표시할 수 없습니다.</p></article>`;
}

function layout({ user, title, summary = '', current, body, csrf }) {
  const nav = [
    ['inbox', '/app/inbox', '원본 인박스'], ['runs', '/app/runs', '실행 기록'], ['settings', '/app/settings', '설정']
  ].map(([key, href, label]) => `<a class="nav-link ${current === key ? 'active' : ''}" href="${href}">${label}</a>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · OSAU</title><link rel="stylesheet" href="/assets/app.css"></head>
  <body data-csrf="${escape(csrf || '')}"><a class="skip-link" href="#main">본문으로 건너뛰기</a><div class="app-shell"><aside class="sidebar"><a class="brand" href="/app/inbox">OSAU <span>콘텐츠 운영</span></a><nav aria-label="주요 메뉴">${nav}</nav><div class="sidebar-bottom"><span>${escape(user.email)}</span>${user.authDisabled ? '<small>내부 네트워크 운영 모드</small>' : `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escape(csrf)}"><button class="quiet-button" type="submit">로그아웃</button></form>`}</div></aside>
  <main id="main"><header class="page-header"><div><h1>${escape(title)}</h1>${summary ? `<p>${escape(summary)}</p>` : ''}</div></header><div id="flash" aria-live="polite" aria-atomic="true"></div>${body}</main></div><script src="/assets/app.js" defer></script></body></html>`;
}

function badge(status, kind = 'status') {
  const presentation = kind === 'evidence' ? evidencePresentation(status) : statusPresentation(status);
  return `<span class="badge ${kind}-${escape(status)}" data-tone="${escape(presentation.tone)}">${iconSvg(presentation.icon)}<span>${escape(presentation.label)}</span></span>`;
}

function isGenerationRun(run) {
  return generationRunTypes.has(run?.run_type);
}

function generationRunHref(runId) {
  return `/app/runs?run=${encodeURIComponent(String(runId || ''))}#current-generation`;
}

function generationRunLabel(run) {
  return operationLabel(run?.run_type);
}

function targetStatus(target) {
  return target.execution_status || target.output_status || 'queued';
}

function targetDisplayName(target) {
  return target.display_name || channelName(target.output_type);
}

function targetAutomaticStatus(target) {
  if (targetStatus(target) === 'held') return '자동 검사 또는 원본 준비 상태에서 보류되었습니다. 승인할 수 없습니다.';
  if (targetStatus(target) === 'failed') return '생성에 실패했습니다. 이전 결과물과 실패 기록은 유지됩니다.';
  if (['queued', 'running'].includes(targetStatus(target))) return '실제 Provider 작업이 진행 중입니다. 완료되면 검토 시작을 표시합니다.';
  if (target.artifact_state === 'stale') return '자동 검사 결과는 저장됐지만 원본이 변경되어 다시 확인해야 합니다.';
  const partial = target.execution_readiness_state === 'partial' || target.quality_status === 'warning';
  return partial
    ? '부분 원본 경고 · 자동 검사 완료 · 사람 확인 필요'
    : '자동 검사 완료 · 사람 확인 필요';
}

function targetReviewAction(target, { primary = false } = {}) {
  const status = targetStatus(target);
  const displayName = targetDisplayName(target);
  if ((status === 'succeeded' || status === 'held') && target.artifact_id) {
    const label = primary
      ? 'Review Workbench에서 검토 시작'
      : `${displayName} ${status === 'held' ? '보류 사유 검토' : '검토 시작'}`;
    return `<a class="button ${primary ? 'primary' : 'secondary compact'}" href="/app/review/${escape(target.artifact_id)}">${escape(label)}</a>`;
  }
  return '';
}

async function loadGenerationRunTargets(db, workspaceId, runIds) {
  if (!runIds.length) return [];
  return db.query(`WITH target_outputs AS (
      SELECT execution.run_id, execution.plan_output_id
      FROM generation_executions execution
      JOIN runs run ON run.id=execution.run_id
      WHERE run.workspace_id=$1 AND execution.run_id=ANY($2::text[])
      UNION
      SELECT event.payload->>'runId' AS run_id,event.payload->>'planOutputId' AS plan_output_id
      FROM outbox_events event
      JOIN runs run ON run.id=event.payload->>'runId'
      WHERE run.workspace_id=$1
        AND event.payload->>'runId'=ANY($2::text[])
        AND event.payload->>'planOutputId' IS NOT NULL
        AND event.event_type='generate_plan_output'
    )
    SELECT target.run_id,output.id AS output_id,output.output_type,
      output.status AS output_status,output.quality_status,output.error_message,
      definition.display_name,execution.status AS execution_status,
      execution.readiness_state AS execution_readiness_state,
      produced_artifact.id AS artifact_id,produced_artifact.state AS artifact_state
    FROM target_outputs target
    JOIN runs run ON run.id=target.run_id AND run.workspace_id=$1
    JOIN plan_outputs output ON output.id=target.plan_output_id
    JOIN plans plan ON plan.id=output.plan_id AND plan.workspace_id=$1
    JOIN channel_definition_versions definition ON definition.id=output.channel_definition_version_id
    LEFT JOIN generation_executions execution
      ON execution.run_id=target.run_id AND execution.plan_output_id=output.id
    LEFT JOIN artifact_versions produced_version ON produced_version.id=execution.artifact_version_id
    LEFT JOIN artifacts produced_artifact
      ON produced_artifact.id=produced_version.artifact_id AND produced_artifact.workspace_id=$1
    ORDER BY run.created_at DESC,definition.display_name,output.id`, [workspaceId, runIds]);
}

function runTargetsByRun(targets) {
  const byRun = new Map();
  for (const target of targets) {
    const rows = byRun.get(target.run_id) || [];
    rows.push(target);
    byRun.set(target.run_id, rows);
  }
  return byRun;
}

function runStateCopy(run, targets) {
  const statuses = targets.map(targetStatus);
  const active = statuses.filter((status) => ['queued', 'running'].includes(status)).length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const held = statuses.filter((status) => status === 'held').length;
  const succeeded = statuses.filter((status) => status === 'succeeded').length;
  if (!targets.length) return '이 실행의 대상 결과물을 불러오지 못했습니다. 실행 이력은 유지됩니다.';
  if (active) return `${targets.length}개 선택 결과물 중 ${active}개를 실제 Provider가 생성하고 있습니다.`;
  if (failed) return `${targets.length}개 선택 결과물 중 ${failed}개 생성에 실패했습니다. 실패 기록은 유지되며 재시도할 수 있습니다.`;
  if (held) return `${targets.length}개 선택 결과물 중 ${held}개가 보류되었습니다. 보류 이유를 검토한 뒤 다음 결정을 기록하세요.`;
  if (succeeded === targets.length) return `${targets.length}개 선택 결과물이 자동 검사와 함께 저장되었습니다. 사람 확인과 승인은 아직 별도입니다.`;
  return `${generationRunLabel(run)} 상태를 확인하세요.`;
}

function selectedGenerationSummary(run, targets) {
  if (!run) return '';
  const completedTargets = targets.filter((target) => targetStatus(target) === 'succeeded' && target.artifact_id);
  const singlePrimary = completedTargets.length === 1 && targets.length === 1
    ? targetReviewAction(completedTargets[0], { primary: true })
    : '';
  const outputRows = targets.length
    ? `<ul class="run-completion-list">${targets.map((target) => {
      const status = targetStatus(target);
      const usesPrimaryAction = Boolean(singlePrimary && target === completedTargets[0]);
      const action = usesPrimaryAction
        ? ''
        : targetReviewAction(target);
      const fallback = usesPrimaryAction
        ? '<span class="help">위의 검토 시작으로 결과물과 원본 근거를 확인하세요.</span>'
        : !action && status === 'failed'
        ? '<a class="button secondary compact" href="#generation-outputs">실패한 결과물 다시 확인</a>'
        : !action && ['queued', 'running'].includes(status)
          ? '<span class="help">생성이 끝나면 실제 검토 동작이 표시됩니다.</span>'
          : !action && status === 'succeeded'
            ? '<span class="error-text">저장된 결과물 연결을 확인해야 합니다.</span>'
            : '';
      return `<li class="run-completion-output"><div><h3>${escape(targetDisplayName(target))}</h3><p>${badge(status)}${target.artifact_state ? ` ${badge(target.artifact_state)}` : ''}</p><p>${escape(targetAutomaticStatus(target))}</p>${target.error_message ? `<p class="error-text">${escape(target.error_message)}</p>` : ''}</div><div class="run-completion-actions">${action || fallback}</div></li>`;
    }).join('')}</ul>`
    : '<p class="help">이전 실행이라 대상 결과물 상세가 남아 있지 않습니다. 실행 이력은 유지됩니다.</p>';
  return `<section id="current-generation" class="run-completion" data-run-completion="${escape(run.status)}" aria-labelledby="current-generation-title"><div class="run-completion-header"><div><h2 id="current-generation-title">${escape(run.run_type === 'artifact_generation_retry' ? '재시도 생성 결과' : '이번 생성')}</h2><p>${escape(runStateCopy(run, targets))}</p></div>${singlePrimary}</div>${outputRows}</section>`;
}

function generationRunNextAction(run, targets) {
  if (!isGenerationRun(run)) return run.status === 'failed'
    ? '실패 기록을 확인하고 복구 가능한 작업을 다시 시작하세요.'
    : '기록 유지';
  const statuses = targets.map(targetStatus);
  const completedTargets = targets.filter((target) => targetStatus(target) === 'succeeded' && target.artifact_id);
  if (completedTargets.length === 1 && targets.length === 1) {
    return `${targetReviewAction(completedTargets[0], { primary: false })}<small>${escape(targetAutomaticStatus(completedTargets[0]))}</small>`;
  }
  if (completedTargets.length > 1) {
    return `<a class="button secondary compact" href="${escape(generationRunHref(run.id))}">생성 결과 ${completedTargets.length}개 확인</a><small>자동 검사 완료 · 사람 확인 필요</small>`;
  }
  if (statuses.some((status) => ['queued', 'running'].includes(status))) return '생성 중 · 완료되면 검토 시작을 표시합니다.';
  if (statuses.includes('held')) return `<a class="button secondary compact" href="${escape(generationRunHref(run.id))}">보류 결과 확인</a>`;
  if (statuses.includes('failed') || run.status === 'failed') return '<a class="button secondary compact" href="#generation-outputs">실패한 결과물 재시도</a>';
  return `<a class="button secondary compact" href="${escape(generationRunHref(run.id))}">생성 결과 확인</a>`;
}
function errorPage(error, req) {
  const publicError = asPublicError(error);
  const user = req.user || { email: '알 수 없음' };
  return layout({ user, title: '요청을 완료하지 못했습니다', summary: publicError.code, current: '', csrf: req.user?.csrf, body: `<section class="notice danger"><h2>${escape(publicError.message)}</h2><p>저장된 원본과 이전 작업은 유지됩니다. 입력을 확인한 뒤 다시 시도하세요.</p><a class="button secondary" href="${escape(safeBackPath(req))}">이전 화면으로</a></section>` });
}

export function createApp({ db, config = {} }) {
  if (config.authDisabled && !config.internalNetworkMode) {
    throw issue('AUTH_DISABLED_REQUIRES_INTERNAL_NETWORK_MODE', '로그인 비활성화는 내부 네트워크 모드를 함께 명시한 경우에만 사용할 수 있습니다.', 500);
  }
  if (config.authDisabled && config.internalPeerAddressPreserved === false) {
    throw issue('AUTH_DISABLED_REQUIRES_PRESERVED_CLIENT_IP', '로그인 비활성화는 실제 클라이언트 IP가 소켓 주소로 보존되는 배치에서만 사용할 수 있습니다.', 500);
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((_req, res, next) => {
    res.set({
      'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY'
    });
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/assets', express.static(join(here, 'public'), { maxAge: config.environment === 'production' ? '1h' : 0 }));
  let internalOperator = null;
  app.use(async (req, _res, next) => {
    try {
      if (config.authDisabled) {
        if (!isAllowedInternalHost(req.get('host'))) {
          throw issue('INTERNAL_HOST_REJECTED', '로그인 비활성화 모드는 localhost 또는 사설 IP 주소 Host에서만 접근할 수 있습니다.', 403);
        }
        if (!isPrivateClientAddress(req.socket.remoteAddress)) {
          throw issue('INTERNAL_NETWORK_REQUIRED', '로그인 비활성화 모드는 사설 네트워크 주소에서만 접근할 수 있습니다.', 403);
        }
        internalOperator ||= (await db.query(`SELECT id,workspace_id,email,role
          FROM users WHERE role='administrator' ORDER BY created_at LIMIT 1`))[0] || null;
        if (!internalOperator) throw issue('INTERNAL_OPERATOR_REQUIRED', '내부 운영 모드에 사용할 관리자 계정이 없습니다.', 503);
        req.user = {
          id: internalOperator.id,
          workspaceId: internalOperator.workspace_id,
          email: internalOperator.email,
          role: internalOperator.role,
          csrf: 'internal-network-csrf',
          authDisabled: true
        };
      } else {
        req.user = await authenticate(db, cookieValue(req.headers.cookie, 'osau_session'));
      }
      next();
    } catch (error) { next(error); }
  });

  const protect = (...roles) => (req, _res, next) => { try { requireRole(req.user, ...roles); next(); } catch (error) { next(error); } };
  const csrf = (req, _res, next) => {
    try {
      assertSameOrigin(req);
      const supplied = req.get('x-csrf-token') || req.body?.csrf;
      if (!req.user || !supplied || supplied !== req.user.csrf) throw issue('CSRF_REJECTED', '보안 토큰이 만료되었습니다. 화면을 새로고침한 뒤 다시 시도하세요.', 403);
      next();
    } catch (error) { next(error); }
  };
  const api = (handler) => async (req, res, next) => { try { res.json(await handler(req, res)); } catch (error) { next(error); } };

  app.get('/health', async (_req, res, next) => { try { res.json({ status: 'ok', ...(await readiness(db)) }); } catch (error) { next(error); } });
  app.get('/ready', async (_req, res, next) => { try { await readiness(db); res.status(200).json({ status: 'ready' }); } catch (error) { next(error); } });
  app.get('/', (req, res) => res.redirect(req.user ? '/app/inbox' : '/login'));
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/app/inbox');
    res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>로그인 · OSAU</title><link rel="stylesheet" href="/assets/app.css"></head><body class="login-body"><main class="login-card"><p class="product-mark">OSAU</p><h1>콘텐츠 운영에 로그인</h1><p>원본, 검토, 승인 기록은 이 작업공간에 안전하게 보관됩니다.</p><form method="post" action="/login"><label>이메일<input name="email" type="email" autocomplete="email" required></label><label>비밀번호<input name="password" type="password" autocomplete="current-password" minlength="12" required></label><button class="button primary" type="submit">로그인</button></form></main></body></html>`);
  });
  app.post('/login', async (req, res, next) => { try {
    if (config.authDisabled) return res.redirect('/app/inbox');
    const session = await login(db, req.body.email, req.body.password);
    res.cookie('osau_session', session.token, cookieOptions(config.environment, config.cookieSecure));
    res.redirect('/app/inbox');
  } catch (error) { next(error); } });
  app.post('/logout', protect('administrator', 'operator', 'reviewer'), csrf, async (req, res, next) => { try {
    if (!config.authDisabled) {
      await logout(db, cookieValue(req.headers.cookie, 'osau_session'));
      res.clearCookie('osau_session', cookieOptions(config.environment, config.cookieSecure));
    }
    res.redirect(config.authDisabled ? '/app/inbox' : '/login');
  } catch (error) { next(error); } });

  app.get('/app/inbox', protect('administrator', 'operator', 'reviewer'), async (req, res, next) => { try {
    const query = String(req.query.q || '').trim().slice(0, 200);
    const sourceFilter = String(req.query.source || '').slice(0, 100);
    const allowedStates = new Set(['new', 'updated', 'partial', 'missing_transcript', 'failed_analysis']);
    const stateFilter = allowedStates.has(req.query.state) ? req.query.state : '';
    const sortKey = resolveInboxSort(req.query.sort);
    const sortOption = inboxSortOptions[sortKey];
    const sources = await db.query(`SELECT s.*, st.status AS sync_status, st.last_synced_at, st.last_error, st.retry_count
      FROM sources s JOIN source_sync_states st ON st.source_id=s.id
      WHERE s.workspace_id=$1 ORDER BY s.created_at DESC`, [req.user.workspaceId]);
    const rows = await db.query(`SELECT * FROM (
        SELECT i.id, i.title, i.canonical_url, i.published_at, i.created_at, i.updated_at, s.name AS source_name,
          s.id AS source_id, s.rights_status, s.connector_type, ss.version_no,
          st.status AS sync_status, st.last_error, st.last_synced_at, st.retry_count,
          assessment.readiness, assessment.omissions, assessment.acknowledgement_required,
          COALESCE(jsonb_array_length(assessment.usable_atom_ids),0)::int AS usable_atom_count,
          (SELECT artifact.id FROM artifacts artifact WHERE artifact.source_item_id=i.id ORDER BY artifact.updated_at DESC LIMIT 1) AS latest_artifact_id,
          EXISTS (
            SELECT 1 FROM outbox_events failed
            WHERE failed.workspace_id=s.workspace_id
              AND failed.event_type='apply_source_update'
              AND failed.status='failed'
              AND failed.payload->>'sourceItemId'=i.id
              AND NOT EXISTS (
                SELECT 1 FROM outbox_events recovered
                WHERE recovered.workspace_id=failed.workspace_id
                  AND recovered.event_type='apply_source_update'
                  AND recovered.status='succeeded'
                  AND recovered.payload->>'sourceItemId'=failed.payload->>'sourceItemId'
                  AND recovered.payload->>'oldSnapshotId'=failed.payload->>'oldSnapshotId'
                  AND recovered.payload->>'newSnapshotId'=failed.payload->>'newSnapshotId'
              )
              AND NOT EXISTS (
                SELECT 1 FROM outbox_events active
                WHERE active.workspace_id=failed.workspace_id
                  AND active.event_type='apply_source_update'
                  AND active.status IN ('pending','processing')
                  AND active.payload->>'sourceItemId'=failed.payload->>'sourceItemId'
                  AND active.payload->>'oldSnapshotId'=failed.payload->>'oldSnapshotId'
                  AND active.payload->>'newSnapshotId'=failed.payload->>'newSnapshotId'
              )
          ) AS impact_retry_required
        FROM source_items i
        JOIN sources s ON s.id=i.source_id
        JOIN source_sync_states st ON st.source_id=s.id
        LEFT JOIN source_snapshots ss ON ss.id=i.latest_snapshot_id
        LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=i.latest_snapshot_id
        WHERE s.workspace_id=$1
          AND ($2='' OR i.title ILIKE '%' || $2 || '%' OR s.name ILIKE '%' || $2 || '%')
          AND ($3='' OR s.id=$3)
      ) inbox
      WHERE (
        $4=''
        OR ($4='new' AND inbox.version_no=1)
        OR ($4='updated' AND inbox.version_no>1)
        OR ($4='partial' AND inbox.readiness='partial')
        OR ($4='missing_transcript' AND inbox.connector_type='youtube_metadata' AND inbox.readiness='partial')
        OR ($4='failed_analysis' AND (inbox.sync_status='failed' OR inbox.impact_retry_required OR inbox.readiness IN ('incompatible','insufficient','quarantined')))
      )
      ORDER BY ${sortOption.orderBy}`, [req.user.workspaceId, query, sourceFilter, stateFilter]);
    const connectionManagement = `<section class="source-list source-list-priority"><h2>연결 관리</h2>${sources.map((source) => `<article class="row-card"><div><h3>${escape(source.name)}</h3><p>${escape(connectorLabel(source.connector_type))}${source.feed_url ? ` · ${escape(source.feed_url)}` : ''}</p><small>${escape(rightsLabel(source.rights_status))} · ${source.last_synced_at ? `마지막 동기화 ${new Date(source.last_synced_at).toLocaleString('ko-KR')}` : '아직 수집하지 않았습니다.'}</small></div>${source.connector_type === 'transcript_upload' ? '<span class="help">변경본은 새 전사로 업로드합니다.</span>' : `<form data-api="/api/sources/${source.id}/sync"><button class="button secondary" type="submit">동기화</button></form>`}</article>`).join('') || '<p class="empty">연결 관리할 원본이 없습니다.</p>'}</section>`;
    const body = `<section class="split-header"><div><h2>처리 대기 ${rows.length}건</h2><p>영속 원본 스냅샷과 readiness를 기준으로 필터링한 작업 큐입니다.</p></div><div class="filter-actions"><button class="button primary" data-dialog-open="source-dialog">RSS 원본 연결</button><button class="button secondary" data-dialog-open="transcript-dialog">전사 업로드</button><button class="button secondary" data-dialog-open="youtube-dialog">YouTube metadata</button></div></section>
      <dialog id="source-dialog"><form class="stack" data-api="/api/sources" data-redirect="/app/inbox"><div class="dialog-header"><h2>RSS 연결 추가</h2><button aria-label="닫기" type="button" data-dialog-close>×</button></div><label>연결 이름<input name="name" required maxlength="120" placeholder="예: 브랜드 블로그"></label><label>RSS 주소<input name="feedUrl" type="url" required placeholder="https://example.com/feed"></label><label>사용 권리<select name="rightsStatus" required>${rightsOptions()}</select></label><p class="help">권리 상태는 readiness와 승인 경계에 영속됩니다. Naver 또는 표준 RSS/Atom만 사용하며 비공식 브라우저 자동화는 하지 않습니다.</p><div class="dialog-actions"><button class="button secondary" type="button" data-dialog-close>취소</button><button class="button primary" type="submit">연결 추가</button></div></form></dialog>
      <dialog id="transcript-dialog"><form class="stack" data-api="/api/transcripts" data-redirect="/app/inbox"><div class="dialog-header"><h2>전사 연결 추가</h2><button aria-label="닫기" type="button" data-dialog-close>×</button></div><label>연결 이름<input name="name" required maxlength="120" placeholder="예: 7월 제품 웨비나"></label><label>전사 제목<input name="title" required maxlength="500"></label><label>텍스트 파일<input name="transcriptFile" type="file" accept=".txt,.md,.srt,.vtt,text/plain,text/markdown"></label><label>또는 전사 내용<textarea name="transcriptText" maxlength="500000" rows="10" placeholder="파일을 선택하지 않았다면 여기에 전사 내용을 붙여 넣으세요."></textarea></label><label>관련 원본 주소<input name="canonicalUrl" type="url" placeholder="https://example.com/video"></label><label>사용 권리<select name="rightsStatus" required>${rightsOptions()}</select></label><p class="help">파일은 브라우저에서 텍스트로 읽어 500,000자 이하만 전송하며, 원문과 정규화 스냅샷은 실제 DB에 보관됩니다.</p><div class="dialog-actions"><button class="button secondary" type="button" data-dialog-close>취소</button><button class="button primary" type="submit">연결 추가</button></div></form></dialog>
      <dialog id="youtube-dialog"><form class="stack" data-api="/api/youtube" data-redirect="/app/inbox"><div class="dialog-header"><h2>YouTube 연결 추가</h2><button aria-label="닫기" type="button" data-dialog-close>×</button></div><label>연결 이름<input name="name" maxlength="120" placeholder="영상 제목을 자동으로 불러옵니다"></label><label>YouTube 영상 주소 또는 ID<input name="videoUrl" required maxlength="2000" placeholder="https://www.youtube.com/watch?v=..."></label><label>사용 권리<select name="rightsStatus" required>${rightsOptions()}</select></label><p class="help">공식 YouTube oEmbed metadata만 비동기로 수집합니다. 전사나 설명을 임의 스크래핑하지 않으며 metadata-only 상태는 전사 누락으로 명확히 표시됩니다.</p><div class="dialog-actions"><button class="button secondary" type="button" data-dialog-close>취소</button><button class="button primary" type="submit">연결 추가</button></div></form></dialog>
      ${connectionManagement}<form class="queue-filters" method="get" action="/app/inbox" role="search"><label>원본 검색<input type="search" name="q" value="${escape(query)}" maxlength="200" placeholder="제목 또는 연결 이름"></label><label>연결 원본<select name="source"><option value="">전체 연결</option>${sources.map((source) => `<option value="${source.id}" ${sourceFilter === source.id ? 'selected' : ''}>${escape(source.name)} 연결</option>`).join('')}</select></label><label>큐 상태<select name="state"><option value="">전체 상태</option><option value="new" ${stateFilter === 'new' ? 'selected' : ''}>새 원본</option><option value="updated" ${stateFilter === 'updated' ? 'selected' : ''}>업데이트됨</option><option value="partial" ${stateFilter === 'partial' ? 'selected' : ''}>부분 콘텐츠</option><option value="missing_transcript" ${stateFilter === 'missing_transcript' ? 'selected' : ''}>전사 누락</option><option value="failed_analysis" ${stateFilter === 'failed_analysis' ? 'selected' : ''}>수집·분석 실패</option></select></label><label>정렬<select name="sort">${Object.entries(inboxSortOptions).map(([key, option]) => `<option value="${key}" ${sortKey === key ? 'selected' : ''}>${option.label}</option>`).join('')}</select></label><div class="filter-actions"><button class="button secondary" type="submit">필터 적용</button><a class="button secondary" href="/app/inbox">초기화</a></div></form>
      <section class="table-wrap"><table><thead><tr><th>원본</th><th>큐에 표시된 이유</th><th>수집 상태</th><th>사용 준비도</th><th>게시 시각</th><th>다음 작업</th></tr></thead><tbody>${rows.length ? rows.map((row) => {
        const omissions = displayList(row.omissions);
        const usable = ['complete', 'partial'].includes(row.readiness);
        const reason = row.impact_retry_required ? '변경 영향 처리 실패'
          : row.sync_status === 'failed' ? '마지막 수집 실패'
          : row.readiness === 'quarantined' ? '보안 신호로 격리'
            : row.readiness === 'incompatible' ? '파생 사용 권리 제한'
              : row.connector_type === 'youtube_metadata' && row.readiness === 'partial' ? '전사 누락 · metadata만 수집'
                : row.readiness === 'insufficient' ? '사용할 근거 부족'
                : row.readiness === 'partial' ? '부분 콘텐츠 확인 필요'
                  : Number(row.version_no) > 1 ? '원본 업데이트됨'
                    : row.latest_artifact_id ? '검토할 결과물 있음' : '새 원본';
        const nextAction = row.latest_artifact_id
          ? `<a class="button secondary compact" href="/app/review/${row.latest_artifact_id}">검토 계속</a>`
          : usable ? `<a class="button secondary compact" href="/app/planner/${row.id}">계획 만들기</a>` : '<span class="help">원본 상세에서 차단 이유를 확인하세요.</span>';
        const publishedAt = row.published_at ? new Date(row.published_at).toLocaleString('ko-KR') : `게시 시각 없음 · 수집 ${new Date(row.created_at).toLocaleString('ko-KR')}`;
        return `<tr><td data-label="원본" data-mobile-primary><a href="/app/source/${row.id}">${escape(row.title)}</a><small>${escape(row.source_name)} · 스냅샷 버전 ${row.version_no || '대기'}</small></td><td data-label="처리 이유"><strong>${escape(reason)}</strong><small>${escape(rightsLabel(row.rights_status))}</small></td><td data-label="수집 상태">${badge(row.sync_status)}${row.last_error ? `<small class="error-text">${escape(row.last_error)}</small>` : ''}${row.impact_retry_required ? '<small class="error-text">최신 스냅샷의 변경 영향 계산이 끝나지 않았습니다.</small>' : ''}</td><td data-label="사용 준비도">${row.readiness ? `<strong>${escape(readinessLabel(row.readiness))}</strong><small>사용 가능 근거 ${row.usable_atom_count}개${omissions.length ? ` · ${escape(omissions.join(' / '))}` : ''}</small>` : '평가 대기'}</td><td data-label="게시 시각">${escape(publishedAt)}${row.retry_count ? `<small>수집 재시도 ${row.retry_count}회</small>` : ''}${row.impact_retry_required ? `<form data-api="/api/sources/${row.source_id}/retry-impact" data-redirect="/app/inbox"><button class="button secondary compact" type="submit">변경 영향 처리 재시도</button></form>` : `<form data-api="/api/sources/${row.source_id}/sync"><button class="button secondary compact" type="submit">${row.sync_status === 'failed' ? '수집 재시도' : '지금 동기화'}</button></form>`}</td><td data-label="다음 작업">${nextAction}</td></tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">${query || sourceFilter || stateFilter ? '선택한 검색·필터에 맞는 원본이 없습니다.' : '연결된 원본이 없습니다. RSS 원본을 연결하면 이곳에 실제 항목이 표시됩니다.'}</td></tr>`}</tbody></table></section>
      `;
    res.send(layout({ user: req.user, title: `원본 인박스 · 결과 ${rows.length}건`, summary: '처리 이유, 준비도, 마지막 동기화를 기준으로 다음 작업을 선택하세요.', current: 'inbox', csrf: req.user.csrf, body }));
  } catch (error) { next(error); } });

  app.get('/app/source/:sourceItemId', protect('administrator', 'operator', 'reviewer'), async (req, res, next) => { try {
    const item = (await db.query(`SELECT i.*, s.workspace_id, s.rights_status, ss.version_no, ss.body,
        ss.ingestion_meta, assessment.readiness, assessment.omissions, assessment.signals,
        assessment.acknowledgement_required, assessment.detector_version, assessment.assessed_at,
        COALESCE(jsonb_array_length(assessment.usable_atom_ids),0)::int AS usable_atom_count
      FROM source_items i
      JOIN sources s ON s.id=i.source_id
      JOIN source_snapshots ss ON ss.id=i.latest_snapshot_id
      LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=ss.id
      WHERE i.id=$1 AND s.workspace_id=$2`, [req.params.sourceItemId, req.user.workspaceId]))[0];
    if (!item) throw issue('SOURCE_ITEM_NOT_FOUND', '원본 항목을 찾을 수 없습니다.', 404);
    const [atoms, artifacts, linkedBlocks, identityFacts] = await Promise.all([
      db.query('SELECT position_label, text, locked FROM content_atoms WHERE snapshot_id=$1 ORDER BY position_label', [item.latest_snapshot_id]),
      db.query(`SELECT artifact.id,artifact.channel,artifact.state,definition.display_name
        FROM artifacts artifact
        LEFT JOIN artifact_versions version ON version.id=artifact.current_version_id
        LEFT JOIN channel_definition_versions definition ON definition.id=version.channel_definition_version_id
        WHERE artifact.source_item_id=$1 ORDER BY artifact.updated_at DESC`, [item.id]),
      db.query(`SELECT atom.position_label, artifact.id AS artifact_id, artifact.channel,
          definition.display_name, block.block_type, block.content
        FROM block_source_refs ref
        JOIN content_atoms atom ON atom.id=ref.content_atom_id
        JOIN artifact_blocks block ON block.id=ref.artifact_block_id
        JOIN artifact_versions version ON version.id=block.artifact_version_id
        JOIN artifacts artifact ON artifact.current_version_id=version.id
        LEFT JOIN channel_definition_versions definition ON definition.id=version.channel_definition_version_id
        WHERE atom.snapshot_id=$1 AND artifact.source_item_id=$2
        ORDER BY atom.position_label, artifact.updated_at DESC`, [item.latest_snapshot_id, item.id]),
      db.query(`SELECT identity.version_no, fact.claim, fact.evidence_url, fact.evidence_note
        FROM creator_identity_versions identity
        JOIN creator_identity_facts fact ON fact.identity_version_id=identity.id
        WHERE identity.workspace_id=$1
          AND identity.version_no=(SELECT max(version_no) FROM creator_identity_versions WHERE workspace_id=$1)
        ORDER BY fact.claim`, [req.user.workspaceId])
    ]);
    const linksByPosition = new Map();
    for (const link of linkedBlocks) {
      if (!linksByPosition.has(link.position_label)) linksByPosition.set(link.position_label, []);
      linksByPosition.get(link.position_label).push(link);
    }
    const omissions = displayList(item.omissions);
    const ingestion = parseJson(item.ingestion_meta, {});
    const usable = ['complete', 'partial'].includes(item.readiness);
    const canonicalHref = safeHttpHref(item.canonical_url);
    const reassessmentControl = item.readiness === 'quarantined'
      ? `<form data-api="/api/sources/items/${item.id}/reassess-readiness" data-redirect="/app/source/${item.id}"><button class="button secondary" type="submit">보안 판정 다시 확인</button><small>현재 스냅샷은 바꾸지 않고 최신 보안 규칙으로 판정만 재평가합니다.</small></form>`
      : '';
    const readinessNotice = `<section class="notice ${usable ? (item.readiness === 'partial' ? 'warning' : 'success') : 'danger'}"><h2>${escape(readinessLabel(item.readiness))}</h2><p>권리: ${escape(rightsLabel(item.rights_status))} · 생성에 사용할 수 있는 근거 ${item.usable_atom_count}개</p>${omissions.length ? `<ul>${omissions.map((entry) => `<li>${escape(entry)}</li>`).join('')}</ul>` : '<p>수집 범위에서 알려진 누락이 없습니다.</p>'}${parseJson(item.signals, []).length ? '<p><strong>보안 또는 수집 경고 신호가 기록되어 있습니다. 격리 상태에서는 생성할 수 없습니다.</strong></p>' : ''}${reassessmentControl}${item.detector_version ? `<small>보안 판정 ${escape(item.detector_version)} · ${new Date(item.assessed_at).toLocaleString('ko-KR')}</small>` : ''}${ingestion.bodyKind ? `<small>수집 본문 유형: ${escape(bodyKindLabel(ingestion.bodyKind))}${ingestion.truncated ? ' · 크기 제한으로 일부 잘림' : ''}</small>` : ''}</section>`;
    const body = `<section class="object-header"><div><p class="eyebrow">원본 스냅샷 버전 ${item.version_no}</p><h2>${escape(item.title)}</h2>${canonicalHref ? `<a href="${escape(canonicalHref)}" rel="noreferrer" target="_blank">원문 열기</a>` : ''}</div>${usable ? `<a class="button primary" href="/app/planner/${item.id}">이 원본으로 계획 만들기</a>` : '<span class="help">현재 readiness에서는 생성이 차단됩니다.</span>'}</section>${readinessNotice}<div class="two-column"><section><h2>정규화된 원본 내용</h2><article class="reading-surface">${escape(item.body).replace(/\n/g, '<br>')}</article><section class="identity-context"><h2>Creator Identity 근거</h2>${identityFacts.length ? `<p>현재 버전 ${identityFacts[0].version_no} · 생성에서 잠긴 사실로만 사용됩니다.</p><ul>${identityFacts.map((fact) => `<li><strong>${escape(fact.claim)}</strong><span>${escape(fact.evidence_note)}</span><small>${escape(fact.evidence_url)}</small></li>`).join('')}</ul>` : '<p class="empty">저장된 Creator Identity 사실이 없습니다. 모델이 경력이나 경험을 만들어낼 수 없습니다.</p>'}</section></section><section><h2>원본 위치와 연결 블록</h2><ul class="atom-list">${atoms.map((atom) => {
      const links = linksByPosition.get(atom.position_label) || [];
      return `<li><strong>${escape(atom.position_label)}</strong><span>${escape(atom.text)}</span>${atom.locked ? '<small>잠긴 사실</small>' : ''}${links.length ? `<ul class="atom-links">${links.map((link) => `<li><a href="/app/review/${link.artifact_id}">${escape(link.display_name || channelName(link.channel))} · ${escape(blockTypeLabel(link.block_type))}</a><small>${escape(link.content.slice(0, 120))}</small></li>`).join('')}</ul>` : '<small>현재 결과물 블록 연결 없음</small>'}</li>`;
    }).join('')}</ul><h2>연결된 결과물</h2>${artifacts.length ? artifacts.map((artifact) => `<a class="row-card link-card" href="/app/review/${artifact.id}"><span>${escape(artifact.display_name || channelName(artifact.channel))}</span>${badge(artifact.state)}</a>`).join('') : '<p class="empty">아직 결과물이 없습니다.</p>'}</section></div>`;
    res.send(layout({ user: req.user, title: '원본 상세', summary: '원본 위치와 연결된 결과물을 함께 확인합니다.', current: 'inbox', csrf: req.user.csrf, body }));
  } catch (error) { next(error); } });

  app.get('/app/planner/:sourceItemId', protect('administrator', 'operator'), async (req, res, next) => { try {
    const source = (await db.query(`SELECT i.id,i.title,i.latest_snapshot_id,st.status AS sync_status,st.last_error,
        s.rights_status, snapshot.title AS snapshot_title,snapshot.version_no AS snapshot_version_no,
        assessment.readiness, assessment.omissions, assessment.signals,
        assessment.acknowledgement_required
      FROM source_items i
      JOIN sources s ON s.id=i.source_id
      JOIN source_sync_states st ON st.source_id=s.id
      LEFT JOIN source_snapshots snapshot ON snapshot.id=i.latest_snapshot_id
      LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=i.latest_snapshot_id
      WHERE i.id=$1 AND s.workspace_id=$2`, [req.params.sourceItemId, req.user.workspaceId]))[0];
    if (!source) throw issue('SOURCE_ITEM_NOT_FOUND', '계획을 만들 원본을 찾을 수 없습니다.', 404);
    const [providers, identities, voices, audiences, channels] = await Promise.all([
      db.query('SELECT id,name,model,is_default,secret_ciphertext IS NOT NULL AS ready FROM model_provider_configs WHERE workspace_id=$1 AND enabled=true AND provider_type <> $2 ORDER BY is_default DESC,name', [req.user.workspaceId, 'fixture']),
      db.query('SELECT id,version_no FROM creator_identity_versions WHERE workspace_id=$1 ORDER BY version_no DESC', [req.user.workspaceId]),
      db.query('SELECT id,version_no FROM creator_voice_versions WHERE workspace_id=$1 ORDER BY version_no DESC', [req.user.workspaceId]),
      db.query('SELECT id,version_no,name FROM audience_persona_versions WHERE workspace_id=$1 ORDER BY version_no DESC', [req.user.workspaceId]),
      activeChannelCatalog(db, req.user.workspaceId)
    ]);
    const readyProviders = providers.filter((provider) => provider.ready);
    const options = (records, label) => `<option value="">선택 안 함</option>${records.map((row) => `<option value="${row.id}">${escape(label(row))}</option>`).join('')}`;
    const providerOptions = readyProviders.map((provider) => `<option value="${provider.id}" ${provider.is_default ? 'selected' : ''}>${escape(provider.name)} · ${escape(provider.model)}${provider.is_default ? ' · 기본' : ''}</option>`).join('');
    const providerControl = readyProviders.length ? `<label>생성 Provider<select name="providerId" required><option value="">Provider 선택</option>${providerOptions}</select></label><label>평가 Provider<select name="evaluatorProviderId"><option value="">${escape(assuranceLabel('LOW_ASSURANCE'))}</option>${readyProviders.map((provider) => `<option value="${provider.id}">${escape(provider.name)} · ${escape(provider.model)}</option>`).join('')}</select><small>독립 Provider를 선택하면 평가 분리가 기록됩니다.</small></label>` : `<div class="notice danger"><h3>생성이 준비되지 않았습니다</h3><p>활성 Provider와 암호화된 API Key가 있어야 실제 비동기 생성 작업을 시작할 수 있습니다.</p><a class="button secondary" href="/app/settings">Model Provider 설정으로 이동</a></div>`;
    const readinessAllowed = ['complete', 'partial'].includes(source.readiness);
    const canGenerate = Boolean(source.latest_snapshot_id && readinessAllowed && readyProviders.length && channels.length);
    const omissions = displayList(source.omissions);
    const readiness = !source.latest_snapshot_id
      ? `<section class="notice danger"><h2>원본 동기화가 아직 완료되지 않았습니다</h2><p>RSS 스냅샷이 생성된 뒤에만 정확한 원본 위치를 결과물 블록에 연결할 수 있습니다.</p><a class="button secondary" href="/app/inbox">원본 인박스로 이동</a></section>`
      : `<section class="notice ${readinessAllowed ? (source.readiness === 'partial' ? 'warning' : 'success') : 'danger'}"><h2>${escape(readinessLabel(source.readiness))}</h2><p>권리: ${escape(rightsLabel(source.rights_status))}</p>${omissions.length ? `<ul>${omissions.map((entry) => `<li>${escape(entry)}</li>`).join('')}</ul>` : '<p>알려진 수집 누락이 없습니다.</p>'}${!readinessAllowed ? '<p><strong>이 상태에서는 모델 생성 작업을 시작할 수 없습니다.</strong></p>' : ''}</section>`;
    const acknowledgement = (source.readiness === 'partial' || source.acknowledgement_required) && readinessAllowed
      ? `<label class="acknowledgement"><input type="checkbox" name="sourceReadinessAcknowledged" value="true" required> 위 누락 범위와 권리 경고를 확인했으며, 이 범위 안에서만 파생 콘텐츠를 생성합니다.</label>`
      : '';
    const missingContext = [
      !identities.length ? 'Creator Identity' : '',
      !voices.length ? 'Creator Voice' : '',
      !audiences.length ? 'Audience Persona' : ''
    ].filter(Boolean);
    const contextNotice = missingContext.length
      ? `<p class="context-guidance">${escape(missingContext.join(' · '))}가 아직 등록되지 않았습니다. 등록하지 않아도 생성할 수 있지만, 근거 없는 경력·경험·독자 가정은 결과물에 넣지 않습니다. <a href="/app/settings">설정에서 근거 추가</a></p>`
      : '';
    const suggestionEnabled = Boolean(source.latest_snapshot_id && readinessAllowed && readyProviders.length && channels.length);
    const suggestionControls = `<section class="planner-suggestion-panel" data-planner-suggestion-panel aria-busy="false"><div class="planner-suggestion-toolbar"><div><h3>내 소스로 채널 기본값 추천</h3><p>작업공간의 권리·readiness를 통과한 최신 원본을 분석하고 현재 원본을 우선해 설정을 제안합니다.</p></div><button class="button secondary" type="button" data-planner-suggest ${suggestionEnabled ? '' : 'disabled'}>내 소스로 기본값 추천</button></div><div class="planner-suggestion-status" data-planner-suggestion-status hidden role="status" aria-live="polite"></div><p class="planner-suggestion-summary" data-planner-suggestion-summary hidden></p><section class="planner-suggestion-sources" data-planner-suggestion-sources hidden aria-label="추천된 생성 원본"></section></section>`;
    const body = `<section class="object-header"><div><p class="eyebrow">원본에서 생성</p><h2>${escape(source.snapshot_title || source.title)}</h2><p>원본 스냅샷 버전 ${escape(source.snapshot_version_no || '')} · 선택한 채널만 영속 결과물로 만들어집니다. 자동 검사와 사람 확인은 Review Workbench에서 서로 다른 상태로 기록됩니다.</p></div></section>${readiness}<form class="planner-form" data-api="/api/plans" data-run-result-redirect="/app/runs" data-planner-source-item="${escape(source.id)}" data-planner-snapshot="${escape(source.latest_snapshot_id || '')}"><input type="hidden" name="sourceItemId" value="${escape(source.id)}"><input type="hidden" name="expectedSnapshotId" value="${escape(source.latest_snapshot_id || '')}"><input type="hidden" name="plannerSuggestionRunId" value=""><section><h2>공통 맥락</h2>${acknowledgement}${contextNotice}<div class="form-grid"><label>Creator Identity<select name="creatorIdentityVersionId">${options(identities, (row) => `버전 ${row.version_no}`)}</select></label><label>Creator Voice<select name="creatorVoiceVersionId">${options(voices, (row) => `버전 ${row.version_no}`)}</select></label><label>Audience Persona<select name="audiencePersonaVersionId">${options(audiences, (row) => `${row.name} · 버전 ${row.version_no}`)}</select></label>${providerControl}</div><label>공통 CTA<input name="commonCta" maxlength="1000" placeholder="예: 상담 전 원본 체크리스트를 확인하세요"></label><p class="help">CTA를 비워 두면 모델이 임의 CTA를 만들지 않습니다.</p></section><section><h2>생성할 채널</h2>${suggestionControls}<p class="help">활성 Platform Profile만 표시합니다. 추천은 자동 분석이며 사람 확인이 아닙니다. 채널을 자동 선택하지 않고, 선택하지 않은 채널의 plan/output/artifact/export는 만들지 않습니다.</p><div class="channel-grid">${channels.map((channel) => channelPlannerFieldset(channel)).join('') || '<p class="empty">활성화된 채널이 없습니다. 관리자 설정에서 채널을 활성화하세요.</p>'}</div></section><div class="planner-submit-bar"><output data-plan-selection-summary aria-live="polite">채널을 선택하면 생성 범위가 표시됩니다.</output><button class="button primary" type="submit" data-plan-submit data-server-disabled="${canGenerate ? 'false' : 'true'}" ${canGenerate ? '' : 'disabled'}>선택한 결과물 생성</button></div></form>`;
    res.send(layout({ user: req.user, title: '계획 만들기', summary: '채널 목적과 구조를 먼저 선택합니다.', current: 'inbox', csrf: req.user.csrf, body }));
  } catch (error) { next(error); } });

  app.get('/app/review/:artifactId', protect('administrator', 'operator', 'reviewer'), async (req, res, next) => { try {
    const review = await getArtifactReview(db, req.user.workspaceId, req.params.artifactId);
    const { artifact, blocks } = review;
    const providers = await db.query("SELECT id, name, model, is_default FROM model_provider_configs WHERE workspace_id=$1 AND enabled=true AND provider_type <> 'fixture' AND secret_ciphertext IS NOT NULL ORDER BY is_default DESC,name", [req.user.workspaceId]);
    const sourceAtoms = await db.query(`SELECT atom.position_label,atom.text,
        version_source.source_key,version_source.ordinal AS source_ordinal,
        snapshot.title AS snapshot_title,snapshot.version_no,
        source.name AS source_name
      FROM artifact_version_source_snapshots version_source
      JOIN artifact_versions version ON version.id=version_source.artifact_version_id
      JOIN source_snapshots snapshot ON snapshot.id=version_source.snapshot_id
      JOIN source_items item ON item.id=version_source.source_item_id
      JOIN sources source ON source.id=item.source_id
      JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=version_source.snapshot_id
      JOIN content_atoms atom ON atom.snapshot_id=version_source.snapshot_id
      LEFT JOIN run_source_seed_atoms seed
        ON seed.run_id=version.created_by_run_id
        AND seed.source_item_id=version_source.source_item_id
        AND seed.snapshot_id=version_source.snapshot_id
        AND seed.content_atom_id=atom.id
      WHERE version_source.artifact_version_id=$1
        AND atom.atom_type <> 'context'
        AND (
          (version_source.is_primary AND assessment.usable_atom_ids ? atom.id)
          OR (NOT version_source.is_primary AND seed.content_atom_id IS NOT NULL)
        )
      ORDER BY version_source.ordinal,atom.position_label`, [artifact.current_version_id]);
    const latestSourceWarnings = await db.query(`SELECT snapshot.id AS snapshot_id,
        source.name AS source_name,snapshot.title,assessment.omissions
      FROM artifact_version_source_snapshots version_source
      JOIN source_items item ON item.id=version_source.source_item_id
      JOIN sources source ON source.id=item.source_id
      JOIN source_snapshots snapshot ON snapshot.id=item.latest_snapshot_id
      JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=item.latest_snapshot_id
      WHERE version_source.artifact_version_id=$1
        AND version_source.snapshot_id<>item.latest_snapshot_id
        AND (assessment.readiness='partial' OR assessment.acknowledgement_required)
      ORDER BY version_source.ordinal`, [artifact.current_version_id]);
    const sourceHandle = (atom) => `${atom.source_key}::${atom.position_label}`;
    const sourceAtomByHandle = new Map(sourceAtoms.map((atom) => [sourceHandle(atom), atom]));
    const sourceDisplay = (atom) => [
      atom?.source_name,
      atom?.snapshot_title,
      atom?.version_no ? `버전 ${atom.version_no}` : '',
      atom?.position_label
    ].filter(Boolean).join(' · ');
    const sourceContext = sourceAtoms[0]
      ? [sourceAtoms[0].source_name, sourceAtoms[0].snapshot_title, sourceAtoms[0].version_no ? `스냅샷 버전 ${sourceAtoms[0].version_no}` : ''].filter(Boolean).join(' · ')
      : '';
    const canOperate = req.user.role === 'administrator' || req.user.role === 'operator';
    const currentVerificationByBlock = new Map(review.humanVerification.current.map((verification) => [verification.artifact_block_id, verification]));
    const humanVerificationProgress = review.humanVerification.progress || { total: 0, completed: 0, pending: 0 };
    const pendingHumanVerification = review.humanVerification.pending || [];
    const pendingHumanVerificationByBlockId = new Map(pendingHumanVerification.map((entry) => [entry.blockId, entry]));
    const initialVerificationBlockId = pendingHumanVerification[0]?.blockId || null;
    const findingsFor = (block) => review.automaticFindings.filter((finding) =>
      finding.artifact_block_id === block.id || (!finding.artifact_block_id && finding.block_key === block.block_key));
    const findingMarkup = (findings) => findings.length
      ? `<ul class="finding-list">${findings.map((finding) => `<li class="finding ${finding.severity === 'fail' ? 'finding-fail' : 'finding-warning'}"><strong>${finding.severity === 'fail' ? '실패' : '경고'} · ${escape(finding.dimension)}</strong><p>${escape(finding.message)}</p>${finding.recovery ? `<small>복구 방법 · ${escape(finding.recovery)}</small>` : ''}<small>${finding.status === 'resolved' ? '해결 기록됨' : '미해결'}</small></li>`).join('')}</ul>`
      : '<p class="help">이 블록에 기록된 자동 실패는 없습니다. 이는 사람이 원본과 대조했다는 뜻이 아닙니다.</p>';
    const sourcePanel = `<section id="workbench-source" class="pane source-pane" role="tabpanel" aria-labelledby="workbench-tab-source" tabindex="-1"><h2>원본과 근거</h2><p>${escape(sourceContext || '현재 스냅샷의 영속 위치')} · 선택한 블록에 연결된 위치만 강조됩니다.</p><div id="evidence-list">${blocks.flatMap((block) => block.sourceRefs.map((ref) => {
      const sourceAtom = sourceAtomByHandle.get(ref.handle);
      return `<article data-source-for="${block.id}" class="source-ref"><strong>${escape(sourceAtom?.position_label || ref.position_label)}</strong><p>${escape(ref.text)}</p></article>`;
    })).join('') || '<p class="empty">선택할 원본 연결이 없습니다.</p>'}</div><section id="source-readiness" class="source-readiness-summary"><h3>수집 범위</h3><p>${escape(readinessLabel(review.profile.source.readiness))}</p>${review.profile.source.omissions.length ? `<ul>${review.profile.source.omissions.map((entry) => `<li>${escape(omissionLabel(entry))}</li>`).join('')}</ul>` : '<p class="help">알려진 누락이 없습니다.</p>'}${review.profile.source.readiness === 'partial' ? `<p>${review.profile.source.partialAcknowledged ? '계획 시 부분 원본 범위를 확인했습니다.' : '부분 원본 확인 기록이 없습니다.'}</p>` : ''}</section></section>`;
    const editorPanel = `<section id="workbench-edit" class="pane editor-pane" role="tabpanel" aria-labelledby="workbench-tab-edit"><h2>${escape(review.profile.channel.name)}</h2><p>${escape(review.profile.channel.label)} · 각 보이는 표면을 별도 블록으로 보관합니다.</p><div class="block-list">${blocks.map((block) => `<button type="button" class="artifact-block" data-block-select="${block.id}"${pendingHumanVerificationByBlockId.has(block.id) ? ' data-verification-pending="true"' : ''}${initialVerificationBlockId === block.id ? ' data-verification-default="true"' : ''} aria-controls="review-panel"><span>${escape(block.content_kind === 'factual' ? '사실 표면' : block.content_kind === 'editorial' ? '승인된 편집 표면' : '제작 지시')} · ${escape(blockTypeLabel(block.block_type))}</span><strong>${escape(block.content)}</strong>${badge(block.evidence_state, 'evidence')}${block.stale ? badge('stale') : ''}${block.source_drift_pending ? badge('source_update_pending') : ''}${block.held ? badge('held') : ''}</button>`).join('')}</div></section>`;
    const preview = artifactPreview(artifact.channel, artifact.content, review.profile.channel.name);
    const blockPanels = blocks.map((block) => {
      const verification = currentVerificationByBlock.get(block.id);
      const blockComments = review.comments.filter((comment) =>
        comment.current_version && comment.artifact_block_id === block.id);
      const currentPositions = new Set(block.sourceRefs.map((ref) => ref.handle));
      const sourcePositionControl = block.content_kind === 'factual'
        ? `<label>현재 원본 위치<select name="sourcePositions" multiple size="${Math.min(8, Math.max(3, sourceAtoms.length))}" required>${sourceAtoms.map((atom) => {
          const handle = sourceHandle(atom);
          return `<option value="${escape(handle)}" ${currentPositions.has(handle) ? 'selected' : ''}>${escape(sourceDisplay(atom))} · ${escape(atom.text.slice(0, 100))}</option>`;
        }).join('')}</select><small>Ctrl/Command 키로 여러 위치를 선택할 수 있습니다.</small></label>`
        : '<p class="help">이 표면은 사실 주장이 아니므로 원본 위치를 연결하지 않습니다.</p>';
      const verificationBlockedReason = block.source_drift_pending
        ? '원본 변경 영향 처리가 끝난 뒤 새 현재 스냅샷과 대조할 수 있습니다.'
        : block.stale
          ? '변경 영향 결정을 완료하고 새로고침한 뒤 대조할 수 있습니다.'
          : block.held
            ? '검토 보류를 해제한 뒤 대조할 수 있습니다.'
            : block.evidence_state === 'conflict'
              ? '원본 불일치를 해결한 뒤 대조할 수 있습니다.'
              : null;
      const verificationControl = block.content_kind === 'factual' && block.sourceRefs.length
        ? verificationBlockedReason
          ? `<p class="help">${verificationBlockedReason}</p>`
          : `<form data-api="/api/blocks/${block.id}/verify" data-human-verification-record><label>사람 확인 메모<input name="note" maxlength="2000" required placeholder="현재 원본 위치와 문장을 직접 비교한 결과"></label><button class="button secondary" type="submit">현재 스냅샷과 대조 기록</button></form>`
        : '<p class="help">사람 원본 대조가 필요한 사실 블록이 아닙니다.</p>';
      return `<section data-check-for="${block.id}" hidden><h3>${escape(blockTypeLabel(block.block_type))} 검토</h3><section class="review-boundary"><h4>자동 검사</h4>${findingMarkup(findingsFor(block))}</section><section class="review-boundary"><h4>사람 확인</h4><p>${verification ? `현재 스냅샷 대조 기록됨 · ${escape(verification.reviewer_email)} · ${new Date(verification.verified_at).toLocaleString('ko-KR')}` : '아직 사람이 현재 스냅샷과 대조하지 않았습니다.'}</p>${verification?.note ? `<blockquote>${escape(verification.note)}</blockquote>` : ''}${verificationControl}</section><section class="review-boundary"><h4>블록 의견</h4>${blockComments.length ? `<ul class="history-list">${blockComments.map((comment) => `<li><strong>${escape(comment.author_email)}</strong><p>${escape(comment.body)}</p><small>${comment.resolved_at ? `해결됨 · ${escape(comment.resolved_by_email || '')}` : '미해결'}</small></li>`).join('')}</ul>` : '<p class="help">현재 버전의 이 블록에는 의견이 없습니다.</p>'}<form data-api="/api/artifacts/${artifact.id}/comments"><input type="hidden" name="blockId" value="${block.id}"><label>검토 의견<textarea name="body" maxlength="4000" required></textarea></label><button class="button secondary" type="submit">블록 의견 저장</button></form></section><details><summary>이 블록 편집</summary><form class="stack block-edit-form" data-api="/api/artifacts/${artifact.id}/blocks/${block.id}/edit"><label>표면 내용<textarea name="content" maxlength="8000" required>${escape(block.content)}</textarea></label>${sourcePositionControl}<label>변경 메모<input name="note" maxlength="2000" placeholder="무엇을 왜 바꿨는지"></label><p class="help">편집하면 새 불변 버전이 생성됩니다. 바뀐 사실 블록의 사람 확인과 기존 승인은 이관되지 않습니다.</p><button class="button secondary" type="submit">새 버전으로 저장</button></form></details><div class="block-actions"><form data-api="/api/blocks/${block.id}/conflict"><input type="hidden" name="conflict" value="${block.evidence_state === 'conflict' ? 'false' : 'true'}">${block.evidence_state === 'conflict' ? '' : '<label>불일치 메모<input name="note" maxlength="2000" required placeholder="원본과 다른 지점을 기록"></label>'}<button class="button danger" type="submit">${block.evidence_state === 'conflict' ? '불일치 해제' : '원본 불일치 기록'}</button></form><form data-api="/api/blocks/${block.id}/hold"><input type="hidden" name="held" value="${block.held ? 'false' : 'true'}"><button class="button ${block.held ? 'secondary' : 'danger'}" type="submit">${block.held ? '보류 해제' : '검토 보류'}</button></form></div></section>`;
    }).join('');
    const verificationStateText = {
      ready: '현재 원본 위치를 직접 대조할 수 있습니다.',
      source_update_pending: '원본 변경 영향 처리가 끝난 뒤 대조할 수 있습니다.',
      stale: '변경 영향 결정을 완료한 뒤 대조할 수 있습니다.',
      held: '검토 보류를 해제한 뒤 대조할 수 있습니다.',
      conflict: '원본 불일치를 해결한 뒤 대조할 수 있습니다.',
      source_required: '영속 원본 위치가 없어 대조 기록을 만들 수 없습니다.'
    };
    const verificationBlocks = blocks.filter((block) => block.content_kind === 'factual' && block.sourceRefs.length);
    const verificationSegments = verificationBlocks.map((block, index) => {
      const complete = Boolean(currentVerificationByBlock.get(block.id));
      const pending = pendingHumanVerificationByBlockId.has(block.id);
      return `<button type="button" class="verification-segment" data-block-focus="${escape(block.id)}" data-verification-queue-select aria-label="${index + 1}번 ${escape(blockTypeLabel(block.block_type))} ${complete ? '대조 기록됨' : pending ? '대조 필요' : '현재 상태 확인'}" aria-current="${complete ? 'true' : 'false'}"></button>`;
    }).join('');
    const verificationQueueMarkup = pendingHumanVerification.length
      ? `<section id="human-verification-queue" class="verification-queue" aria-labelledby="human-verification-title"><h3 id="human-verification-title">대조 대기 블록</h3><p class="help">자동 검사와 별개로, 현재 원본 위치를 직접 읽고 한 건씩 기록합니다.</p><button type="button" class="button secondary" data-block-focus="${escape(initialVerificationBlockId || '')}" data-verification-queue-select aria-controls="workbench-source review-panel">${pendingHumanVerification[0]?.state === 'ready' ? '다음 미확인 사실 블록 검토' : '대조가 막힌 사실 블록 확인'}</button><ol class="verification-queue-list">${pendingHumanVerification.map((entry) => {
        const block = blocks.find((candidate) => candidate.id === entry.blockId);
        return `<li><button type="button" class="verification-queue-item" data-block-focus="${escape(entry.blockId)}" data-verification-queue-select aria-pressed="false"><strong>${escape(blockTypeLabel(block?.block_type))} · ${escape((block?.content || '').slice(0, 46))}</strong><small>${escape(verificationStateText[entry.state] || '현재 상태를 확인하세요.')}</small></button></li>`;
      }).join('')}</ol></section>`
      : '';
    const blockers = review.approval.blockers;
    const staleBlock = blocks.find((block) => block.stale);
    const blockedVerificationBlock = blocks.find((block) => block.source_drift_pending || block.held || block.evidence_state === 'conflict');
    const blockerAction = (blocker) => {
      if (blocker.type === 'human_verification') return '<small class="help">위 사람 원본 대조에서 각 사실 블록을 직접 확인하세요.</small>';
      if (blocker.type === 'automated_failure') return '<button type="button" class="button secondary compact" data-review-context="checks" data-review-scroll="automatic-quality">자동 품질 검사 확인</button>';
      if (blocker.type === 'safety' && staleBlock) return `<button type="button" class="button secondary compact" data-block-focus="${escape(staleBlock.id)}" data-review-context="checks" data-review-scroll="change-impact">원본 변경 영향 확인</button>`;
      if (blocker.type === 'safety' && blockedVerificationBlock) return `<button type="button" class="button secondary compact" data-block-focus="${escape(blockedVerificationBlock.id)}" data-review-context="checks">해당 사실 블록 확인</button>`;
      if (blocker.type === 'partial_source_acknowledgement') return '<button type="button" class="button secondary compact" data-workbench-focus="source" data-review-scroll="source-readiness">부분 원본 범위 확인</button>';
      return '';
    };
    const blockerMarkup = blockers.length
      ? `<section id="approval-blockers" class="notice danger" aria-live="polite"><h3>현재 버전을 승인할 수 없는 이유</h3><ul>${blockers.map((blocker) => `<li><strong>${escape(blocker.message)}</strong>${blocker.count ? ` · ${blocker.count}건` : ''}${blockerAction(blocker)}</li>`).join('')}</ul></section>`
      : '<section id="approval-blockers" class="notice success"><h3>승인 전제 충족</h3><p>자동 실패, 변경 영향, 불일치, 보류, 미확인 사실 블록이 없습니다.</p></section>';
    const assurance = review.run.execution?.evaluatorAssurance;
    const automaticSummary = `<section id="automatic-quality" class="review-boundary"><h3>자동 품질 평가</h3><p>${escape(assuranceLabel(assurance))}. 자동 평가는 사람 확인을 대신하지 않습니다.</p>${findingMarkup(review.automaticFindings)}</section>`;
    const verificationHistory = review.humanVerification.history.length
      ? `<details><summary>사람 확인 이력 ${review.humanVerification.history.length}건</summary><ul class="history-list">${review.humanVerification.history.map((entry) => `<li><strong>버전 ${entry.version_no} · ${escape(entry.reviewer_email)}</strong><p>${escape(entry.note || '메모 없음')}</p><small>${new Date(entry.verified_at).toLocaleString('ko-KR')} · ${entry.invalidated_at ? `무효화됨: ${escape(entry.invalidation_reason || '버전 또는 원본 변경')}` : '유효'}</small></li>`).join('')}</ul></details>`
      : '<p class="help">아직 사람 확인 이력이 없습니다.</p>';
    const commentHistory = `<section class="review-boundary"><h3>검토 의견</h3><form data-api="/api/artifacts/${artifact.id}/comments"><label>결과물 전체 의견<textarea name="body" maxlength="4000" required></textarea></label><button class="button secondary" type="submit">의견 저장</button></form>${review.comments.length ? `<ul class="history-list">${review.comments.map((comment) => `<li><strong>버전 ${comment.version_no} · ${escape(comment.block_key || '결과물 전체')} · ${escape(comment.author_email)}</strong><p>${escape(comment.body)}</p><small>${comment.resolved_at ? `해결됨 · ${escape(comment.resolved_by_email || '')}` : '미해결'}</small>${!comment.resolved_at ? `<form data-api="/api/artifacts/${artifact.id}/comments/${comment.id}/resolve"><button class="button secondary compact" type="submit">의견 해결 기록</button></form>` : ''}</li>`).join('')}</ul>` : '<p class="help">아직 검토 의견이 없습니다.</p>'}</section>`;
    const approvalControl = canOperate
      ? `<form class="approval-form" data-api="/api/artifacts/${artifact.id}/approve" aria-describedby="approval-blockers"><div class="approval-compact"><div class="approval-progress"><span class="approval-segments" aria-label="사람 원본 대조 ${humanVerificationProgress.completed}/${humanVerificationProgress.total} 완료">${verificationSegments || '<span class="verification-segment empty" aria-hidden="true"></span>'}</span><strong data-verification-progress aria-live="polite">${humanVerificationProgress.completed}/${humanVerificationProgress.total}</strong></div><button class="button primary" type="submit" ${artifact.approved || blockers.length ? 'disabled aria-disabled="true"' : ''}>${artifact.approved ? '승인됨' : '승인'}</button></div><div class="approval-detail">${blockers.length ? `<p class="error-text">승인 차단 · ${escape(blockers[0].message)}${blockers.length > 1 ? ` 외 ${blockers.length - 1}건` : ''}</p>` : '<p class="help">현재 버전의 승인 전제가 충족되었습니다.</p>'}<label>승인 메모<input name="note" maxlength="2000" placeholder="확인 범위와 승인 판단"></label></div></form>`
      : '<p class="help">Reviewer는 확인과 불일치를 기록할 수 있으며 최종 승인은 운영자 또는 관리자 역할이 수행합니다.</p>';
    const stale = blocks.some((block) => block.stale);
    const latestSourceAcknowledgementFields = () => latestSourceWarnings.length
      ? `<fieldset class="source-acknowledgements"><legend>최신 부분 원본 확인</legend>${latestSourceWarnings.map((source) => {
        const omissions = displayList(source.omissions);
        return `<label class="acknowledgement"><input type="checkbox" name="acknowledgedSourceSnapshotIds" value="${escape(source.snapshot_id)}" required><span>${escape(source.source_name)} · ${escape(source.title)}${omissions.length ? ` (${omissions.map(escape).join(' · ')})` : ''}</span></label>`;
      }).join('')}<p class="help">각 최신 원본의 누락 범위를 별도로 확인해야 합니다. 이 기록은 사람의 사실 검증이 아닙니다.</p></fieldset>`
      : '';
    const refreshControl = canOperate && stale
      ? `<form id="change-impact" class="refresh-form" data-api="/api/artifacts/${artifact.id}/refresh"><label>변경 영향 결정<select name="decision"><option value="patch">영향 블록만 부분 새로고침</option><option value="regenerate">전체 결과물 재생성</option><option value="keep">변경 영향을 확인하고 현재 결과 유지</option></select></label><label data-provider-control>생성 Provider<select name="providerId"><option value="">Provider 선택</option>${providers.map((provider) => `<option value="${provider.id}" ${provider.is_default ? 'selected' : ''}>${escape(provider.name)} · ${escape(provider.model)}${provider.is_default ? ' · 기본' : ''}</option>`).join('')}</select></label>${latestSourceAcknowledgementFields()}<label>결정 메모<textarea name="note" maxlength="2000" placeholder="유지 선택 시 변경 영향을 검토한 이유를 반드시 기록하세요."></textarea></label><button class="button secondary" type="submit">변경 영향 결정 기록</button></form>`
      : stale ? '<p class="help">운영자 또는 관리자만 변경 영향 결정을 기록할 수 있습니다.</p>' : '<p class="help">현재 버전에는 새로고침이 필요한 변경 영향 블록이 없습니다.</p>';
    const regenerationControl = canOperate && !stale && providers.length
      ? `<details class="regeneration-control"><summary>새 버전으로 전체 결과물 재생성</summary><p class="help">현재 결과와 사람 편집은 이력으로 보존합니다. 새 버전에서는 사람 원본 대조를 다시 기록해야 합니다.</p><button class="button secondary" type="button" data-dialog-open="regeneration-dialog">재생성 설정 열기</button><dialog id="regeneration-dialog"><form class="stack" data-api="/api/artifacts/${artifact.id}/regenerate" data-redirect="/app/runs"><div class="dialog-header"><h2>새 버전 재생성 확인</h2><button aria-label="닫기" type="button" data-dialog-close>×</button></div><label>생성 Provider<select name="providerId" required><option value="">Provider 선택</option>${providers.map((provider) => `<option value="${provider.id}" ${provider.is_default ? 'selected' : ''}>${escape(provider.name)} · ${escape(provider.model)}${provider.is_default ? ' · 기본' : ''}</option>`).join('')}</select></label>${latestSourceAcknowledgementFields()}<label class="acknowledgement"><input type="checkbox" name="confirmHumanVerificationReset" value="true" required> 새 불변 버전에서 사람 원본 대조가 다시 필요하다는 점을 확인했습니다.</label><p class="help">현재 버전은 바꾸지 않습니다. 새 실행과 새 버전은 실행 기록에서 확인할 수 있습니다.</p><div class="dialog-actions"><button class="button secondary" type="button" data-dialog-close>취소</button><button class="button danger" type="submit">새 버전 재생성 요청</button></div></form></dialog></details>`
      : stale ? '<p class="help">원본 변경이 있으므로 위 변경 영향 결정에서 전체 재생성을 선택하세요.</p>' : '';
    const markdownControl = artifact.approved && !blockers.length
      ? `<a class="button secondary" href="/api/artifacts/${artifact.id}/markdown">승인 버전 Markdown 다운로드</a>`
      : '<p class="help">Markdown은 현재 버전 승인 후에만 다운로드할 수 있습니다.</p>';
    const wordpressEligible = ['naver_blog', 'wordpress_article'].includes(artifact.channel);
    const wordpressControl = canOperate && wordpressEligible && artifact.approved && !blockers.length
      ? `<button class="button secondary" type="button" data-dialog-open="wordpress-dialog">WordPress 비공개 초안 만들기</button><dialog id="wordpress-dialog"><form class="stack" data-api="/api/artifacts/${artifact.id}/wordpress"><div class="dialog-header"><h2>WordPress 비공개 초안 만들기</h2><button aria-label="닫기" type="button" data-dialog-close>×</button></div><label>WordPress 주소<input name="wordpressBaseUrl" type="url" required></label><label>사용자명<input name="username" required></label><label>Application Password<input name="applicationPassword" type="password" required></label><section class="notice warning"><strong>공개 게시하지 않습니다.</strong><p>승인된 현재 버전을 WordPress의 draft 상태로만 생성합니다.</p></section><button class="button primary" type="submit">draft 생성 요청</button></form></dialog>`
      : wordpressEligible ? '<p class="help">WordPress draft는 운영자 승인 후에만 만들 수 있습니다.</p>' : '';
    const profileLabels = [review.profile.channel.label, review.profile.creatorIdentity?.label, review.profile.creatorVoice?.label, review.profile.audience?.label].filter(Boolean);
    const supportText = {
      supported: '자동 근거 지원',
      contradicted: '자동 불일치',
      insufficient: '자동 근거 부족',
      pending: '자동 검사 대기',
      human_verification_required_after_user_edit: '사람 편집 후 원본 대조 필요',
      not_applicable: '사실성 자동 검사 대상 아님'
    };
    const originText = {
      generated: '최초 생성',
      schema_repair: '구조 계약 복구',
      content_repair: '품질 복구',
      source_patch: '원본 변경 부분 새로고침',
      user_edit: '사람 편집'
    };
    const selectedPreview = blocks.map((block) => `<section class="selected-context" data-preview-for="${block.id}" hidden><p class="eyebrow">선택한 ${escape(blockTypeLabel(block.block_type))}</p><strong>${escape(block.content)}</strong><p>${escape(block.content_kind === 'factual' ? `영속 원본 위치 ${block.sourceRefs.length}개와 연결됨` : block.content_kind === 'editorial' ? '사용자가 승인한 편집 맥락' : '채널 제작 지시')}</p></section>`).join('');
    const selectedVersions = blocks.map((block) => `<section class="selected-context" data-version-for="${block.id}" hidden><h3>선택 블록의 현재 버전 상태</h3><p>${escape(originText[block.origin] || block.origin || '생성 경계 기록 없음')} · ${block.human_verified ? '현재 스냅샷 사람 확인 있음' : block.content_kind === 'factual' ? '현재 스냅샷 사람 확인 필요' : '사람 원본 대조 대상 아님'}</p><p>${block.stale ? '원본 변경 영향 있음' : '현재 저장 관계에서 원본 변경 영향 없음'}${block.held ? ' · 검토 보류 중' : ''}</p></section>`).join('');
    const selectedRuns = blocks.map((block) => {
      const automatic = block.auto_check || {};
      const deterministic = Array.isArray(automatic.deterministicChecks) ? automatic.deterministicChecks : [];
      return `<section class="selected-context" data-run-for="${block.id}" hidden><h3>선택 블록의 자동 실행 기록</h3><p>${escape(supportText[automatic.automaticSupport] || '자동 지원 결과가 기록됨')}</p><p>플랫폼 결정 검사 ${deterministic.filter((check) => check?.passed).length}/${deterministic.length} 통과 · ${escape(assuranceLabel(automatic.evaluatorAssurance))}</p>${automatic.deterministicRevalidated ? '<p>사람 편집 후 현재 Platform Profile 구조를 다시 검사했습니다.</p>' : ''}<p class="help">자동 실행 기록은 사람 확인 상태로 표시되지 않습니다.</p></section>`;
    }).join('');
    const versionHistory = `<section class="version-summary"><h3>불변 버전 이력</h3><ol class="history-list">${review.versions.map((version) => `<li><strong>버전 ${version.version_no}${version.current ? ' · 현재' : ''}</strong><p>${new Date(version.created_at).toLocaleString('ko-KR')}</p><small>생성·평가 설정은 이 버전과 함께 보관됩니다.</small></li>`).join('')}</ol><h3>승인 이력</h3>${review.approval.history.length ? `<ul class="history-list">${review.approval.history.map((approval) => `<li><strong>버전 ${approval.version_no} · ${approval.revoked_at ? '승인 무효화' : '유효 승인'}</strong><p>${escape(approval.note || '승인 메모 없음')}</p><small>${escape(approval.approver_email)} · ${new Date(approval.approved_at).toLocaleString('ko-KR')}</small></li>`).join('')}</ul>` : '<p class="help">아직 승인 이력이 없습니다.</p>'}<h3>내보내기 이력</h3>${review.exports.length ? `<ul class="history-list">${review.exports.map((row) => `<li><strong>버전 ${row.version_no} · ${escape(row.target)} · ${escape(statusLabel(row.status))}</strong><p>${escape(row.error_message || '오류 없음')}</p><small>${new Date(row.created_at).toLocaleString('ko-KR')}</small></li>`).join('')}</ul>` : '<p class="help">아직 내보내기 이력이 없습니다.</p>'}</section>`;
    const runHistory = `<section class="version-summary"><h3>현재 버전 생성 실행</h3>${review.run.type ? `<p>${escape(operationLabel(review.run.type))} · ${escape(statusLabel(review.run.status))}</p><p>${review.run.startedAt ? `시작 ${new Date(review.run.startedAt).toLocaleString('ko-KR')}` : '시작 대기'}${review.run.completedAt ? ` · 완료 ${new Date(review.run.completedAt).toLocaleString('ko-KR')}` : ''}</p>` : '<p class="help">이 버전에 연결된 실행 기록이 없습니다.</p>'}${review.run.execution ? `<dl class="run-boundary"><div><dt>진행 단계</dt><dd>${escape(operationLabel(review.run.execution.stage))}</dd></div><div><dt>생성 방식</dt><dd>이 버전의 구조화 생성 기록</dd></div><div><dt>평가 보증</dt><dd>${escape(assuranceLabel(review.run.execution.evaluatorAssurance))}</dd></div></dl>` : ''}</section>`;
    const contextTabs = `<div class="review-context-tabs" role="tablist" aria-label="선택 블록 검토 맥락"><button id="context-tab-preview" type="button" role="tab" aria-selected="true" aria-controls="context-preview" data-context-tab="context-preview">미리보기</button><button id="context-tab-checks" type="button" role="tab" aria-selected="false" aria-controls="context-checks" tabindex="-1" data-context-tab="context-checks">검사</button><button id="context-tab-versions" type="button" role="tab" aria-selected="false" aria-controls="context-versions" tabindex="-1" data-context-tab="context-versions">버전</button><button id="context-tab-run" type="button" role="tab" aria-selected="false" aria-controls="context-run" tabindex="-1" data-context-tab="context-run">실행</button></div>`;
    const contextPanels = `<section id="context-preview" role="tabpanel" aria-labelledby="context-tab-preview">${selectedPreview}<h3>채널 미리보기</h3>${preview}</section><section id="context-checks" role="tabpanel" aria-labelledby="context-tab-checks" hidden><div id="dynamic-checks">${blockPanels}</div>${automaticSummary}<section class="review-boundary"><h3>사람 확인 기록</h3>${verificationHistory}</section></section><section id="context-versions" role="tabpanel" aria-labelledby="context-tab-versions" hidden>${selectedVersions}${versionHistory}</section><section id="context-run" role="tabpanel" aria-labelledby="context-tab-run" hidden>${selectedRuns}${runHistory}</section>`;
    const reviewPanel = `<section id="review-panel" class="pane review-pane" role="tabpanel" aria-labelledby="workbench-tab-review"><h2>검사와 승인</h2>${approvalControl}<p id="selected-block-label">블록을 선택하면 원본과 미리보기·검사·버전·실행 맥락이 함께 바뀝니다.</p>${contextTabs}${contextPanels}${verificationQueueMarkup}${blockerMarkup}${commentHistory}<div class="action-stack">${refreshControl}${regenerationControl}${markdownControl}${wordpressControl}</div></section>`;
    const mobileTabs = `<div class="mobile-workbench-tabs" role="tablist" aria-label="검토 작업 영역"><button id="workbench-tab-source" role="tab" type="button" aria-selected="true" aria-controls="workbench-source" data-workbench-tab="workbench-source">원본</button><button id="workbench-tab-edit" role="tab" type="button" aria-selected="false" aria-controls="workbench-edit" data-workbench-tab="workbench-edit" tabindex="-1">편집</button><button id="workbench-tab-review" role="tab" type="button" aria-selected="false" aria-controls="review-panel" data-workbench-tab="review-panel" tabindex="-1">검토</button></div>`;
    res.send(layout({ user: req.user, title: 'Review Workbench', summary: `현재 상태: ${statusLabel(artifact.state)}`, current: 'inbox', csrf: req.user.csrf, body: `${mobileTabs}<div class="workbench">${sourcePanel}${editorPanel}${reviewPanel}</div>` }));
  } catch (error) { next(error); } });

  app.get('/app/settings', protect('administrator'), async (req, res, next) => { try {
    const [providers, identities, voices, personas, channels] = await Promise.all([
      db.query('SELECT id,name,provider_type,base_url,model,enabled,is_default,secret_ciphertext IS NOT NULL AS ready,last_test_status,last_tested_at,last_test_model,last_test_error,created_at FROM model_provider_configs WHERE workspace_id=$1 ORDER BY is_default DESC,created_at DESC', [req.user.workspaceId]),
      db.query('SELECT v.id,v.version_no,count(f.id)::int AS fact_count FROM creator_identity_versions v LEFT JOIN creator_identity_facts f ON f.identity_version_id=v.id WHERE v.workspace_id=$1 GROUP BY v.id ORDER BY v.version_no DESC', [req.user.workspaceId]),
      db.query('SELECT version_no,guidance FROM creator_voice_versions WHERE workspace_id=$1 ORDER BY version_no DESC LIMIT 1', [req.user.workspaceId]),
      db.query('SELECT version_no,name,needs FROM audience_persona_versions WHERE workspace_id=$1 ORDER BY version_no DESC LIMIT 1', [req.user.workspaceId]),
      workspaceChannelCatalog(db, req.user.workspaceId)
    ]);
    const body = `<section class="settings-grid"><section><h2>Model Provider</h2><p class="help">기본값은 Upstage Solar Open2입니다. API Key는 암호화되어 저장되며 화면이나 실행 기록에는 표시되지 않습니다.</p><form class="stack" data-api="/api/providers"><label>Provider 이름<input name="name" required></label><label>종류<select name="providerType"><option value="solar">Solar preset</option><option value="openai_compatible">OpenAI-compatible</option></select></label><label>Endpoint<input name="baseUrl" type="url" required value="https://api.upstage.ai/v1"></label><label>Model<input name="model" required value="solar-open2"></label><label>API Key (변경할 때만)<input name="apiKey" type="password"></label><label><input type="checkbox" name="isDefault" value="true"> 이 작업공간의 기본 Provider로 사용</label><button class="button primary" type="submit">Provider 저장</button></form>
${providers.map((provider) => `<article class="row-card"><div><h3>${escape(provider.name)}${provider.is_default ? ' · 기본' : ''}</h3><p>${escape(provider.provider_type)} · ${escape(provider.model)} · ${provider.ready ? '암호화된 키 저장됨' : 'API Key 필요'}</p><small>${escape(provider.base_url)}</small><small class="${provider.last_test_status === 'failed' ? 'error-text' : ''}">${provider.last_test_status === 'succeeded' ? `연결 검사 성공 · 응답 모델 ${escape(provider.last_test_model || provider.model)} · ${new Date(provider.last_tested_at).toLocaleString('ko-KR')}` : provider.last_test_status === 'failed' ? `연결 검사 실패 · ${escape(provider.last_test_error || '응답 계약을 확인하세요.')} · ${new Date(provider.last_tested_at).toLocaleString('ko-KR')}` : '아직 실제 Provider 연결 검사를 실행하지 않았습니다.'}</small></div><form data-api="/api/providers/${provider.id}/test"><button class="button secondary" type="submit" ${provider.ready ? '' : 'disabled'}>실제 응답 연결 검사</button></form></article>`).join('') || '<p class="empty">등록한 Provider가 없습니다.</p>'}
<h2>채널 카탈로그</h2><p class="help">채널 정의 버전은 영속되고, 여기서 활성화한 채널만 계획 화면에서 선택할 수 있습니다. 새 구조는 코드와 검증을 함께 추가해야 합니다.</p>${channels.map((channel) => `<article class="row-card"><div><h3>${escape(channel.display_name)} · v${channel.version_no}</h3><p>${escape(channel.description)}</p><small>${channel.active ? '계획 화면에서 활성' : '계획 화면에서 비활성'}</small></div><form data-api="/api/channels/${channel.channel}/activation"><input type="hidden" name="active" value="${channel.active ? 'false' : 'true'}"><button class="button secondary" type="submit">${channel.active ? '비활성화' : '활성화'}</button></form></article>`).join('')}</section><section><h2>Creator Identity</h2><form class="stack" data-api="/api/creator/identity"><label>사실<input name="claim" required placeholder="예: AI 제품을 운영한다"></label><label>근거 URL<input name="evidenceUrl" type="url" required></label><label>근거 설명<textarea name="evidenceNote" required></textarea></label><button class="button primary" type="submit">근거 있는 사실 저장</button></form>${identities.map((identity) => `<p>버전 ${identity.version_no} · 근거 사실 ${identity.fact_count}건</p>`).join('')}<h2>Creator Voice</h2><form class="stack" data-api="/api/creator/voice"><label>문체 가이드<textarea name="guidance" required>${escape(voices[0]?.guidance || '')}</textarea></label><button class="button secondary" type="submit">문체 버전 저장</button></form><h2>Audience Persona</h2><form class="stack" data-api="/api/audience"><label>이름<input name="name" required value="${escape(personas[0]?.name || '')}"></label><label>필요<textarea name="needs" required>${escape(personas[0]?.needs || '')}</textarea></label><label>제약<textarea name="constraints" required></textarea></label><label>근거 설명<textarea name="evidenceNote" required></textarea></label><button class="button secondary" type="submit">Audience 버전 저장</button></form></section></section>`;
    res.send(layout({ user: req.user, title: '설정', summary: '근거·문체·대상·모델 경계를 버전으로 관리합니다.', current: 'settings', csrf: req.user.csrf, body }));
  } catch (error) { next(error); } });

  app.get('/app/runs', protect('administrator', 'operator', 'reviewer'), async (req, res, next) => { try {
    const canOperate = req.user.role === 'administrator' || req.user.role === 'operator';
    const requestedRunId = typeof req.query.run === 'string' && req.query.run.length <= 160
      ? req.query.run
      : null;
    const [runs, outputs, exports, selectedRunRows] = await Promise.all([
      db.query('SELECT * FROM runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.workspaceId]),
      db.query(`SELECT po.id,po.output_type,po.status,po.quality_status,po.error_message,po.artifact_id,
          definition.display_name,a.state AS artifact_state
        FROM plan_outputs po
        JOIN plans p ON p.id=po.plan_id
        JOIN channel_definition_versions definition ON definition.id=po.channel_definition_version_id
        LEFT JOIN artifacts a ON a.id=po.artifact_id
        WHERE p.workspace_id=$1 ORDER BY po.created_at DESC LIMIT 100`, [req.user.workspaceId]),
      db.query(`SELECT e.*,a.channel FROM exports e JOIN artifact_versions av ON av.id=e.artifact_version_id JOIN artifacts a ON a.id=av.artifact_id WHERE a.workspace_id=$1 ORDER BY e.created_at DESC LIMIT 100`, [req.user.workspaceId]),
      requestedRunId
        ? db.query(`SELECT * FROM runs
          WHERE id=$1 AND workspace_id=$2
            AND run_type IN ('artifact_generation','artifact_generation_retry')`, [requestedRunId, req.user.workspaceId])
        : Promise.resolve([])
    ]);
    const selectedRun = selectedRunRows[0] || null;
    const generationRunIds = [...new Set([
      ...runs.filter(isGenerationRun).map((run) => run.id),
      ...(selectedRun ? [selectedRun.id] : [])
    ])];
    const targetsByRun = runTargetsByRun(await loadGenerationRunTargets(
      db,
      req.user.workspaceId,
      generationRunIds
    ));
    const selectedTargets = selectedRun ? targetsByRun.get(selectedRun.id) || [] : [];
    const providers = canOperate ? await db.query(`SELECT id,name,model,is_default
      FROM model_provider_configs WHERE workspace_id=$1 AND enabled=true
        AND provider_type<>'fixture' AND secret_ciphertext IS NOT NULL
      ORDER BY is_default DESC,name`, [req.user.workspaceId]) : [];
    const activeOutputs = outputs.some((output) => output.status === 'queued' || output.status === 'running');
    const selectedRunActive = Boolean(selectedRun && (
      ['queued', 'running'].includes(selectedRun.status)
      || selectedTargets.some((target) => ['queued', 'running'].includes(targetStatus(target)))
    ));
    const liveRefresh = selectedRun ? selectedRunActive : activeOutputs;
    const refreshHref = selectedRun ? generationRunHref(selectedRun.id) : '/app/runs';
    const retryProviderOptions = providers.map((provider) => `<option value="${provider.id}" ${provider.is_default ? 'selected' : ''}>${escape(provider.name)} · ${escape(provider.model)}</option>`).join('');
    const retryEvaluatorOptions = providers.map((provider) => `<option value="${provider.id}">${escape(provider.name)} · ${escape(provider.model)}</option>`).join('');
    const runsRows = runs.length ? runs.map((run) => {
      const time = run.started_at
        ? `시작 ${new Date(run.started_at).toLocaleString('ko-KR')}${run.completed_at ? ` · 종료 ${new Date(run.completed_at).toLocaleString('ko-KR')}` : ''}`
        : '대기 중';
      return `<tr><td data-label="유형" data-mobile-primary>${escape(isGenerationRun(run) ? generationRunLabel(run) : operationLabel(run.run_type))}</td><td data-label="상태와 사유">${badge(run.status)}${run.error_message ? `<small class="error-text">${escape(run.error_message)}</small>` : ''}</td><td data-label="시작과 종료">${time}</td><td data-label="다음 작업">${generationRunNextAction(run, targetsByRun.get(run.id) || [])}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="empty">아직 실행 기록이 없습니다.</td></tr>';
    const outputRows = outputs.length ? outputs.map((output) => {
      const nextAction = output.error_message
        ? `<span class="error-text">${escape(output.error_message)}</span>`
        : output.status === 'succeeded'
          ? output.quality_status === 'warning'
            ? '부분 원본 경고가 있습니다. 사람 확인을 마친 뒤 승인할 수 있습니다.'
            : '자동 검사 결과가 저장되었습니다. 사람 확인을 마친 뒤 승인할 수 있습니다.'
          : output.status === 'failed'
            ? '실패 상태와 이전 결과물은 유지됩니다.'
            : 'Worker가 실제 모델 작업을 처리 중입니다.';
      const retry = output.status === 'failed' && canOperate && providers.length
        ? `<form data-api="/api/plan-outputs/${output.id}/retry" data-run-result-redirect="/app/runs"><label>재시도 생성 Provider<select name="providerId" required>${retryProviderOptions}</select></label><label>재시도 평가 Provider<select name="evaluatorProviderId"><option value="">${escape(assuranceLabel('LOW_ASSURANCE'))}</option>${retryEvaluatorOptions}</select></label><small>독립 Provider를 선택하면 평가 분리가 새 실행에 영속됩니다.</small><button class="button secondary compact" aria-label="실패한 결과물 다시 생성 · ${escape(output.display_name || channelName(output.output_type))}" type="submit">${escape(output.display_name || channelName(output.output_type))} 다시 생성</button></form>`
        : '';
      return `<tr><td data-label="채널" data-mobile-primary>${escape(output.display_name || channelName(output.output_type))}</td><td data-label="상태">${badge(output.status)}${output.artifact_state ? `<small>${escape(statusLabel(output.artifact_state))}</small>` : ''}</td><td data-label="결과물">${output.artifact_id ? `<a class="button secondary compact" href="/app/review/${escape(output.artifact_id)}">Review Workbench 열기</a>` : '생성 중'}</td><td data-label="오류와 다음 작업">${nextAction}${retry}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="empty">아직 생성한 결과물이 없습니다.</td></tr>';
    const body = `<section class="split-header"><div><h2>실행 기록</h2><p>${selectedRun ? (selectedRunActive ? '이번 생성의 실제 작업 상태를 5초마다 갱신합니다.' : '선택한 생성 실행의 저장된 결과와 다음 검토 행동을 확인합니다.') : (activeOutputs ? '생성 작업이 실행 중입니다. 이 화면은 5초 후 실제 DB 상태로 갱신됩니다.' : '실패와 재시도 경계도 영속적으로 보관합니다.')}</p></div><a class="button secondary" href="${escape(refreshHref)}">현재 상태 새로고침</a></section>${liveRefresh ? '<div data-live-refresh="5000" aria-live="polite">생성 상태를 갱신합니다.</div>' : ''}${selectedGenerationSummary(selectedRun, selectedTargets)}<section class="table-wrap"><table><thead><tr><th>유형</th><th>상태 / 사유</th><th>시작 / 종료</th><th>다음 작업</th></tr></thead><tbody>${runsRows}</tbody></table></section><section id="generation-outputs" class="table-wrap"><h2>결과물 생성 상태</h2><table><thead><tr><th>채널</th><th>상태</th><th>결과물</th><th>오류 / 다음 작업</th></tr></thead><tbody>${outputRows}</tbody></table></section><section class="table-wrap"><h2>내보내기 기록</h2><p class="export-guidance">승인된 결과물만 내보낼 수 있습니다. 승인 대기 결과물은 Review Workbench에서 사람 대조를 먼저 마치세요.</p><table><thead><tr><th>대상</th><th>상태</th><th>외부 식별자</th><th>오류</th></tr></thead><tbody>${exports.length ? exports.map((row) => `<tr><td data-label="대상" data-mobile-primary>${escape(row.target)}</td><td data-label="상태">${badge(row.status)}</td><td data-label="외부 식별자">${escape(row.external_id || '—')}</td><td data-label="오류">${escape(row.error_message || '—')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">아직 내보낸 결과물이 없습니다.</td></tr>'}</tbody></table></section>`;
    res.send(layout({ user: req.user, title: '실행 기록', summary: selectedRun ? '이번 생성의 결과와 다음 검토 행동을 확인합니다.' : '실패와 재시도 경계도 영속적으로 보관합니다.', current: 'runs', csrf: req.user.csrf, body }));
  } catch (error) { next(error); } });

  app.post('/api/sources', protect('administrator', 'operator'), csrf, api(async (req) => {
    const sourceId = await registerRssSource(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      name: req.body.name,
      feedUrl: req.body.feedUrl,
      rightsStatus: requiredRightsStatus(req.body.rightsStatus)
    });
    await requestConnectorSync(db, { workspaceId: req.user.workspaceId, sourceId, userId: req.user.id });
    return { status: 'queued' };
  }));
  app.post('/api/transcripts', protect('administrator', 'operator'), csrf, api(async (req) => ({
    status: 'queued',
    ...(await registerTranscriptUpload(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      name: req.body.name,
      title: req.body.title,
      body: req.body.body,
      filename: req.body.filename,
      canonicalUrl: req.body.canonicalUrl,
      rightsStatus: requiredRightsStatus(req.body.rightsStatus)
    }))
  })));
  app.post('/api/youtube', protect('administrator', 'operator'), csrf, api(async (req) => ({
    status: 'queued',
    ...(await registerYouTubeMetadata(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      name: req.body.name,
      videoUrl: req.body.videoUrl,
      rightsStatus: requiredRightsStatus(req.body.rightsStatus)
    }))
  })));
  app.post('/api/sources/:sourceId/sync', protect('administrator', 'operator'), csrf, api(async (req) => { await requestConnectorSync(db, { workspaceId: req.user.workspaceId, sourceId: req.params.sourceId, userId: req.user.id }); return { status: 'queued' }; }));
  app.post('/api/sources/:sourceId/retry-impact', protect('administrator', 'operator'), csrf, api(async (req) => ({
    status: 'queued',
    ...await retryFailedSourceImpact(db, {
      workspaceId: req.user.workspaceId,
      sourceId: req.params.sourceId,
      userId: req.user.id
    })
  })));
  app.post('/api/sources/items/:sourceItemId/reassess-readiness', protect('administrator', 'operator'), csrf, api(async (req) => requestSourceReadinessReassessment(db, {
    workspaceId: req.user.workspaceId,
    sourceItemId: req.params.sourceItemId,
    userId: req.user.id
  })));
  app.post('/api/providers', protect('administrator'), csrf, api(async (req) => ({ providerId: await saveModelProvider(db, { workspaceId: req.user.workspaceId, userId: req.user.id, name: req.body.name, providerType: req.body.providerType, baseUrl: req.body.baseUrl, model: req.body.model, apiKey: req.body.apiKey, isDefault: req.body.isDefault === true || req.body.isDefault === 'true', environment: config.environment, secretKey: config.secretKey, testMode: config.testMode, allowInsecureCredentialTransport: config.network?.allowInsecureCredentialTransport }) })));
  app.post('/api/providers/:providerId/test', protect('administrator'), csrf, api(async (req) => testProvider(db, req.user.workspaceId, req.params.providerId, config)));
  app.post('/api/channels/:channel/activation', protect('administrator'), csrf, api(async (req) => setChannelActive(db, { workspaceId: req.user.workspaceId, channel: req.params.channel, active: req.body.active === true || req.body.active === 'true' })));
  app.post('/api/creator/identity', protect('administrator'), csrf, api(async (req) => ({ versionId: await saveCreatorIdentity(db, { workspaceId: req.user.workspaceId, userId: req.user.id, facts: [{ claim: req.body.claim, evidenceUrl: req.body.evidenceUrl, evidenceNote: req.body.evidenceNote }] }) })));
  app.post('/api/creator/voice', protect('administrator'), csrf, api(async (req) => ({ versionId: await saveCreatorVoice(db, { workspaceId: req.user.workspaceId, userId: req.user.id, guidance: req.body.guidance }) })));
  app.post('/api/audience', protect('administrator'), csrf, api(async (req) => ({ versionId: await saveAudiencePersona(db, { workspaceId: req.user.workspaceId, userId: req.user.id, name: req.body.name, needs: req.body.needs, constraints: req.body.constraints, evidenceNote: req.body.evidenceNote }) })));
  app.post('/api/planner-suggestions', protect('administrator', 'operator'), csrf, api(async (req) =>
    requestPlannerSuggestion(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      sourceItemId: req.body.sourceItemId,
      expectedSnapshotId: req.body.expectedSnapshotId,
      providerId: req.body.providerId,
      creatorIdentityVersionId: req.body.creatorIdentityVersionId || null,
      creatorVoiceVersionId: req.body.creatorVoiceVersionId || null,
      audiencePersonaVersionId: req.body.audiencePersonaVersionId || null,
      idempotencyKey: req.get('idempotency-key')
    }, config)));
  app.get('/api/planner-suggestions/:suggestionRunId', protect('administrator', 'operator', 'reviewer'), api(async (req) =>
    getPlannerSuggestion(db, {
      workspaceId: req.user.workspaceId,
      suggestionRunId: req.params.suggestionRunId
    })));
  app.post('/api/planner-suggestions/:suggestionRunId/retry', protect('administrator', 'operator'), csrf, api(async (req) =>
    retryPlannerSuggestion(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      suggestionRunId: req.params.suggestionRunId,
      idempotencyKey: req.get('idempotency-key'),
      providerId: req.body.providerId || null
    }, config)));
  app.post('/api/plans', protect('administrator', 'operator'), csrf, api(async (req) => {
    const [catalog, sourceContract] = await Promise.all([
      activeChannelCatalog(db, req.user.workspaceId),
      sourceSelectionsFromPlannerSuggestion(db, {
        workspaceId: req.user.workspaceId,
        sourceItemId: req.body.sourceItemId,
        expectedSnapshotId: req.body.expectedSnapshotId,
        suggestionRunId: req.body.plannerSuggestionRunId || null,
        supplementalSnapshotIds: stringList(req.body.supplementalSnapshotIds),
        creatorIdentityVersionId: req.body.creatorIdentityVersionId || null,
        creatorVoiceVersionId: req.body.creatorVoiceVersionId || null,
        audiencePersonaVersionId: req.body.audiencePersonaVersionId || null
      })
    ]);
    return createPlan(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      sourceItemId: req.body.sourceItemId,
      sourceSelections: sourceContract.sourceSelections,
      plannerSuggestionRunId: sourceContract.plannerSuggestionRunId,
      creatorIdentityVersionId: req.body.creatorIdentityVersionId || null,
      creatorVoiceVersionId: req.body.creatorVoiceVersionId || null,
      audiencePersonaVersionId: req.body.audiencePersonaVersionId || null,
      commonCta: req.body.commonCta,
      outputs: planOutputsFromRequest(req.body, catalog),
      providerId: req.body.providerId,
      evaluatorProviderId: req.body.evaluatorProviderId || null,
      sourceReadinessAcknowledged: bool(req.body.sourceReadinessAcknowledged),
      supplementalReadinessAcknowledged: bool(req.body.supplementalReadinessAcknowledged)
    });
  }));
  app.post('/api/plan-outputs/:planOutputId/retry', protect('administrator', 'operator'), csrf, api(async (req) => retryPlanOutput(db, {
    workspaceId: req.user.workspaceId,
    userId: req.user.id,
    planOutputId: req.params.planOutputId,
    providerId: req.body.providerId,
    evaluatorProviderId: req.body.evaluatorProviderId || null
  })));
  app.get('/api/artifacts/:artifactId/review', protect('administrator', 'operator', 'reviewer'), api(async (req) => getArtifactReview(db, req.user.workspaceId, req.params.artifactId)));
  app.post('/api/blocks/:blockId/verify', protect('administrator', 'operator', 'reviewer'), csrf, api(async (req) => { await verifyBlock(db, { workspaceId: req.user.workspaceId, userId: req.user.id, blockId: req.params.blockId, note: req.body.note }); return { status: 'verified' }; }));
  app.post('/api/blocks/:blockId/conflict', protect('administrator', 'operator', 'reviewer'), csrf, api(async (req) => {
    const result = await setBlockConflict(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      blockId: req.params.blockId,
      conflict: bool(req.body.conflict),
      note: req.body.note
    });
    return { status: 'updated', evidenceState: result.evidenceState };
  }));
  app.post('/api/blocks/:blockId/hold', protect('administrator', 'operator', 'reviewer'), csrf, api(async (req) => { await setBlockHold(db, { workspaceId: req.user.workspaceId, userId: req.user.id, blockId: req.params.blockId, held: String(req.body.held) === 'true' }); return { status: 'updated' }; }));
  app.post('/api/artifacts/:artifactId/comments', protect('administrator', 'operator', 'reviewer'), csrf, api(async (req) => addArtifactComment(db, {
    workspaceId: req.user.workspaceId,
    userId: req.user.id,
    artifactId: req.params.artifactId,
    blockId: req.body.blockId || null,
    body: req.body.body
  })));
  app.post('/api/artifacts/:artifactId/comments/:commentId/resolve', protect('administrator', 'operator', 'reviewer'), csrf, api(async (req) => resolveArtifactComment(db, {
    workspaceId: req.user.workspaceId,
    userId: req.user.id,
    artifactId: req.params.artifactId,
    commentId: req.params.commentId
  })));
  app.post('/api/artifacts/:artifactId/blocks/:blockId/edit', protect('administrator', 'operator', 'reviewer'), csrf, api(async (req) => {
    const sourcePositions = Array.isArray(req.body.sourcePositions)
      ? req.body.sourcePositions
      : req.body.sourcePositions ? [req.body.sourcePositions] : [];
    const result = await editArtifactBlock(db, {
      workspaceId: req.user.workspaceId,
      userId: req.user.id,
      artifactId: req.params.artifactId,
      blockId: req.params.blockId,
      content: req.body.content,
      sourcePositions,
      note: req.body.note
    });
    return { status: 'version_created', versionNo: result.versionNo, carriedVerificationCount: result.carriedVerificationCount };
  }));
  app.post('/api/artifacts/:artifactId/approve', protect('administrator', 'operator'), csrf, api(async (req) => { await approveArtifact(db, { workspaceId: req.user.workspaceId, userId: req.user.id, artifactId: req.params.artifactId, note: req.body.note }); return { status: 'approved' }; }));
  app.post('/api/artifacts/:artifactId/regenerate', protect('administrator', 'operator'), csrf, api(async (req) => requestRegeneration(db, {
    workspaceId: req.user.workspaceId,
    userId: req.user.id,
    artifactId: req.params.artifactId,
    providerId: req.body.providerId,
    acknowledgedSourceSnapshotIds: stringList(req.body.acknowledgedSourceSnapshotIds),
    confirmHumanVerificationReset: bool(req.body.confirmHumanVerificationReset)
  })));
  app.post('/api/artifacts/:artifactId/refresh', protect('administrator', 'operator'), csrf, api(async (req) => recordRefreshDecision(db, {
    workspaceId: req.user.workspaceId,
    userId: req.user.id,
    artifactId: req.params.artifactId,
    decision: req.body.decision,
    providerId: req.body.providerId || null,
    note: req.body.note,
    acknowledgedSourceSnapshotIds: stringList(req.body.acknowledgedSourceSnapshotIds)
  })));
  app.get('/api/artifacts/:artifactId/markdown', protect('administrator', 'operator', 'reviewer'), async (req, res, next) => { try { const markdown = await exportMarkdown(db, { workspaceId: req.user.workspaceId, userId: req.user.id, artifactId: req.params.artifactId }); res.set({ 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="osau-artifact.md"' }).send(markdown); } catch (error) { next(error); } });
  app.post('/api/artifacts/:artifactId/wordpress', protect('administrator', 'operator'), csrf, api(async (req) => exportWordPressDraft(db, { workspaceId: req.user.workspaceId, userId: req.user.id, artifactId: req.params.artifactId, wordpressBaseUrl: req.body.wordpressBaseUrl, username: req.body.username, applicationPassword: req.body.applicationPassword, environment: config.environment, testMode: config.testMode, network: config.network })));

  app.use((req, _res, next) => next(issue('NOT_FOUND', '요청한 화면 또는 작업을 찾을 수 없습니다.', 404)));
  app.use((error, req, res, _next) => {
    const publicError = asPublicError(error);
    if (config.environment !== 'test') console.error(JSON.stringify({ request: req.method, path: req.path, code: publicError.code, message: redact(error.message) }));
    if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/ready') return res.status(error.status || 500).json({ error: publicError });
    res.status(error.status || 500).send(errorPage(error, req));
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const environment = process.env.NODE_ENV || 'development';
  const internalNetworkMode = process.env.OSAU_INTERNAL_NETWORK_MODE === 'true';
  const authDisabled = process.env.OSAU_AUTH_DISABLED === 'true';
  if (authDisabled && !internalNetworkMode) {
    throw issue('AUTH_DISABLED_REQUIRES_INTERNAL_NETWORK_MODE', 'OSAU_AUTH_DISABLED=true를 사용하려면 OSAU_INTERNAL_NETWORK_MODE=true를 함께 명시해야 합니다.', 500);
  }
  const config = {
    environment,
    internalNetworkMode,
    authDisabled,
    internalPeerAddressPreserved: process.env.OSAU_INTERNAL_PEER_ADDRESS_PRESERVED !== 'false',
    cookieSecure: process.env.OSAU_COOKIE_SECURE === 'true' || (process.env.OSAU_COOKIE_SECURE !== 'false' && environment === 'production'),
    secretKey: process.env.SECRET_ENCRYPTION_KEY,
    testMode: process.env.OSAU_TEST_MODE === '1',
    modelMaxTokens: Number(process.env.OSAU_MODEL_MAX_TOKENS) || 4096,
    modelTimeoutMs: Number(process.env.OSAU_MODEL_TIMEOUT_MS) || 120000,
    modelReasoningEffort: process.env.OSAU_MODEL_REASONING_EFFORT || 'none',
    plannerSuggestionBatchSize: Number(process.env.OSAU_PLANNER_CORPUS_BATCH_SIZE) || 10,
    plannerSuggestionSourceCharBudget: Number(process.env.OSAU_PLANNER_SOURCE_CHAR_BUDGET) || 4_000,
    plannerSuggestionMaxSupplementalSources: Number(process.env.OSAU_PLANNER_MAX_SUPPLEMENTAL_SOURCES) || 8,
    network: { allowPrivateNetworks: process.env.OSAU_ALLOW_PRIVATE_NETWORKS === '1' }
  };
  const db = createPostgresDatabase(process.env.DATABASE_URL);
  await bootstrapAdministrator(db, { email: process.env.OSAU_ADMIN_EMAIL, password: process.env.OSAU_ADMIN_PASSWORD });
  await bootstrapUpstageSolarProvider(db, { apiKey: process.env.UPSTAGE_API_KEY, environment, secretKey: config.secretKey, model: process.env.UPSTAGE_MODEL || 'solar-open2' });
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  const server = createApp({ db, config }).listen(port, host, () => {
    console.log(`OSAU web listening on ${host}:${port}${authDisabled ? ' (private-network auth-disabled mode)' : ''}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { server.close(); await db.close(); process.exit(0); });
}
