const STATUS = Object.freeze({
  idle: { label: '대기', tone: 'neutral', icon: 'minus' },
  queued: { label: '대기열', tone: 'progress', icon: 'progress' },
  running: { label: '실행 중', tone: 'progress', icon: 'progress' },
  retrying: { label: '다시 시도 중', tone: 'progress', icon: 'progress' },
  succeeded: { label: '완료', tone: 'done', icon: 'check' },
  failed: { label: '실패', tone: 'blocked', icon: 'blocked' },
  draft: { label: '초안', tone: 'neutral', icon: 'minus' },
  review_required: { label: '확인 필요', tone: 'attention', icon: 'attention' },
  stale: { label: '원본 변경', tone: 'attention', icon: 'attention' },
  source_update_pending: { label: '원본 변경 처리 중', tone: 'progress', icon: 'progress' },
  approved: { label: '승인됨', tone: 'done', icon: 'check' },
  exported: { label: '내보냄', tone: 'done', icon: 'check' },
  held: { label: '보류', tone: 'blocked', icon: 'blocked' }
});

const EVIDENCE = Object.freeze({
  verified: { label: '확인됨', tone: 'done', icon: 'check' },
  review_required: { label: '확인 필요', tone: 'attention', icon: 'attention' },
  conflict: { label: '불일치', tone: 'blocked', icon: 'blocked' },
  not_required: { label: '근거 불필요', tone: 'neutral', icon: 'minus' }
});

const READINESS = Object.freeze({
  complete: '완전한 원본',
  partial: '부분 원본',
  incompatible: '권리 제한',
  insufficient: '근거 부족',
  quarantined: '보안 격리'
});

const RIGHTS = Object.freeze({
  owned: '직접 보유',
  licensed: '사용 허가 있음',
  unknown: '권리 미확인',
  restricted: '파생 사용 제한'
});

const OMISSIONS = Object.freeze({
  DESCRIPTION_ONLY: 'RSS 설명만 수집되어 본문 일부가 누락될 수 있음',
  NAVER_DESCRIPTION_ONLY: 'Naver RSS 요약만 수집되어 원문 전체가 아님',
  BODY_TRUNCATED: '수집 크기 제한으로 본문 일부가 잘림',
  BODY_TRUNCATED_AT_STORAGE_LIMIT: '수집 크기 제한으로 본문 일부가 잘림',
  SOURCE_DESCRIPTION_APPEARS_PARTIAL: '요약만 수집됨 (본문 미확보)',
  YOUTUBE_TRANSCRIPT_MISSING: 'YouTube 공식 metadata만 수집되어 전사 내용은 포함되지 않음',
  NO_USABLE_EVIDENCE: '사용할 수 있는 사실 근거가 없음',
  LEGACY_READINESS_UNKNOWN: '이전 스냅샷이라 수집 범위를 다시 확인해야 함',
  RIGHTS_RESTRICTED: '파생 콘텐츠 사용 권리가 제한됨',
  INDIRECT_PROMPT_INJECTION_RISK: '원본에 보안상 격리해야 하는 지시 형태가 감지됨'
});

const OPERATIONS = Object.freeze({
  artifact_generation: '결과물 생성',
  artifact_generation_retry: '결과물 생성 재시도',
  artifact_patch: '변경 블록 새로고침',
  artifact_regeneration: '전체 결과물 재생성',
  planner_suggestion: '채널 설정 추천',
  ingest_transcript: '전사 수집',
  ingest_youtube_metadata: 'YouTube metadata 수집',
  sync_rss: 'RSS 동기화',
  apply_source_update: '원본 변경 영향 계산',
  artifact_finalize: '결과물 저장'
});

const BLOCK_TYPES = Object.freeze({
  title: '제목',
  intro: '도입',
  heading: '소제목',
  paragraph: '문단',
  tag: '태그',
  cta: '행동 문구',
  excerpt: '요약',
  preheader: '프리헤더',
  subject: '제목',
  hook: '첫 문장',
  narration: '내레이션',
  on_screen_text: '화면 자막',
  visual_direction: '시각 제작 지시',
  ending: '마무리',
  caption: '게시 캡션',
  cover_text: '커버 문구'
});

const CONNECTORS = Object.freeze({
  rss: 'RSS 피드',
  transcript_upload: '업로드 전사',
  youtube_metadata: 'YouTube 공식 metadata'
});

const BODY_KINDS = Object.freeze({
  transcript_upload: '업로드 전사',
  transcript: '업로드 전사',
  youtube_metadata: 'YouTube 공식 metadata',
  metadata: '공식 metadata',
  content_encoded: 'RSS 본문',
  description: 'RSS 요약'
});

const ASSURANCE = Object.freeze({
  LOW_ASSURANCE: '생성 Provider와 동일 · 보증 낮음',
  HIGH_ASSURANCE: '생성·평가 Provider 분리 · 보증 높음'
});

const ICONS = Object.freeze({
  check: '<path d="m4 12 5 5L20 6"/>',
  attention: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  blocked: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  progress: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  minus: '<path d="M5 12h14"/>'
});

const fallback = (label = '상태 확인 필요') => ({ label, tone: 'neutral', icon: 'minus' });

export function statusPresentation(status) {
  return STATUS[status] || fallback();
}

export function evidencePresentation(status) {
  return EVIDENCE[status] || fallback('근거 상태 확인 필요');
}

export function statusLabel(status) {
  return statusPresentation(status).label;
}

export function readinessLabel(readiness) {
  return READINESS[readiness] || '수집 범위 확인 필요';
}

export function rightsLabel(rights) {
  return RIGHTS[rights] || '권리 상태 확인 필요';
}

export function omissionLabel(omission) {
  return OMISSIONS[omission] || '수집 범위 추가 확인 필요';
}

export function operationLabel(operation) {
  return OPERATIONS[operation] || '운영 작업';
}

export function blockTypeLabel(blockType) {
  return BLOCK_TYPES[blockType] || '콘텐츠 블록';
}

export function connectorLabel(connector) {
  return CONNECTORS[connector] || '연결';
}

export function bodyKindLabel(bodyKind) {
  return BODY_KINDS[bodyKind] || '수집된 텍스트';
}

export function assuranceLabel(assurance) {
  return ASSURANCE[assurance] || '평가 보증 기록 없음';
}

export function iconSvg(icon) {
  return `<svg class="status-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ICONS.minus}</svg>`;
}
