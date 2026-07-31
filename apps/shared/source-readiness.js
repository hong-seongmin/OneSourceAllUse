const RIGHTS_STATUSES = new Set(['owned', 'licensed', 'unknown', 'restricted']);

const INJECTION_PATTERNS = [
  {
    code: 'INSTRUCTION_OVERRIDE',
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,80}\b(?:previous|prior|system|developer|all)\b[\s\S]{0,40}\b(?:instruction|prompt|message|rule)s?\b|(?:이전|기존|시스템|개발자)[\s\S]{0,40}(?:지시|명령|프롬프트)[\s\S]{0,20}(?:무시|잊|우회)/iu
  },
  {
    code: 'CREDENTIAL_EXFILTRATION',
    pattern: /\b(?:reveal|show|print|return|send|expose|leak|extract)\b[\s\S]{0,80}\b(?:api[-_ ]?key|secret|access[-_ ]?token|password|credential)s?\b|(?:api\s*키|비밀|토큰|비밀번호|자격\s*증명)[\s\S]{0,40}(?:공개|출력|보여|전송|반환)/iu
  },
  {
    code: 'TOOL_EXECUTION_REQUEST',
    pattern: /\b(?:call|invoke|use|execute|run|launch)\b[\s\S]{0,60}\b(?:tool|function|shell|terminal|command|curl|powershell|bash)\b|(?:도구|함수|셸|터미널|명령)[\s\S]{0,40}(?:호출|실행|사용)/iu
  },
  {
    code: 'PROMPT_BOUNDARY_IMPERSONATION',
    pattern: /(?:^|\n)\s*(?:system|developer|assistant)\s*:\s*|<\s*\/?\s*(?:system|developer|assistant|tool)(?:\s|>)/iu
  }
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeRightsStatus(value) {
  const normalized = String(value || 'unknown').toLowerCase();
  return RIGHTS_STATUSES.has(normalized) ? normalized : 'unknown';
}

export function detectPromptInjectionRisk(value) {
  const text = String(value ?? '');
  const signals = INJECTION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ code }) => code);
  return {
    detected: signals.length > 0,
    quarantine: signals.length > 0,
    signals
  };
}

function usableAtoms(atoms) {
  return (Array.isArray(atoms) ? atoms : []).filter((atom) => {
    if (!atom?.id || !String(atom.text ?? '').trim()) return false;
    if (atom.segmentType === 'title' || atom.atomType === 'context') return false;
    return true;
  });
}

export function assessSourceReadiness({
  body = '',
  atoms = [],
  ingestionMeta = {},
  rightsStatus = 'unknown'
} = {}) {
  const normalizedRights = normalizeRightsStatus(rightsStatus);
  const usable = usableAtoms(atoms);
  const injection = detectPromptInjectionRisk(body);
  const omissions = [...(Array.isArray(ingestionMeta.omissions) ? ingestionMeta.omissions : [])];
  const signals = [
    ...(Array.isArray(ingestionMeta.sanitizationSignals) ? ingestionMeta.sanitizationSignals : []),
    ...(Array.isArray(ingestionMeta.excerptSignals) ? ingestionMeta.excerptSignals : []),
    ...injection.signals
  ];

  let readiness = 'complete';
  let acknowledgementRequired = normalizedRights === 'unknown';

  if (normalizedRights === 'restricted') {
    readiness = 'incompatible';
    omissions.push('RIGHTS_RESTRICTED');
    acknowledgementRequired = false;
  } else if (injection.quarantine) {
    readiness = 'quarantined';
    omissions.push('INDIRECT_PROMPT_INJECTION_RISK');
    acknowledgementRequired = true;
  } else if (!usable.length) {
    readiness = 'insufficient';
    omissions.push('NO_USABLE_EVIDENCE');
    acknowledgementRequired = false;
  } else if (ingestionMeta.metadataOnly === true) {
    readiness = 'partial';
    omissions.push('YOUTUBE_TRANSCRIPT_MISSING');
    acknowledgementRequired = true;
  } else if (
    ingestionMeta.truncated === true
    || ingestionMeta.appearsExcerpt === true
    || (Array.isArray(ingestionMeta.excerptSignals) && ingestionMeta.excerptSignals.length > 0)
  ) {
    readiness = 'partial';
    omissions.push(ingestionMeta.truncated ? 'BODY_TRUNCATED_AT_STORAGE_LIMIT' : 'SOURCE_DESCRIPTION_APPEARS_PARTIAL');
    acknowledgementRequired = true;
  }

  if (normalizedRights === 'unknown') signals.push('RIGHTS_STATUS_UNKNOWN');

  return {
    readiness,
    rightsStatus: normalizedRights,
    usableAtomIds: usable.map((atom) => atom.id),
    omissions: unique(omissions),
    signals: unique(signals),
    acknowledgementRequired
  };
}

export const assessReadiness = assessSourceReadiness;
