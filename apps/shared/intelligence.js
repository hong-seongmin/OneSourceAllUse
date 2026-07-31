import { audit } from './audit.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { cleanText, id, parseJson } from './ids.js';
import { issue } from './errors.js';
import { assertCredentialedHttps, boundedText, safeFetch } from './security.js';

async function nextVersion(tx, table, workspaceId) {
  return (await tx.query(`SELECT COALESCE(max(version_no), 0) + 1 AS version FROM ${table} WHERE workspace_id = $1`, [workspaceId]))[0].version;
}

export async function saveCreatorIdentity(db, { workspaceId, userId, facts }) {
  if (!Array.isArray(facts) || !facts.length) throw issue('IDENTITY_EVIDENCE_REQUIRED', 'Creator Identity에는 적어도 하나의 근거 있는 사실이 필요합니다.');
  const normalized = facts.map((fact) => ({
    claim: cleanText(fact.claim, 500), evidenceUrl: cleanText(fact.evidenceUrl, 2_000), evidenceNote: cleanText(fact.evidenceNote, 1_000)
  }));
  if (normalized.some((fact) => !fact.claim || !fact.evidenceUrl || !fact.evidenceNote)) throw issue('IDENTITY_EVIDENCE_REQUIRED', '모든 Creator Identity 사실에 주장, 근거 URL, 근거 설명을 입력하세요.');
  return db.transaction(async (tx) => {
    const versionId = id();
    const version = await nextVersion(tx, 'creator_identity_versions', workspaceId);
    await tx.query('INSERT INTO creator_identity_versions (id, workspace_id, version_no, created_by) VALUES ($1,$2,$3,$4)', [versionId, workspaceId, version, userId]);
    for (const fact of normalized) await tx.query('INSERT INTO creator_identity_facts (id, identity_version_id, claim, evidence_url, evidence_note, locked) VALUES ($1,$2,$3,$4,$5,true)', [id(), versionId, fact.claim, fact.evidenceUrl, fact.evidenceNote]);
    await audit(tx, { workspaceId, actorId: userId, action: 'creator_identity.versioned', entityType: 'creator_identity_version', entityId: versionId, detail: { factCount: normalized.length } });
    return versionId;
  });
}

export async function saveCreatorVoice(db, { workspaceId, userId, guidance }) {
  const value = cleanText(guidance, 5_000);
  if (!value) throw issue('VOICE_GUIDANCE_REQUIRED', 'Creator Voice 가이드를 입력하세요.');
  return db.transaction(async (tx) => {
    const versionId = id();
    await tx.query('INSERT INTO creator_voice_versions (id, workspace_id, version_no, guidance, created_by) VALUES ($1,$2,$3,$4,$5)', [versionId, workspaceId, await nextVersion(tx, 'creator_voice_versions', workspaceId), value, userId]);
    await audit(tx, { workspaceId, actorId: userId, action: 'creator_voice.versioned', entityType: 'creator_voice_version', entityId: versionId });
    return versionId;
  });
}

export async function saveAudiencePersona(db, { workspaceId, userId, name, needs, constraints, evidenceNote }) {
  const values = [name, needs, constraints, evidenceNote].map((value, index) => cleanText(value, index ? 5_000 : 200));
  if (values.some((value) => !value)) throw issue('AUDIENCE_EVIDENCE_REQUIRED', 'Audience Persona에는 이름, 필요, 제약, 근거 설명이 모두 필요합니다.');
  return db.transaction(async (tx) => {
    const versionId = id();
    await tx.query('INSERT INTO audience_persona_versions (id, workspace_id, version_no, name, needs, constraints_text, evidence_note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [versionId, workspaceId, await nextVersion(tx, 'audience_persona_versions', workspaceId), ...values, userId]);
    await audit(tx, { workspaceId, actorId: userId, action: 'audience_persona.versioned', entityType: 'audience_persona_version', entityId: versionId });
    return versionId;
  });
}

export function assertProviderAllowed(providerType, environment, testMode = false) {
  if (providerType === 'fixture' && (environment === 'production' || !testMode)) throw issue('FIXTURE_PROVIDER_IN_PRODUCTION', 'Fixture Provider는 테스트 환경에서만 사용할 수 있습니다.', 500);
  if (!['openai_compatible', 'solar', 'fixture'].includes(providerType)) throw issue('UNSUPPORTED_PROVIDER', '지원하지 않는 모델 Provider입니다.');
}

export function providerCapabilities(providerType, supplied = null) {
  const parsed = parseJson(supplied, {});
  const requested = parsed.structuredOutput;
  const structuredOutput = ['json_schema', 'json_object', 'text'].includes(requested)
    ? requested
    : providerType === 'solar' || providerType === 'fixture' ? 'json_object' : 'json_object';
  return { structuredOutput };
}

export async function saveModelProvider(db, {
  workspaceId,
  userId,
  name,
  providerType,
  baseUrl,
  model,
  apiKey,
  isDefault = false,
  capabilities = null,
  environment,
  secretKey,
  testMode = false,
  allowInsecureCredentialTransport = false
}) {
  assertProviderAllowed(providerType, environment, testMode);
  if (!name || !baseUrl || !model) throw issue('PROVIDER_INPUT_REQUIRED', 'Provider 이름, endpoint, model을 모두 입력하세요.');
  assertCredentialedHttps(baseUrl, { environment, testMode, allowInsecureCredentialTransport });
  const secretCiphertext = apiKey ? encryptSecret(apiKey, secretKey) : null;
  const normalizedCapabilities = providerCapabilities(providerType, capabilities);
  return db.transaction(async (tx) => {
    const existing = (await tx.query('SELECT id, secret_ciphertext FROM model_provider_configs WHERE workspace_id = $1 AND name = $2', [workspaceId, name]))[0];
    const providerId = existing?.id || id();
    if (isDefault) await tx.query('UPDATE model_provider_configs SET is_default=false, updated_at=now() WHERE workspace_id=$1 AND is_default=true', [workspaceId]);
    await tx.query(`INSERT INTO model_provider_configs (id, workspace_id, name, provider_type, base_url, model, secret_ciphertext, is_default, capabilities, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      ON CONFLICT (workspace_id, name) DO UPDATE SET provider_type = EXCLUDED.provider_type, base_url = EXCLUDED.base_url, model = EXCLUDED.model,
      secret_ciphertext = COALESCE(EXCLUDED.secret_ciphertext, model_provider_configs.secret_ciphertext),
      is_default = CASE WHEN EXCLUDED.is_default THEN true ELSE model_provider_configs.is_default END,
      capabilities = EXCLUDED.capabilities, last_test_status='untested', last_tested_at=NULL,
      last_test_model=NULL, last_test_error=NULL, updated_at = now()`, [providerId, workspaceId, name, providerType, baseUrl.replace(/\/$/, ''), model, secretCiphertext, isDefault, JSON.stringify(normalizedCapabilities), userId]);
    await audit(tx, { workspaceId, actorId: userId, action: 'model_provider.saved', entityType: 'model_provider', entityId: providerId, detail: { providerType, model, isDefault, capabilities: normalizedCapabilities } });
    return providerId;
  });
}

export async function bootstrapUpstageSolarProvider(db, { apiKey, environment, secretKey, model = 'solar-open2' }) {
  const normalizedKey = String(apiKey || '').trim().replace(/^['"]|['"]$/g, '');
  if (!normalizedKey || environment === 'test') return null;
  if (!secretKey) throw issue('PROVIDER_BOOTSTRAP_SECRET_REQUIRED', 'Solar Open2 기본 Provider를 저장할 암호화 키가 없습니다.', 500);
  const owner = (await db.query("SELECT id, workspace_id FROM users WHERE role='administrator' ORDER BY created_at LIMIT 1"))[0];
  if (!owner) return null;
  const defaultProvider = (await db.query('SELECT id FROM model_provider_configs WHERE workspace_id=$1 AND is_default=true', [owner.workspace_id]))[0];
  const existingSolar = (await db.query(`SELECT id,is_default,base_url,model,secret_ciphertext
    FROM model_provider_configs WHERE workspace_id=$1 AND name=$2`, [
    owner.workspace_id,
    'Upstage Solar Open2'
  ]))[0];
  if (existingSolar) {
    let keyUnchanged = false;
    try {
      keyUnchanged = decryptSecret(existingSolar.secret_ciphertext, secretKey) === normalizedKey;
    } catch {
      // A rotated encryption key makes the old ciphertext unusable. Saving the
      // supplied live key below is the recoverable bootstrap path.
    }
    if (keyUnchanged
      && existingSolar.base_url === 'https://api.upstage.ai/v1'
      && existingSolar.model === model) {
      return { providerId: existingSolar.id, workspaceId: owner.workspace_id, model };
    }
  }
  const providerId = await saveModelProvider(db, {
    workspaceId: owner.workspace_id,
    userId: owner.id,
    name: 'Upstage Solar Open2',
    providerType: 'solar',
    baseUrl: 'https://api.upstage.ai/v1',
    model,
    apiKey: normalizedKey,
    isDefault: Boolean(existingSolar?.is_default || !defaultProvider),
    environment,
    secretKey
  });
  return { providerId, workspaceId: owner.workspace_id, model };
}

export async function loadProvider(db, workspaceId, providerId, config) {
  const row = (await db.query('SELECT * FROM model_provider_configs WHERE id = $1 AND workspace_id = $2 AND enabled = true', [providerId, workspaceId]))[0];
  if (!row) throw issue('PROVIDER_NOT_FOUND', '활성 모델 Provider를 찾을 수 없습니다.', 404);
  assertProviderAllowed(row.provider_type, config.environment, config.testMode);
  return {
    ...row,
    secret: decryptSecret(row.secret_ciphertext, config.secretKey),
    providerType: row.provider_type,
    baseUrl: row.base_url,
    capabilities: providerCapabilities(row.provider_type, row.capabilities)
  };
}

function messagesForStructuredOutput(messages, responseFormat) {
  const cloned = messages.map((message) => ({ role: message.role, content: String(message.content || '') }));
  if (responseFormat === 'json_object' && !cloned.some((message) => /\bjson\b/i.test(message.content))) {
    cloned.unshift({ role: 'system', content: 'Return one valid JSON object only.' });
  }
  return cloned;
}

export async function requestCompletion(provider, { messages, responseFormat = 'json_object', jsonSchema = null, temperature = 0.2, maxTokens = null, phase = 'generation' }, config = {}) {
  const supported = providerCapabilities(provider.providerType, provider.capabilities).structuredOutput;
  if (!['json_schema', 'json_object', 'text'].includes(responseFormat)) throw issue('PROVIDER_CAPABILITY_INVALID', '지원하지 않는 structured output 요청입니다.', 500);
  if (responseFormat === 'json_schema' && supported !== 'json_schema') throw issue('PROVIDER_CAPABILITY_UNSUPPORTED', '이 Provider는 JSON Schema constrained output을 지원하지 않습니다.', 409, { requested: responseFormat, supported });
  if (responseFormat === 'json_object' && supported === 'text') throw issue('PROVIDER_CAPABILITY_UNSUPPORTED', '이 Provider는 JSON object output을 지원하지 않습니다.', 409, { requested: responseFormat, supported });
  if (!Array.isArray(messages) || !messages.length) throw issue('MODEL_MESSAGES_REQUIRED', '모델 요청 메시지가 없습니다.', 500);
  if (provider.providerType === 'fixture') {
    assertProviderAllowed('fixture', config.environment, config.testMode);
    return {
      content: responseFormat === 'text' ? String(config.fixtureResponse || '') : JSON.stringify(config.fixtureResponse || {}),
      usage: {},
      model: provider.model,
      finishReason: 'stop',
      capability: supported,
      phase
    };
  }
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (provider.secret) headers.authorization = `Bearer ${provider.secret}`;
  const payload = {
    model: provider.model,
    messages: messagesForStructuredOutput(messages, responseFormat),
    temperature: Math.min(1, Math.max(0, Number(temperature) || 0)),
    max_tokens: Math.min(8_192, Math.max(512, Number(maxTokens) || Number(config.modelMaxTokens) || 4_096))
  };
  if (responseFormat === 'json_object') payload.response_format = { type: 'json_object' };
  if (responseFormat === 'json_schema') {
    if (!jsonSchema?.name || !jsonSchema?.schema) throw issue('MODEL_JSON_SCHEMA_REQUIRED', 'JSON Schema output에는 이름과 schema가 필요합니다.', 500);
    payload.response_format = { type: 'json_schema', json_schema: { name: jsonSchema.name, strict: jsonSchema.strict !== false, schema: jsonSchema.schema } };
  }
  if (provider.providerType === 'solar') payload.reasoning_effort = config.modelReasoningEffort || 'none';
  const endpoint = `${provider.baseUrl}/chat/completions`;
  assertCredentialedHttps(endpoint, {
    environment: config.environment,
    testMode: config.testMode,
    allowInsecureCredentialTransport: config.network?.allowInsecureCredentialTransport
  });
  const response = await safeFetch(endpoint, {
    method: 'POST', headers,
    body: JSON.stringify(payload)
  }, {
    ...(config.network || {}),
    maxBytes: 1_000_000,
    timeoutMs: Math.min(300_000, Math.max(15_000, Number(config.modelTimeoutMs) || 120_000))
  });
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw issue('MODEL_REQUEST_FAILED', `모델 endpoint가 HTTP ${response.status}로 응답했습니다.`, 502, { retryable, upstreamStatus: response.status, phase });
  }
  const text = await boundedText(response, 1_000_000, Math.min(300_000, Math.max(15_000, Number(config.modelTimeoutMs) || 120_000)));
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw issue('MODEL_RESPONSE_INVALID', '모델 endpoint가 JSON 응답을 반환하지 않았습니다.', 502); }
  const choice = parsed?.choices?.[0];
  if (choice?.finish_reason === 'length') throw issue(
    'MODEL_RESPONSE_INCOMPLETE',
    '모델 응답이 길이 제한으로 끝났습니다. 이전 결과물은 유지되며 다시 시도할 수 있습니다.',
    502,
    { phase, finishReason: 'length' }
  );
  const content = choice?.message?.content;
  if (!content) throw issue('MODEL_RESPONSE_INVALID', '모델 응답에 생성 내용이 없습니다.', 502);
  return {
    content,
    usage: parseJson(parsed.usage, {}),
    model: parsed.model || provider.model,
    finishReason: choice.finish_reason || null,
    capability: supported,
    phase
  };
}

export async function testProvider(db, workspaceId, providerId, config) {
  try {
    const provider = await loadProvider(db, workspaceId, providerId, config);
    const result = await requestCompletion(provider, {
      messages: [
        { role: 'system', content: 'This is a provider protocol canary. Return one valid JSON object only.' },
        { role: 'user', content: 'Return exactly this JSON object: {"ok":true}' }
      ],
      responseFormat: 'json_object',
      temperature: 0,
      maxTokens: 512,
      phase: 'provider_canary'
    }, config);
    let parsed;
    try {
      const fenced = String(result.content).match(/```(?:json)?\s*([\s\S]*?)```/i);
      parsed = JSON.parse(fenced ? fenced[1] : result.content);
    } catch {
      throw issue('PROVIDER_CANARY_INVALID', 'Provider가 JSON object 연결 검사 계약을 지키지 않았습니다.', 502);
    }
    if (!parsed || parsed.ok !== true || Object.keys(parsed).some((key) => key !== 'ok')) {
      throw issue('PROVIDER_CANARY_INVALID', 'Provider가 요청한 {"ok":true} 연결 검사 결과를 반환하지 않았습니다.', 502);
    }
    await db.query(`UPDATE model_provider_configs
      SET last_test_status='succeeded',last_tested_at=now(),last_test_model=$3,last_test_error=NULL,updated_at=now()
      WHERE id=$1 AND workspace_id=$2`, [providerId, workspaceId, result.model || provider.model]);
    return {
      ok: true,
      provider: provider.name,
      configuredModel: provider.model,
      responseModel: result.model || provider.model,
      capability: result.capability
    };
  } catch (error) {
    await db.query(`UPDATE model_provider_configs
      SET last_test_status='failed',last_tested_at=now(),last_test_error=$3,updated_at=now()
      WHERE id=$1 AND workspace_id=$2`, [
      providerId,
      workspaceId,
      cleanText(`${error.code || 'PROVIDER_CANARY_FAILED'}: ${error.message}`, 1_000)
    ]);
    throw error;
  }
}
