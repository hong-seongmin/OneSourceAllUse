import { issue } from './errors.js';

export const PLATFORM_PROFILE_ADAPTER_KEYS = Object.freeze([
  'article',
  'email',
  'card_sequence',
  'timed_vertical_video'
]);

const LEGACY_PROFILE_IDS = Object.freeze([
  'naver_blog:v1',
  'wordpress_article:v1',
  'newsletter:v1',
  'instagram_carousel:v1',
  'short_video:v1'
]);

export function isLegacyPlatformProfileId(profileId) {
  return LEGACY_PROFILE_IDS.includes(profileId);
}

export const SELECTABLE_PLATFORM_PROFILE_IDS = Object.freeze([
  'naver_blog:v2',
  'wordpress_article:v2',
  'newsletter:v2',
  'instagram_carousel:v2',
  'youtube_shorts:v1',
  'instagram_reels:v1',
  'tiktok_video:v1'
]);

const PROFILE_ADAPTER_BY_ID = Object.freeze({
  'naver_blog:v1': 'legacy',
  'wordpress_article:v1': 'legacy',
  'newsletter:v1': 'legacy',
  'instagram_carousel:v1': 'legacy',
  'short_video:v1': 'legacy',
  'naver_blog:v2': 'article',
  'wordpress_article:v2': 'article',
  'newsletter:v2': 'email',
  'instagram_carousel:v2': 'card_sequence',
  'youtube_shorts:v1': 'timed_vertical_video',
  'instagram_reels:v1': 'timed_vertical_video',
  'tiktok_video:v1': 'timed_vertical_video'
});

const SAFE_ADAPTER_KEYS = new Set(['legacy', ...PLATFORM_PROFILE_ADAPTER_KEYS]);
const CHECK_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROFILE_ID = /^([a-z][a-z0-9_]{1,63}):v([1-9]\d{0,5})$/u;
const PROFILE_PROPERTY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(message, meta = {}) {
  return issue('INVALID_PLATFORM_PROFILE', message, 500, meta);
}

function cloneJson(value, path = 'profile_config') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (typeof value !== 'object') throw invalid('Platform Profile에는 JSON 값만 사용할 수 있습니다.', { path });
  const copy = {};
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) throw invalid('Platform Profile에 안전하지 않은 객체 키가 있습니다.', { path: `${path}.${key}` });
    copy[key] = cloneJson(nested, `${path}.${key}`);
  }
  return copy;
}

function parseProfileConfig(value) {
  if (typeof value !== 'string') return cloneJson(value);
  try {
    return cloneJson(JSON.parse(value));
  } catch {
    throw invalid('Platform Profile JSON을 해석할 수 없습니다.');
  }
}

function requireObject(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw invalid(`${path}는 JSON 객체여야 합니다.`, { path });
  return value;
}

function requireString(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${path}는 비어 있지 않은 문자열이어야 합니다.`, { path });
  return value;
}

function validateDeclarativeSchema(schema, path) {
  requireObject(schema, path);
  if (schema.type !== 'object') throw invalid(`${path}.type은 object여야 합니다.`, { path: `${path}.type` });
  requireObject(schema.properties, `${path}.properties`);
  const unsafeProperty = Object.keys(schema.properties).find((key) => !PROFILE_PROPERTY.test(key));
  if (unsafeProperty) throw invalid(`${path}.properties에 안전하지 않은 속성 이름이 있습니다.`, { path: `${path}.properties.${unsafeProperty}` });
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    requireObject(propertySchema, `${path}.properties.${key}`);
    for (const annotation of ['title', 'description']) {
      if (propertySchema[annotation] == null) continue;
      const value = requireString(propertySchema[annotation], `${path}.properties.${key}.${annotation}`);
      const maximum = annotation === 'title' ? 120 : 500;
      if ([...value].length > maximum) {
        throw invalid(`${path}.properties.${key}.${annotation} 값이 너무 깁니다.`, {
          path: `${path}.properties.${key}.${annotation}`,
          maximum
        });
      }
    }
    if (propertySchema.enum != null) {
      if (!Array.isArray(propertySchema.enum) || !propertySchema.enum.length) {
        throw invalid(`${path}.properties.${key}.enum은 하나 이상의 값을 가져야 합니다.`, { path: `${path}.properties.${key}.enum` });
      }
      const expectedType = propertySchema.type;
      if (propertySchema.enum.some((value) =>
        (expectedType === 'integer' ? !Number.isInteger(value) : typeof value !== expectedType))) {
        throw invalid(`${path}.properties.${key}.enum 값이 선언된 유형과 일치하지 않습니다.`, { path: `${path}.properties.${key}.enum` });
      }
    }
  }
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) {
    throw invalid(`${path}.required는 문자열 배열이어야 합니다.`, { path: `${path}.required` });
  }
  if (schema.additionalProperties != null && typeof schema.additionalProperties !== 'boolean') {
    throw invalid(`${path}.additionalProperties는 boolean이어야 합니다.`, { path: `${path}.additionalProperties` });
  }
}

function validateOfficialSources(sources) {
  if (!Array.isArray(sources) || !sources.length) throw invalid('official_sources에는 확인한 공식 출처가 하나 이상 필요합니다.', { path: 'profile_config.official_sources' });
  for (const [index, source] of sources.entries()) {
    requireObject(source, `profile_config.official_sources[${index}]`);
    const url = requireString(source.url, `profile_config.official_sources[${index}].url`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid('공식 출처 URL 형식이 올바르지 않습니다.', { path: `profile_config.official_sources[${index}].url` });
    }
    if (parsed.protocol !== 'https:') throw invalid('공식 출처는 HTTPS URL이어야 합니다.', { path: `profile_config.official_sources[${index}].url` });
    if (!CHECK_DATE.test(source.checked_on)) throw invalid('공식 출처 확인일은 YYYY-MM-DD 형식이어야 합니다.', { path: `profile_config.official_sources[${index}].checked_on` });
  }
}

function requireAdapterShape(config, adapterKey, profileId) {
  if (adapterKey === 'legacy') return;
  const properties = config.output_schema.properties;
  const requiredProperties = {
    article: ['title', 'intro', 'sections'],
    email: ['subject', 'opening', 'modules'],
    card_sequence: ['cover', 'slides', 'caption', 'hashtags'],
    timed_vertical_video: ['title', 'hook', 'scenes', 'ending', 'coverText']
  }[adapterKey];
  const missing = requiredProperties.filter((key) => !Object.hasOwn(properties, key));
  if (missing.length) {
    throw invalid('Platform Profile output_schema가 선택한 실행 adapter의 구조를 충족하지 않습니다.', {
      profileId,
      adapterKey,
      missingProperties: missing
    });
  }
}

function validateProfileConfig(config, profileId, { adapterKey, selectable }) {
  requireObject(config, 'profile_config');
  if (config.format_version !== 1) throw invalid('지원하지 않는 Platform Profile 형식 버전입니다.', { profileId, formatVersion: config.format_version });
  if (config.profile_id !== profileId) throw invalid('Profile JSON의 profile_id가 정의 버전과 일치하지 않습니다.', { profileId, configuredProfileId: config.profile_id });
  if (selectable && config.candidate_contract_version !== 'visible-text.v1') {
    throw invalid('현재 Platform Profile은 persisted visible-text 계약을 선언해야 합니다.', {
      profileId,
      candidateContractVersion: config.candidate_contract_version
    });
  }
  validateDeclarativeSchema(config.settings_schema, 'profile_config.settings_schema');
  validateDeclarativeSchema(config.output_schema, 'profile_config.output_schema');
  requireAdapterShape(config, adapterKey, profileId);

  const promptPolicy = requireObject(config.prompt_policy, 'profile_config.prompt_policy');
  requireString(promptPolicy.task, 'profile_config.prompt_policy.task');
  if (!Array.isArray(promptPolicy.instructions) || !promptPolicy.instructions.length || promptPolicy.instructions.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw invalid('prompt_policy.instructions에는 선언적 지침 문자열이 필요합니다.', { path: 'profile_config.prompt_policy.instructions' });
  }

  if (!Array.isArray(config.rubric) || !config.rubric.length) throw invalid('rubric에는 하나 이상의 평가 기준이 필요합니다.', { path: 'profile_config.rubric' });
  for (const [index, entry] of config.rubric.entries()) {
    requireObject(entry, `profile_config.rubric[${index}]`);
    requireString(entry.key, `profile_config.rubric[${index}].key`);
    requireString(entry.label, `profile_config.rubric[${index}].label`);
    requireString(entry.criterion, `profile_config.rubric[${index}].criterion`);
  }

  if (!Array.isArray(config.preview_modes) || !config.preview_modes.length || config.preview_modes.some((mode) => typeof mode !== 'string' || !mode.trim())) {
    throw invalid('preview_modes에는 하나 이상의 미리보기 모드가 필요합니다.', { path: 'profile_config.preview_modes' });
  }
  const renderMetadata = requireObject(config.render_metadata, 'profile_config.render_metadata');
  if (!config.preview_modes.includes(renderMetadata.primary_mode)) {
    throw invalid('render_metadata.primary_mode는 preview_modes 중 하나여야 합니다.', { path: 'profile_config.render_metadata.primary_mode' });
  }

  const repairPolicy = requireObject(config.repair_policy, 'profile_config.repair_policy');
  if (repairPolicy.mode !== 'bounded_retry') throw invalid('repair_policy.mode은 bounded_retry여야 합니다.', { path: 'profile_config.repair_policy.mode' });
  if (!Number.isInteger(repairPolicy.max_attempts) || repairPolicy.max_attempts < 0 || repairPolicy.max_attempts > 3) {
    throw invalid('repair_policy.max_attempts는 0~3 범위의 정수여야 합니다.', { path: 'profile_config.repair_policy.max_attempts' });
  }
  if (!Array.isArray(repairPolicy.retryable_issues) || repairPolicy.retryable_issues.some((entry) => typeof entry !== 'string')) {
    throw invalid('repair_policy.retryable_issues는 문자열 배열이어야 합니다.', { path: 'profile_config.repair_policy.retryable_issues' });
  }
  validateOfficialSources(config.official_sources);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function validatePlatformProfile(row) {
  const id = requireString(row?.id, 'id');
  const identity = id.match(PROFILE_ID);
  if (!identity) throw invalid('Platform Profile id는 channel:vN 형식의 안전한 식별자여야 합니다.', { profileId: id });
  const adapterKey = requireString(row.adapter_key ?? row.adapterKey, 'adapter_key');
  if (!SAFE_ADAPTER_KEYS.has(adapterKey)) throw issue('UNKNOWN_PROFILE_ADAPTER', '등록되지 않은 Platform Profile adapter입니다.', 500, { profileId: id, adapterKey });
  if (PROFILE_ADAPTER_BY_ID[id] && PROFILE_ADAPTER_BY_ID[id] !== adapterKey) {
    throw issue('UNKNOWN_PROFILE_ADAPTER', 'Platform Profile과 adapter 연결이 등록값과 다릅니다.', 500, { profileId: id, adapterKey });
  }

  const channel = requireString(row.channel, 'channel');
  const versionNo = Number(row.version_no ?? row.versionNo);
  if (channel !== identity[1] || !Number.isInteger(versionNo) || versionNo !== Number(identity[2])) {
    throw invalid('Platform Profile의 channel/version identity가 id와 일치하지 않습니다.', { profileId: id, channel, versionNo });
  }
  const selectable = Boolean(row.selectable);
  if (adapterKey === 'legacy' && selectable) throw invalid('Legacy Profile은 선택할 수 없습니다.', { profileId: id });
  if (LEGACY_PROFILE_IDS.includes(id) && adapterKey !== 'legacy') {
    throw issue('UNKNOWN_PROFILE_ADAPTER', '기존 Profile의 실행 adapter 경계가 변경되었습니다.', 500, { profileId: id, adapterKey });
  }
  const profileConfig = parseProfileConfig(row.profile_config ?? row.profileConfig);
  validateProfileConfig(profileConfig, id, { adapterKey, selectable });

  return deepFreeze({
    id,
    channel,
    versionNo,
    displayName: requireString(row.display_name ?? row.displayName, 'display_name'),
    description: requireString(row.description, 'description'),
    schemaKey: requireString(row.schema_key ?? row.schemaKey, 'schema_key'),
    adapterKey,
    selectable,
    defaultActive: Boolean(row.default_active ?? row.defaultActive),
    profileConfig
  });
}

function validateScalar(value, schema, path) {
  const assertEnum = (normalized) => {
    if (Array.isArray(schema.enum) && !schema.enum.includes(normalized)) {
      throw issue('PROFILE_SETTINGS_INVALID', `${path}는 Profile에 선언된 선택지 중 하나여야 합니다.`, 422, { path });
    }
    return normalized;
  };
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw issue('PROFILE_SETTINGS_INVALID', `${path}는 문자열이어야 합니다.`, 422, { path });
    const normalized = value.trim();
    if (schema.minLength != null && normalized.length < schema.minLength) throw issue('PROFILE_SETTINGS_INVALID', `${path} 값이 너무 짧습니다.`, 422, { path });
    if (schema.maxLength != null && normalized.length > schema.maxLength) throw issue('PROFILE_SETTINGS_INVALID', `${path} 값이 너무 깁니다.`, 422, { path });
    return assertEnum(normalized);
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw issue('PROFILE_SETTINGS_INVALID', `${path}는 boolean이어야 합니다.`, 422, { path });
    return assertEnum(value);
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw issue('PROFILE_SETTINGS_INVALID', `${path}는 정수여야 합니다.`, 422, { path });
    if (schema.minimum != null && value < schema.minimum) throw issue('PROFILE_SETTINGS_INVALID', `${path} 값이 허용 범위보다 작습니다.`, 422, { path });
    if (schema.maximum != null && value > schema.maximum) throw issue('PROFILE_SETTINGS_INVALID', `${path} 값이 허용 범위보다 큽니다.`, 422, { path });
    return assertEnum(value);
  }
  throw invalid('지원하지 않는 settings_schema 속성 유형입니다.', { path, type: schema.type });
}

export function normalizeProfileSettings(profileOrRow, settings = {}) {
  const profile = profileOrRow?.profileConfig ? profileOrRow : validatePlatformProfile(profileOrRow);
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
    throw issue('PROFILE_SETTINGS_INVALID', '채널 설정은 JSON 객체여야 합니다.', 422);
  }
  const schema = profile.profileConfig.settings_schema;
  const properties = schema.properties;
  const unknown = Object.keys(settings).filter((key) => !Object.hasOwn(properties, key));
  if (schema.additionalProperties === false && unknown.length) {
    throw issue('PROFILE_SETTINGS_INVALID', '지원하지 않는 채널 설정이 있습니다.', 422, { keys: unknown });
  }
  const normalized = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (settings[key] !== undefined) normalized[key] = validateScalar(settings[key], propertySchema, key);
    else if (propertySchema.default !== undefined) normalized[key] = validateScalar(
      cloneJson(propertySchema.default, `settings_schema.properties.${key}.default`),
      propertySchema,
      key
    );
  }
  for (const key of schema.required || []) {
    if (normalized[key] === undefined) throw issue('PROFILE_SETTINGS_INVALID', `${key} 설정이 필요합니다.`, 422, { path: key });
  }
  return deepFreeze(normalized);
}

export function platformProfileContracts(profileOrRow) {
  const profile = profileOrRow?.profileConfig ? profileOrRow : validatePlatformProfile(profileOrRow);
  return deepFreeze({
    profileId: profile.id,
    adapterKey: profile.adapterKey,
    candidateContractVersion: profile.profileConfig.candidate_contract_version || 'legacy',
    metadata: {
      channel: profile.channel,
      versionNo: profile.versionNo,
      displayName: profile.displayName,
      description: profile.description,
      schemaKey: profile.schemaKey,
      selectable: profile.selectable,
      defaultActive: profile.defaultActive,
      officialSources: profile.profileConfig.official_sources
    },
    settingsSchema: profile.profileConfig.settings_schema,
    outputSchema: profile.profileConfig.output_schema,
    promptPolicy: profile.profileConfig.prompt_policy,
    rubric: profile.profileConfig.rubric,
    previewModes: profile.profileConfig.preview_modes,
    renderMetadata: profile.profileConfig.render_metadata,
    repairPolicy: profile.profileConfig.repair_policy
  });
}

export async function loadPlatformProfile(db, profileId) {
  if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) {
    throw issue('UNKNOWN_PLATFORM_PROFILE', '등록되지 않은 Platform Profile입니다.', 500, { profileId });
  }
  const row = (await db.query(`SELECT id, channel, version_no, display_name, description, schema_key,
      adapter_key, profile_config, selectable, default_active
    FROM channel_definition_versions WHERE id=$1`, [profileId]))[0];
  if (!row) throw issue('UNKNOWN_PLATFORM_PROFILE', 'Platform Profile을 찾을 수 없습니다.', 500, { profileId });
  return validatePlatformProfile(row);
}
