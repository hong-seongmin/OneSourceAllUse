import { audit, enqueue, recordDomainEvent } from './audit.js';
import { activeChannelCatalog } from './channels.js';
import { normalizeProfileSettings } from './channel-registry.js';
import { cleanText, id, parseJson } from './ids.js';
import { issue } from './errors.js';

const CHANNEL_KEY = /^[a-z][a-z0-9_]{1,63}$/u;

function requiredPurpose(settings, code) {
  const purpose = cleanText(settings.purpose, 300);
  if (!purpose) throw issue(code, '채널의 목적을 입력하세요.');
  return purpose;
}

export function normalizeOutput(output) {
  if (!CHANNEL_KEY.test(String(output?.type || ''))) throw issue('UNSUPPORTED_OUTPUT', '지원하지 않는 채널 식별자입니다.');
  const settings = output?.settings;
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
    throw issue('PROFILE_SETTINGS_INVALID', '채널 설정은 JSON 객체여야 합니다.');
  }
  return {
    type: output.type,
    settings: {
      ...settings,
      purpose: requiredPurpose(settings, 'CHANNEL_PURPOSE_REQUIRED')
    }
  };
}

function sourceReadinessIssue(assessment) {
  if (assessment.readiness === 'quarantined') return issue('SOURCE_PROMPT_INJECTION', '원본에 명시적 간접 프롬프트 공격 신호가 있어 격리되었습니다.', 409, { signals: assessment.signals, omissions: assessment.omissions });
  if (assessment.readiness === 'incompatible') return issue('SOURCE_RIGHTS_INCOMPATIBLE', '권리 상태가 이 원본의 파생 콘텐츠 생성을 허용하지 않습니다.', 409, { rightsStatus: assessment.rights_status, omissions: assessment.omissions });
  if (assessment.readiness === 'insufficient') return issue('SOURCE_CONTENT_INSUFFICIENT', '사용할 수 있는 완전한 원본 근거가 없습니다.', 409, { omissions: assessment.omissions });
  return null;
}

async function assertContextVersion(tx, table, versionId, workspaceId, label) {
  if (!versionId) return;
  const row = (await tx.query(`SELECT id FROM ${table} WHERE id=$1 AND workspace_id=$2`, [versionId, workspaceId]))[0];
  if (!row) throw issue('CONTEXT_VERSION_NOT_FOUND', `${label} 버전을 찾을 수 없습니다.`, 404);
}

export function normalizeSourceSelections({ sourceItemId = null, sourceSelections = null } = {}) {
  if (sourceSelections == null) {
    if (!sourceItemId) throw issue('SOURCE_SELECTION_REQUIRED', '계획에 사용할 원본을 하나 이상 선택하세요.', 422);
    return [{
      sourceItemId,
      expectedSnapshotId: null,
      suggestionSourceId: null,
      isPrimary: true,
      sourceKey: 'source_1',
      ordinal: 1
    }];
  }
  if (!Array.isArray(sourceSelections) || !sourceSelections.length) {
    throw issue('SOURCE_SELECTION_REQUIRED', '계획에 사용할 원본을 하나 이상 선택하세요.', 422);
  }
  const normalized = sourceSelections.map((selection, index) => {
    if (!selection || Array.isArray(selection) || typeof selection !== 'object') {
      throw issue('SOURCE_SELECTION_INVALID', '원본 선택 계약이 올바르지 않습니다.', 422, { index });
    }
    const selectedSourceItemId = cleanText(selection.sourceItemId, 300);
    const expectedSnapshotId = cleanText(selection.expectedSnapshotId, 300);
    if (!selectedSourceItemId || !expectedSnapshotId) {
      throw issue('SOURCE_SELECTION_INVALID', '원본과 화면에서 확인한 스냅샷을 함께 선택하세요.', 422, { index });
    }
    return {
      sourceItemId: selectedSourceItemId,
      expectedSnapshotId,
      suggestionSourceId: cleanText(selection.suggestionSourceId, 300) || null,
      isPrimary: selection.isPrimary === true,
      inputOrdinal: index
    };
  });
  const primary = normalized.filter((selection) => selection.isPrimary);
  if (primary.length !== 1) {
    throw issue('SOURCE_PRIMARY_REQUIRED', '계획에는 정확히 하나의 주 원본이 필요합니다.', 422, {
      primaryCount: primary.length
    });
  }
  if (new Set(normalized.map((selection) => selection.sourceItemId)).size !== normalized.length) {
    throw issue('DUPLICATE_SOURCE_SELECTION', '같은 원본을 한 계획에 두 번 선택할 수 없습니다.', 422);
  }
  if (new Set(normalized.map((selection) => selection.expectedSnapshotId)).size !== normalized.length) {
    throw issue('DUPLICATE_SOURCE_SELECTION', '같은 원본 스냅샷을 한 계획에 두 번 선택할 수 없습니다.', 422);
  }
  return [primary[0], ...normalized.filter((selection) => !selection.isPrimary)]
    .map((selection, index) => ({
      sourceItemId: selection.sourceItemId,
      expectedSnapshotId: selection.expectedSnapshotId,
      suggestionSourceId: selection.suggestionSourceId,
      isPrimary: index === 0,
      sourceKey: `source_${index + 1}`,
      ordinal: index + 1
    }));
}

export async function createPlan(db, {
  workspaceId,
  userId,
  sourceItemId,
  sourceSelections = null,
  plannerSuggestionRunId = null,
  creatorIdentityVersionId = null,
  creatorVoiceVersionId = null,
  audiencePersonaVersionId = null,
  language = 'ko',
  commonCta = '',
  outputs,
  providerId,
  evaluatorProviderId = null,
  sourceReadinessAcknowledged = false,
  supplementalReadinessAcknowledged = false
}) {
  if (!Array.isArray(outputs) || !outputs.length) throw issue('OUTPUT_SELECTION_REQUIRED', '생성할 결과물을 하나 이상 선택하세요. 선택하지 않은 결과물은 생성되지 않습니다.');
  if (!providerId) throw issue('PROVIDER_REQUIRED', '생성 전에 활성 Model Provider를 선택하세요.', 409);
  if (new Set(outputs.map((output) => output?.platformProfileVersionId || output?.type)).size !== outputs.length) throw issue('DUPLICATE_OUTPUT', '각 채널 결과물은 한 번만 선택할 수 있습니다.');
  const requestedSources = normalizeSourceSelections({ sourceItemId, sourceSelections });
  return db.transaction(async (tx) => {
    const sourceItems = await tx.query(`SELECT i.id, i.latest_snapshot_id, assessment.readiness,
        assessment.rights_status,assessment.usable_atom_ids,assessment.omissions,
        assessment.signals,assessment.acknowledgement_required
      FROM source_items i
      JOIN sources s ON s.id=i.source_id
      LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=i.latest_snapshot_id
      WHERE i.id=ANY($1::text[]) AND s.workspace_id=$2 AND s.enabled=true
      ORDER BY i.id
      FOR SHARE OF i`, [requestedSources.map((selection) => selection.sourceItemId), workspaceId]);
    const sourceItemById = new Map(sourceItems.map((source) => [source.id, source]));
    const resolvedSources = requestedSources.map((selection) => {
      const source = sourceItemById.get(selection.sourceItemId);
      if (!source) throw issue('SOURCE_ITEM_NOT_FOUND', '계획에 선택한 원본을 찾을 수 없습니다.', 404, {
        sourceKey: selection.sourceKey
      });
      if (!source.latest_snapshot_id) throw issue('SOURCE_SNAPSHOT_REQUIRED', '먼저 선택한 원본의 동기화를 완료하세요.', 409, {
        sourceKey: selection.sourceKey
      });
      if (selection.expectedSnapshotId && source.latest_snapshot_id !== selection.expectedSnapshotId) {
        throw issue(
          'SOURCE_SNAPSHOT_CHANGED',
          '원본이 계획 화면을 연 뒤 변경되었습니다. 최신 원본 추천을 다시 확인하세요.',
          409,
          { sourceKey: selection.sourceKey, expectedSnapshotId: selection.expectedSnapshotId }
        );
      }
      if (!source.readiness) throw issue('SOURCE_ASSESSMENT_REQUIRED', '선택한 원본의 readiness 검사를 먼저 완료하세요.', 409, {
        sourceKey: selection.sourceKey
      });
      const readinessError = sourceReadinessIssue(source);
      if (readinessError) {
        readinessError.meta = { ...(readinessError.meta || {}), sourceKey: selection.sourceKey };
        throw readinessError;
      }
      return {
        ...selection,
        snapshotId: source.latest_snapshot_id,
        readiness: source.readiness,
        rightsStatus: source.rights_status,
        usableAtomIds: source.usable_atom_ids,
        omissions: source.omissions,
        signals: source.signals,
        acknowledgementRequired: source.readiness === 'partial'
          || Boolean(source.acknowledgement_required)
      };
    });
    const primaryAcknowledgementSource = resolvedSources.find((source) => source.isPrimary && source.acknowledgementRequired);
    if (primaryAcknowledgementSource && !sourceReadinessAcknowledged) {
      throw issue('SOURCE_ACKNOWLEDGEMENT_REQUIRED', primaryAcknowledgementSource.readiness === 'partial'
        ? '부분 원본의 누락 범위를 확인한 뒤 계속할 수 있습니다.'
        : '원본의 권리 또는 수집 경고를 확인한 뒤 계속할 수 있습니다.', 409, {
        sourceKey: primaryAcknowledgementSource.sourceKey,
        readiness: primaryAcknowledgementSource.readiness,
        rightsStatus: primaryAcknowledgementSource.rightsStatus,
        omissions: primaryAcknowledgementSource.omissions,
        signals: primaryAcknowledgementSource.signals
      });
    }
    const supplementalAcknowledgementSource = resolvedSources.find((source) => !source.isPrimary && source.acknowledgementRequired);
    if (supplementalAcknowledgementSource && !supplementalReadinessAcknowledged) {
      throw issue('SUPPLEMENTAL_SOURCE_ACKNOWLEDGEMENT_REQUIRED', '보조 원본의 누락 범위를 별도로 확인한 뒤 계속할 수 있습니다.', 409, {
        sourceKey: supplementalAcknowledgementSource.sourceKey,
        readiness: supplementalAcknowledgementSource.readiness,
        rightsStatus: supplementalAcknowledgementSource.rightsStatus,
        omissions: supplementalAcknowledgementSource.omissions,
        signals: supplementalAcknowledgementSource.signals
      });
    }
    const primarySource = resolvedSources[0];
    const combinedReadiness = resolvedSources.some((source) => source.readiness === 'partial') ? 'partial' : 'complete';
    const supplementalSources = resolvedSources.slice(1);
    if (primarySource.suggestionSourceId) {
      throw issue('SOURCE_SELECTION_INVALID', '주 원본에는 보조 원본 추천 식별자를 연결할 수 없습니다.', 422);
    }
    if (supplementalSources.some((source) => !source.suggestionSourceId)) {
      throw issue('SUPPLEMENTAL_SOURCE_SUGGESTION_REQUIRED', '보조 원본은 완료된 Planner 추천에서 선택해야 합니다.', 409);
    }
    const normalizedSuggestionRunId = cleanText(plannerSuggestionRunId, 300) || null;
    if (supplementalSources.length && !normalizedSuggestionRunId) {
      throw issue('PLANNER_SUGGESTION_RUN_REQUIRED', '보조 원본 선택을 검증할 완료된 Planner 추천이 필요합니다.', 409);
    }
    let suggestionRun = null;
    if (normalizedSuggestionRunId) {
      suggestionRun = (await tx.query(`SELECT suggestion.id,suggestion.workspace_id,
          suggestion.source_item_id,suggestion.source_snapshot_id,
          suggestion.creator_identity_version_id,suggestion.creator_voice_version_id,
          suggestion.audience_persona_version_id,run.status
        FROM planner_suggestion_runs suggestion
        JOIN runs run ON run.id=suggestion.run_id
        WHERE suggestion.id=$1
        FOR SHARE OF suggestion`, [normalizedSuggestionRunId]))[0];
      if (
        !suggestionRun
        || suggestionRun.workspace_id !== workspaceId
        || suggestionRun.status !== 'succeeded'
        || suggestionRun.source_item_id !== primarySource.sourceItemId
        || suggestionRun.source_snapshot_id !== primarySource.snapshotId
      ) {
        throw issue('PLANNER_SUGGESTION_RUN_MISMATCH', '완료된 현재 원본의 Planner 추천만 계획에 사용할 수 있습니다.', 409);
      }
      if (
        suggestionRun.creator_identity_version_id !== creatorIdentityVersionId
        || suggestionRun.creator_voice_version_id !== creatorVoiceVersionId
        || suggestionRun.audience_persona_version_id !== audiencePersonaVersionId
      ) {
        throw issue(
          'PLANNER_SUGGESTION_CONTEXT_CHANGED',
          '추천 이후 Creator 또는 Audience 컨텍스트가 변경되었습니다. 현재 컨텍스트로 추천을 다시 실행하세요.',
          409
        );
      }
    }
    const seedAtomsBySourceKey = new Map();
    const primaryUsableIds = [...new Set(parseJson(
      primarySource.usableAtomIds ?? primarySource.usable_atom_ids,
      []
    ))];
    const primaryUsableAtoms = primaryUsableIds.length
      ? await tx.query(`SELECT id,fingerprint
          FROM content_atoms
          WHERE id=ANY($1::text[]) AND snapshot_id=$2`, [
        primaryUsableIds,
        primarySource.snapshotId
      ])
      : [];
    if (!primaryUsableAtoms.length || primaryUsableAtoms.length !== primaryUsableIds.length) {
      throw issue(
        'SOURCE_CONTENT_INSUFFICIENT',
        '주 원본 readiness의 usable atom 범위가 현재 스냅샷과 일치하지 않습니다.',
        409,
        { sourceKey: primarySource.sourceKey }
      );
    }
    const primaryFingerprints = new Set(primaryUsableAtoms.map((atom) => atom.fingerprint));
    const seenSupplementalFingerprints = new Set();
    for (const source of supplementalSources) {
      const suggestionSource = (await tx.query(`SELECT id,suggestion_run_id,source_item_id,
          snapshot_id,disposition
        FROM planner_suggestion_sources
        WHERE id=$1
        FOR SHARE`, [source.suggestionSourceId]))[0];
      if (
        !suggestionSource
        || suggestionSource.suggestion_run_id !== normalizedSuggestionRunId
        || suggestionSource.source_item_id !== source.sourceItemId
        || suggestionSource.snapshot_id !== source.snapshotId
        || suggestionSource.disposition !== 'included'
      ) {
        throw issue('SUPPLEMENTAL_SOURCE_SUGGESTION_MISMATCH', '선택한 보조 원본이 현재 Planner 추천과 일치하지 않습니다.', 409, {
          sourceKey: source.sourceKey
        });
      }
      const refs = await tx.query(`SELECT ref.content_atom_id,atom.snapshot_id,
          atom.fingerprint,snapshot.source_item_id
        FROM planner_suggestion_source_refs ref
        JOIN content_atoms atom ON atom.id=ref.content_atom_id
        JOIN source_snapshots snapshot ON snapshot.id=atom.snapshot_id
        WHERE ref.suggestion_source_id=$1
        ORDER BY ref.content_atom_id`, [source.suggestionSourceId]);
      if (refs.some((ref) =>
        ref.snapshot_id !== source.snapshotId || ref.source_item_id !== source.sourceItemId)) {
        throw issue('SUPPLEMENTAL_SOURCE_REFERENCE_MISMATCH', '보조 원본 추천의 근거가 선택한 스냅샷 범위를 벗어났습니다.', 409, {
          sourceKey: source.sourceKey
        });
      }
      const supplementalUsableIds = new Set(parseJson(source.usableAtomIds, []));
      if (refs.some((ref) => !supplementalUsableIds.has(ref.content_atom_id))) {
        throw issue('SUPPLEMENTAL_SOURCE_REFERENCE_MISMATCH', '보조 원본 추천에 readiness allowlist 밖의 근거가 포함되어 있습니다.', 409, {
          sourceKey: source.sourceKey
        });
      }
      const seeds = refs.filter((ref) => {
        if (primaryFingerprints.has(ref.fingerprint) || seenSupplementalFingerprints.has(ref.fingerprint)) return false;
        seenSupplementalFingerprints.add(ref.fingerprint);
        return true;
      });
      if (!seeds.length) {
        throw issue('SUPPLEMENTAL_SOURCE_EVIDENCE_REQUIRED', '주 원본과 중복되지 않는 보조 원본 근거가 필요합니다.', 409, {
          sourceKey: source.sourceKey
        });
      }
      seedAtomsBySourceKey.set(source.sourceKey, seeds);
    }
    const generator = (await tx.query(`SELECT id FROM model_provider_configs
      WHERE id=$1 AND workspace_id=$2 AND enabled=true AND provider_type <> 'fixture' AND secret_ciphertext IS NOT NULL`, [providerId, workspaceId]))[0];
    if (!generator) throw issue('PROVIDER_NOT_READY', '선택한 Model Provider에 유효한 API Key가 없습니다. 설정에서 연결 검사를 완료하세요.', 409);
    const selectedEvaluatorProviderId = evaluatorProviderId || providerId;
    const evaluator = (await tx.query(`SELECT id FROM model_provider_configs
      WHERE id=$1 AND workspace_id=$2 AND enabled=true AND provider_type <> 'fixture' AND secret_ciphertext IS NOT NULL`, [selectedEvaluatorProviderId, workspaceId]))[0];
    if (!evaluator) throw issue('EVALUATOR_PROVIDER_NOT_READY', '선택한 평가 Provider가 준비되지 않았습니다.', 409);
    const activeCatalog = await activeChannelCatalog(tx, workspaceId);
    const definitionsByChannel = new Map(activeCatalog.map((definition) => [definition.channel, definition]));
    const definitionsById = new Map(activeCatalog.map((definition) => [definition.id, definition]));
    const normalized = outputs.map((output) => {
      const definition = output?.platformProfileVersionId
        ? definitionsById.get(output.platformProfileVersionId)
        : definitionsByChannel.get(output?.type);
      if (!definition || (output?.type && output.type !== definition.channel)) {
        throw issue('CHANNEL_NOT_ACTIVE', '선택한 플랫폼 프로필은 현재 작업공간에서 활성화되지 않았습니다.', 409);
      }
      const defaults = definition.default_settings && typeof definition.default_settings === 'object' ? definition.default_settings : {};
      return {
        type: definition.channel,
        definition,
        settings: normalizeProfileSettings(definition, { ...defaults, ...(output.settings || {}) }),
        plannerSuggestionProfileId: null,
        settingsOrigin: 'manual'
      };
    });
    if (new Set(normalized.map((output) => output.type)).size !== normalized.length) throw issue('DUPLICATE_OUTPUT', '각 채널 결과물은 한 번만 선택할 수 있습니다.');
    for (const output of normalized) {
      if (!normalizedSuggestionRunId) continue;
      const suggestedProfile = (await tx.query(`SELECT suggestion_profile.id,
          suggestion_profile.suggestion_run_id,suggestion_profile.platform_profile_version_id,
          suggestion_profile.settings
        FROM planner_suggestion_profiles suggestion_profile
        WHERE suggestion_profile.suggestion_run_id=$1
          AND suggestion_profile.platform_profile_version_id=$2`, [
        normalizedSuggestionRunId,
        output.definition.id
      ]))[0];
      if (!suggestedProfile) {
        throw issue('PLANNER_SUGGESTION_PROFILE_MISMATCH', '채널 설정 자동 제안이 현재 추천과 Profile에 속하지 않습니다.', 409, {
          channel: output.type
        });
      }
      output.plannerSuggestionProfileId = suggestedProfile.id;
      const defaults = output.definition.default_settings && typeof output.definition.default_settings === 'object'
        ? output.definition.default_settings
        : {};
      const suggestedSettings = normalizeProfileSettings(output.definition, {
        ...defaults,
        ...parseJson(suggestedProfile.settings, {})
      });
      output.settingsOrigin = JSON.stringify(suggestedSettings) === JSON.stringify(output.settings)
        ? 'automatic_suggestion'
        : 'automatic_suggestion_edited';
    }
    await assertContextVersion(tx, 'creator_identity_versions', creatorIdentityVersionId, workspaceId, 'Creator Identity');
    await assertContextVersion(tx, 'creator_voice_versions', creatorVoiceVersionId, workspaceId, 'Creator Voice');
    await assertContextVersion(tx, 'audience_persona_versions', audiencePersonaVersionId, workspaceId, 'Audience Persona');
    const normalizedCta = cleanText(commonCta, 1_000);
    const brief = {
      purposeByChannel: Object.fromEntries(normalized.map((output) => [output.type, output.settings.purpose])),
      creatorIdentityVersionId,
      creatorVoiceVersionId,
      audiencePersonaVersionId,
      cta: normalizedCta,
      sources: resolvedSources.map((source) => ({
        sourceKey: source.sourceKey,
        snapshotId: source.snapshotId,
        suggestionSourceId: source.suggestionSourceId,
        isPrimary: source.isPrimary
      }))
    };
    const planId = id();
    const runId = id();
    await tx.query(`INSERT INTO plans (id, workspace_id, source_item_id, snapshot_id, creator_identity_version_id, creator_voice_version_id, audience_persona_version_id, language, common_cta, brief, source_readiness_acknowledged, source_readiness_acknowledged_at, planner_suggestion_run_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,CASE WHEN $11 THEN now() ELSE NULL END,$12,$13)`, [
      planId,
      workspaceId,
      primarySource.sourceItemId,
      primarySource.snapshotId,
      creatorIdentityVersionId,
      creatorVoiceVersionId,
      audiencePersonaVersionId,
      language === 'ko' ? 'ko' : 'ko',
      normalizedCta,
      JSON.stringify(brief),
      Boolean(sourceReadinessAcknowledged),
      normalizedSuggestionRunId,
      userId
    ]);
    for (const source of resolvedSources) {
      await tx.query(`INSERT INTO plan_source_snapshots
          (plan_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
           suggestion_source_id,readiness_acknowledged,readiness_acknowledged_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 THEN now() ELSE NULL END)`, [
        planId,
        source.sourceItemId,
        source.snapshotId,
        source.sourceKey,
        source.ordinal,
        source.isPrimary,
        source.suggestionSourceId,
        source.isPrimary
          ? Boolean(sourceReadinessAcknowledged)
          : Boolean(supplementalReadinessAcknowledged)
      ]);
    }
    for (const source of supplementalSources) {
      for (const atom of seedAtomsBySourceKey.get(source.sourceKey) || []) {
        await tx.query(`INSERT INTO plan_source_seed_atoms
            (plan_id,source_item_id,snapshot_id,content_atom_id)
          VALUES ($1,$2,$3,$4)`, [
          planId,
          source.sourceItemId,
          source.snapshotId,
          atom.content_atom_id
        ]);
      }
    }
    await tx.query("INSERT INTO runs (id, workspace_id, plan_id, run_type, status, created_by) VALUES ($1,$2,$3,'artifact_generation','queued',$4)", [runId, workspaceId, planId, userId]);
    await tx.query(`INSERT INTO run_source_snapshots
        (run_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
         readiness_acknowledged,readiness_acknowledged_at)
      SELECT $1,source_item_id,snapshot_id,source_key,ordinal,is_primary,
        readiness_acknowledged,readiness_acknowledged_at
      FROM plan_source_snapshots
      WHERE plan_id=$2
      ORDER BY ordinal`, [runId, planId]);
    await tx.query(`INSERT INTO run_source_seed_atoms
        (run_id,source_item_id,snapshot_id,content_atom_id)
      SELECT $1,source_item_id,snapshot_id,content_atom_id
      FROM plan_source_seed_atoms
      WHERE plan_id=$2
      ORDER BY source_item_id,content_atom_id`, [runId, planId]);
    for (const output of normalized) {
      const outputId = id();
      await tx.query(`INSERT INTO plan_outputs (id, plan_id, output_type, channel_definition_version_id,
          evaluator_provider_id,selected,settings,status,settings_origin,planner_suggestion_profile_id)
        VALUES ($1,$2,$3,$4,$5,true,$6::jsonb,'queued',$7,$8)`, [
        outputId,
        planId,
        output.type,
        output.definition.id,
        selectedEvaluatorProviderId,
        JSON.stringify(output.settings),
        output.settingsOrigin,
        output.plannerSuggestionProfileId
      ]);
      await enqueue(tx, {
        workspaceId,
        eventType: 'generate_plan_output',
        payload: { planId, planOutputId: outputId, providerId, evaluatorProviderId: selectedEvaluatorProviderId, runId },
        dedupeKey: `generation:${outputId}`
      });
    }
    await audit(tx, { workspaceId, actorId: userId, action: 'plan.created', entityType: 'plan', entityId: planId, detail: { selectedOutputs: normalized.map((output) => output.type), sourceCount: resolvedSources.length } });
    await recordDomainEvent(tx, { workspaceId, actorId: userId, eventType: 'plan.created', aggregateType: 'plan', aggregateId: planId, payload: { selectedOutputs: normalized.map((output) => output.type), sourceCount: resolvedSources.length } });
    return {
      planId,
      runId,
      selectedOutputs: normalized.map((output) => output.type),
      sourceReadiness: combinedReadiness,
      sourceSnapshots: resolvedSources.map((source) => ({
        sourceKey: source.sourceKey,
        snapshotId: source.snapshotId,
        isPrimary: source.isPrimary
      })),
      sourceWarningAcknowledged: Boolean(sourceReadinessAcknowledged),
      evaluatorAssurance: providerId === selectedEvaluatorProviderId ? 'LOW_ASSURANCE' : 'HIGH_ASSURANCE'
    };
  });
}

export async function retryPlanOutput(db, {
  workspaceId,
  userId,
  planOutputId,
  providerId,
  evaluatorProviderId = null
}) {
  if (!providerId) throw issue('PROVIDER_REQUIRED', '재시도에 사용할 Model Provider를 선택하세요.', 422);
  return db.transaction(async (tx) => {
    const output = (await tx.query(`SELECT output.id,output.plan_id,output.status,output.artifact_id,
        output.evaluator_provider_id,plan.workspace_id
      FROM plan_outputs output JOIN plans plan ON plan.id=output.plan_id
      WHERE output.id=$1 AND plan.workspace_id=$2
      FOR UPDATE OF output`, [planOutputId, workspaceId]))[0];
    if (!output) throw issue('PLAN_OUTPUT_NOT_FOUND', '재시도할 결과물 작업을 찾을 수 없습니다.', 404);
    if (output.status !== 'failed') {
      throw issue('PLAN_OUTPUT_RETRY_NOT_ALLOWED', '실패로 종료된 결과물 작업만 새 실행으로 재시도할 수 있습니다.', 409);
    }
    const baseVersionId = output.artifact_id
      ? (await tx.query(`SELECT current_version_id
        FROM artifacts
        WHERE id=$1 AND workspace_id=$2
        FOR UPDATE`, [output.artifact_id, workspaceId]))[0]?.current_version_id
      : null;
    if (output.artifact_id && !baseVersionId) {
      throw issue(
        'REGENERATION_BASE_VERSION_CHANGED',
        '기존 결과물의 현재 버전을 고정할 수 없어 재시도를 시작하지 않았습니다.',
        409,
        { retryable: false }
      );
    }
    const provider = (await tx.query(`SELECT id FROM model_provider_configs
      WHERE id=$1 AND workspace_id=$2 AND enabled=true
        AND provider_type<>'fixture' AND secret_ciphertext IS NOT NULL`, [providerId, workspaceId]))[0];
    if (!provider) throw issue('PROVIDER_NOT_READY', '재시도에 사용할 실제 Provider가 준비되지 않았습니다.', 409);
    const selectedEvaluatorProviderId = evaluatorProviderId || providerId;
    const evaluator = (await tx.query(`SELECT id FROM model_provider_configs
      WHERE id=$1 AND workspace_id=$2 AND enabled=true
        AND provider_type<>'fixture' AND secret_ciphertext IS NOT NULL`, [selectedEvaluatorProviderId, workspaceId]))[0];
    if (!evaluator) throw issue('EVALUATOR_PROVIDER_NOT_READY', '재시도에 사용할 평가 Provider가 준비되지 않았습니다.', 409);
    const runId = id();
    await tx.query(`INSERT INTO runs
        (id,workspace_id,plan_id,run_type,status,created_by)
      VALUES ($1,$2,$3,'artifact_generation_retry','queued',$4)`, [
      runId,
      workspaceId,
      output.plan_id,
      userId
    ]);
    await tx.query(`INSERT INTO run_source_snapshots
        (run_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
         readiness_acknowledged,readiness_acknowledged_at)
      SELECT $1,source_item_id,snapshot_id,source_key,ordinal,is_primary,
        readiness_acknowledged,readiness_acknowledged_at
      FROM plan_source_snapshots
      WHERE plan_id=$2
      ORDER BY ordinal`, [runId, output.plan_id]);
    await tx.query(`INSERT INTO run_source_seed_atoms
        (run_id,source_item_id,snapshot_id,content_atom_id)
      SELECT $1,source_item_id,snapshot_id,content_atom_id
      FROM plan_source_seed_atoms
      WHERE plan_id=$2
      ORDER BY source_item_id,content_atom_id`, [runId, output.plan_id]);
    await tx.query(`UPDATE plan_outputs
      SET status='queued',quality_status='pending',error_message=NULL,evaluator_provider_id=$2
      WHERE id=$1`, [output.id, selectedEvaluatorProviderId]);
    await enqueue(tx, {
      workspaceId,
      eventType: 'generate_plan_output',
      payload: {
        planId: output.plan_id,
        planOutputId: output.id,
        providerId,
        evaluatorProviderId: selectedEvaluatorProviderId,
        baseVersionId,
        runId,
        requestedBy: userId
      },
      dedupeKey: `generation-retry:${output.id}:${runId}`
    });
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: 'plan_output.retry_requested',
      entityType: 'plan_output',
      entityId: output.id,
      detail: {
        runId,
        baseVersionId,
        generatorProviderId: providerId,
        evaluatorProviderId: selectedEvaluatorProviderId,
        evaluatorAssurance: providerId === selectedEvaluatorProviderId ? 'LOW_ASSURANCE' : 'HIGH_ASSURANCE'
      }
    });
    await recordDomainEvent(tx, {
      workspaceId,
      actorId: userId,
      eventType: 'plan_output.retry_requested',
      aggregateType: 'plan_output',
      aggregateId: output.id,
      payload: {
        runId,
        baseVersionId,
        generatorProviderId: providerId,
        evaluatorProviderId: selectedEvaluatorProviderId
      }
    });
    return {
      runId,
      baseVersionId,
      status: 'queued',
      evaluatorAssurance: providerId === selectedEvaluatorProviderId ? 'LOW_ASSURANCE' : 'HIGH_ASSURANCE'
    };
  });
}

export function parseModelJson(content) {
  const fenced = String(content).match(/```(?:json)?\s*([\s\S]*?)```/i);
  try { return JSON.parse(fenced ? fenced[1] : content); } catch { throw issue('MODEL_SCHEMA_INVALID', '모델이 채널 스키마에 맞는 JSON을 반환하지 않았습니다. 재시도할 수 있습니다.', 502); }
}

export function validateChannelOutput(channel, candidate, atomByPosition, lockedIdentityFacts) {
  const identityClaims = Array.isArray(candidate.identityClaims) ? candidate.identityClaims.map((claim) => cleanText(claim, 500)).filter(Boolean) : [];
  if (identityClaims.some((claim) => !lockedIdentityFacts.includes(claim))) throw issue('PERSONA_FABRICATION', '근거에 없는 Creator Identity 사실이 생성되어 작업을 보류했습니다.', 422);
  const resolveRefs = (positions, required = true) => {
    const refs = (Array.isArray(positions) ? positions : []).map((position) => atomByPosition.get(position)).filter(Boolean);
    if (required && !refs.length) throw issue('MISSING_SOURCE_REFERENCE', '사실성 블록에는 적어도 하나의 원본 위치가 필요합니다.', 422);
    return refs;
  };
  const factual = (key, type, content, positions, autoCheck = {}) => ({ key, type, content, refs: resolveRefs(positions), evidenceState: 'review_required', autoCheck: { ...autoCheck, sourceLinked: true } });
  const optional = (key, type, content, autoCheck = {}) => ({ key, type, content, refs: [], evidenceState: 'not_required', autoCheck });
  const sections = (rows, prefix, type, schemaCode) => {
    if (!Array.isArray(rows) || !rows.length) throw issue(schemaCode, '하나 이상의 본문 섹션이 필요합니다.', 422);
    return rows.map((section, index) => {
      const heading = cleanText(section.heading, 300); const body = cleanText(section.body, 8_000);
      if (!heading || !body) throw issue(schemaCode, `${index + 1}번째 섹션이 비어 있습니다.`, 422);
      return factual(`${prefix}-${index + 1}`, type, `${heading}\n${body}`, section.sourcePositions, { type, hasHeading: true });
    });
  };

  if (channel === 'naver_blog') {
    if (!cleanText(candidate.title, 200) || !cleanText(candidate.intro, 4_000)) throw issue('NAVER_SCHEMA_INVALID', 'Naver Blog에는 제목과 도입이 필요합니다.', 422);
    const structuredSections = sections(candidate.sections, 'section', 'naver_section', 'NAVER_SCHEMA_INVALID');
    return { channel, preview: { type: 'naver_article', title: cleanText(candidate.title, 200), intro: cleanText(candidate.intro, 4_000), sections: structuredSections.map((block) => { const [heading, ...body] = block.content.split('\n'); return { heading, body: body.join('\n') }; }), cta: cleanText(candidate.cta, 1_000), tags: Array.isArray(candidate.tags) ? candidate.tags.map((tag) => cleanText(tag, 60)).filter(Boolean).slice(0, 10) : [] }, blocks: [factual('intro', 'naver_intro', cleanText(candidate.intro, 4_000), candidate.introSourcePositions, { type: 'naver_intro' }), ...structuredSections, ...(cleanText(candidate.cta, 1_000) ? [optional('cta', 'cta', cleanText(candidate.cta, 1_000), { type: 'naver_cta' })] : [])] };
  }

  if (channel === 'wordpress_article') {
    if (!cleanText(candidate.title, 200) || !cleanText(candidate.excerpt, 800) || !cleanText(candidate.intro, 4_000)) throw issue('WORDPRESS_SCHEMA_INVALID', 'WordPress Article에는 제목, 발췌, 도입이 필요합니다.', 422);
    const structuredSections = sections(candidate.sections, 'section', 'wordpress_section', 'WORDPRESS_SCHEMA_INVALID');
    return { channel, preview: { type: 'wordpress_article', title: cleanText(candidate.title, 200), excerpt: cleanText(candidate.excerpt, 800), intro: cleanText(candidate.intro, 4_000), sections: structuredSections.map((block) => { const [heading, ...body] = block.content.split('\n'); return { heading, body: body.join('\n') }; }), cta: cleanText(candidate.cta, 1_000) }, blocks: [factual('intro', 'wordpress_intro', cleanText(candidate.intro, 4_000), candidate.introSourcePositions, { type: 'wordpress_intro' }), ...structuredSections, ...(cleanText(candidate.cta, 1_000) ? [optional('cta', 'cta', cleanText(candidate.cta, 1_000), { type: 'wordpress_cta' })] : [])] };
  }

  if (channel === 'newsletter') {
    if (!cleanText(candidate.subject, 200) || !cleanText(candidate.preheader, 300) || !cleanText(candidate.opening, 4_000)) throw issue('NEWSLETTER_SCHEMA_INVALID', 'Newsletter에는 제목, 프리헤더, 시작 문단이 필요합니다.', 422);
    const modules = sections(candidate.modules, 'module', 'newsletter_module', 'NEWSLETTER_SCHEMA_INVALID');
    return { channel, preview: { type: 'newsletter', subject: cleanText(candidate.subject, 200), preheader: cleanText(candidate.preheader, 300), opening: cleanText(candidate.opening, 4_000), modules: modules.map((block) => { const [heading, ...body] = block.content.split('\n'); return { heading, body: body.join('\n') }; }), cta: cleanText(candidate.cta, 1_000) }, blocks: [factual('opening', 'newsletter_opening', cleanText(candidate.opening, 4_000), candidate.openingSourcePositions, { type: 'newsletter_opening' }), ...modules, ...(cleanText(candidate.cta, 1_000) ? [optional('cta', 'cta', cleanText(candidate.cta, 1_000), { type: 'newsletter_cta' })] : [])] };
  }

  if (channel === 'instagram_carousel') {
    if (!cleanText(candidate.coverHook, 300) || !Array.isArray(candidate.slides) || !candidate.slides.length) throw issue('INSTAGRAM_SCHEMA_INVALID', 'Instagram Carousel에는 커버 훅과 하나 이상의 슬라이드가 필요합니다.', 422);
    const slides = candidate.slides.map((slide, index) => {
      const headline = cleanText(slide.headline, 300); const body = cleanText(slide.body, 1_500); const visualDirection = cleanText(slide.visualDirection, 500);
      if (!headline || !body || !visualDirection) throw issue('INSTAGRAM_SCHEMA_INVALID', `${index + 1}번째 슬라이드의 제목, 본문, 시각 지시가 필요합니다.`, 422);
      return factual(`slide-${index + 1}`, 'carousel_slide', `${headline}\n${body}\n시각: ${visualDirection}`, slide.sourcePositions, { type: 'carousel_slide', visualDirectionPresent: true });
    });
    return { channel, preview: { type: 'instagram_carousel', coverHook: cleanText(candidate.coverHook, 300), slides: slides.map((block) => { const [headline, body, visual] = block.content.split('\n'); return { headline, body, visualDirection: visual.replace(/^시각:\s*/, '') }; }), caption: cleanText(candidate.caption, 2_200), hashtags: Array.isArray(candidate.hashtags) ? candidate.hashtags.map((tag) => cleanText(tag, 60)).filter(Boolean).slice(0, 20) : [] }, blocks: [factual('cover', 'carousel_cover', cleanText(candidate.coverHook, 300), candidate.coverSourcePositions, { type: 'carousel_cover' }), ...slides] };
  }

  if (channel === 'short_video') {
    if (!cleanText(candidate.hook, 1_000) || !Array.isArray(candidate.scenes) || !candidate.scenes.length || !cleanText(candidate.ending, 1_000)) throw issue('SHORT_SCHEMA_INVALID', 'Short Video에는 훅, 장면, 마무리가 필요합니다.', 422);
    const scenes = candidate.scenes.map((scene, index) => {
      const durationSeconds = Number(scene.durationSeconds); const narration = cleanText(scene.narration, 2_000); const visual = cleanText(scene.visual, 1_000); const onScreenText = cleanText(scene.onScreenText, 500);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30 || !narration || !visual) throw issue('SHORT_SCHEMA_INVALID', `Short Video ${index + 1}번째 장면의 시간·내레이션·화면 지시가 필요합니다.`, 422);
      return factual(`scene-${index + 1}`, 'scene', `화면: ${visual}\n자막: ${onScreenText}\n내레이션: ${narration}`, scene.sourcePositions, { type: 'short_scene', durationSeconds, captionPresent: Boolean(onScreenText) });
    });
    return { channel, preview: { type: 'short_video_script', hook: cleanText(candidate.hook, 1_000), scenes: scenes.map((block) => { const pairs = Object.fromEntries(block.content.split('\n').map((line) => { const [key, ...rest] = line.split(':'); return [key, rest.join(':').trim()]; })); return { visual: pairs['화면'], onScreenText: pairs['자막'], narration: pairs['내레이션'], durationSeconds: block.autoCheck.durationSeconds }; }), ending: cleanText(candidate.ending, 1_000), caption: cleanText(candidate.caption, 2_000) }, blocks: [factual('hook', 'hook', cleanText(candidate.hook, 1_000), candidate.hookSourcePositions, { type: 'short_hook' }), ...scenes, optional('ending', 'ending', cleanText(candidate.ending, 1_000), { type: 'short_ending' })] };
  }
  throw issue('UNSUPPORTED_OUTPUT', '지원하지 않는 channel입니다.');
}
