import { audit, enqueue, recordDomainEvent } from './audit.js';
import { id, parseJson, sha256 } from './ids.js';
import { issue } from './errors.js';
import {
  legacyPreviewWithBlockEdit,
  previewWithBlockEdits,
  validateEditedPreview
} from './platform-adapters.js';
import { currentVersionDriftFromRefs } from './freshness.js';
import { isLegacyPlatformProfileId, loadPlatformProfile } from './channel-registry.js';
import { atomSourceHandle, sourceFingerprintKey, withSourceHandle } from './source-handles.js';
import {
  combinedSourceAssessment,
  freezeLatestRunSources,
  insertVerificationSourceRefs,
  loadArtifactVersionSourceSnapshots,
  lockSourceItems,
  matchingActiveVerifications,
  persistArtifactVersionSourceSnapshots
} from './source-provenance.js';

const blockerMessages = {
  safety: '미해결 불일치·변경 영향·보류 블록을 먼저 처리하세요.',
  automated_failure: '자동 품질 검사 실패를 해결한 뒤 다시 승인하세요.',
  human_verification: '현재 원본 스냅샷과 직접 비교하지 않은 사실 블록이 있습니다.',
  partial_source_acknowledgement: '부분 원본의 누락 범위를 생성 계획에서 먼저 확인하세요.'
};

export async function approvalBlockers(db, { workspaceId, artifactId }) {
  const artifact = (await db.query(`SELECT a.current_version_id, av.source_snapshot_id,
      p.id AS plan_id, p.source_readiness_acknowledged
    FROM artifacts a
    JOIN artifact_versions av ON av.id = a.current_version_id
    LEFT JOIN generation_executions execution ON execution.artifact_version_id = av.id
    LEFT JOIN plan_outputs execution_output ON execution_output.id = execution.plan_output_id
    LEFT JOIN plan_outputs artifact_output ON artifact_output.artifact_id = a.id AND execution_output.id IS NULL
    LEFT JOIN plans p ON p.id = COALESCE(execution_output.plan_id, artifact_output.plan_id)
    WHERE a.id = $1 AND a.workspace_id = $2
    ORDER BY execution.created_at DESC NULLS LAST
    LIMIT 1`, [artifactId, workspaceId]))[0];
  if (!artifact) throw issue('ARTIFACT_NOT_FOUND', '결과물을 찾을 수 없습니다.', 404);
  const versionSources = await loadArtifactVersionSourceSnapshots(db, artifact.current_version_id);
  const sourceAcknowledgements = await db.query(`SELECT version_source.snapshot_id,
      version_source.readiness_acknowledged,assessment.readiness,
      assessment.acknowledgement_required
    FROM artifact_version_source_snapshots version_source
    LEFT JOIN source_snapshot_assessments assessment
      ON assessment.snapshot_id=version_source.snapshot_id
    WHERE version_source.artifact_version_id=$1
    ORDER BY version_source.ordinal`, [artifact.current_version_id]);
  const hasUnacknowledgedPartialSource = sourceAcknowledgements.some((source) =>
    (source.readiness === 'partial' || source.acknowledgement_required)
      && !source.readiness_acknowledged);

  const unsafe = (await db.query(`SELECT
      count(*) FILTER (WHERE evidence_state = 'conflict' OR stale = true OR held = true)::int AS affected,
      count(*) FILTER (WHERE evidence_state = 'conflict')::int AS conflicts,
      count(*) FILTER (WHERE stale = true)::int AS stale,
      count(*) FILTER (WHERE held = true)::int AS held
    FROM artifact_blocks WHERE artifact_version_id = $1`, [artifact.current_version_id]))[0];
  const sourceDrift = await currentVersionDriftFromRefs(db, { workspaceId, artifactId });
  const unresolvedAutomaticFailures = (await db.query(`SELECT count(DISTINCT finding.id)::int AS count
    FROM generation_executions execution
    JOIN quality_evaluation_runs evaluation ON evaluation.execution_id = execution.id
    JOIN quality_findings finding ON finding.evaluation_run_id = evaluation.id
    WHERE execution.artifact_version_id = $1
      AND finding.severity = 'fail'
      AND finding.status = 'open'`, [artifact.current_version_id]))[0].count;
  const unverifiedFactualBlocks = await db.query(`SELECT block.id, block.block_key, block.ordinal
    FROM artifact_blocks block
    WHERE block.artifact_version_id = $1
      AND block.content_kind = 'factual'
      AND NOT EXISTS (
        SELECT 1 FROM verifications verification
        WHERE verification.artifact_block_id = block.id
          AND verification.invalidated_at IS NULL
          AND NOT EXISTS (
            SELECT ref.content_atom_id
            FROM block_source_refs ref
            WHERE ref.artifact_block_id=block.id
            EXCEPT
            SELECT verification_ref.content_atom_id
            FROM verification_source_refs verification_ref
            WHERE verification_ref.verification_id=verification.id
          )
          AND NOT EXISTS (
            SELECT verification_ref.content_atom_id
            FROM verification_source_refs verification_ref
            WHERE verification_ref.verification_id=verification.id
            EXCEPT
            SELECT ref.content_atom_id
            FROM block_source_refs ref
            WHERE ref.artifact_block_id=block.id
          )
      )
    ORDER BY block.ordinal`, [artifact.current_version_id]);

  const blockers = [];
  const pendingSourceDrift = sourceDrift.filter((block) =>
    !block.stale && !block.held && block.evidence_state !== 'conflict'
  ).length;
  const unsafeCount = Number(unsafe.affected) + pendingSourceDrift;
  if (unsafeCount) blockers.push({
    code: 'APPROVAL_BLOCKED',
    type: 'safety',
    message: blockerMessages.safety,
    count: unsafeCount,
    detail: {
      conflicts: Number(unsafe.conflicts),
      stale: Number(unsafe.stale),
      held: Number(unsafe.held),
      pendingSourceDrift
    }
  });
  if (unresolvedAutomaticFailures) blockers.push({
    code: 'APPROVAL_AUTOMATED_FAILURE_UNRESOLVED',
    type: 'automated_failure',
    message: blockerMessages.automated_failure,
    count: Number(unresolvedAutomaticFailures)
  });
  if (unverifiedFactualBlocks.length) blockers.push({
    code: 'HUMAN_VERIFICATION_REQUIRED',
    type: 'human_verification',
    message: blockerMessages.human_verification,
    count: unverifiedFactualBlocks.length,
    blocks: unverifiedFactualBlocks.map((block) => ({
      blockId: block.id,
      blockKey: block.block_key,
      label: `사실 블록 ${block.ordinal}`
    }))
  });
  if (hasUnacknowledgedPartialSource) blockers.push({
    code: 'APPROVAL_BLOCKED',
    type: 'partial_source_acknowledgement',
    message: blockerMessages.partial_source_acknowledgement,
    count: 1
  });
  return blockers;
}

export async function getArtifactReview(db, workspaceId, artifactId) {
  const artifact = (await db.query(`SELECT a.*, av.content, av.source_snapshot_id, av.created_at AS version_created_at,
      av.version_no, av.channel_definition_version_id, av.prompt_bundle_version, av.evaluator_version, av.created_by_run_id
    FROM artifacts a JOIN artifact_versions av ON av.id = a.current_version_id
    WHERE a.id = $1 AND a.workspace_id = $2`, [artifactId, workspaceId]))[0];
  if (!artifact) throw issue('ARTIFACT_NOT_FOUND', '결과물을 찾을 수 없습니다.', 404);
  const versionSources = await loadArtifactVersionSourceSnapshots(db, artifact.current_version_id);
  const sourceBySnapshot = new Map(versionSources.map((source) => [source.snapshot_id, source]));

  const blocks = await db.query(`SELECT b.*, EXISTS(
      SELECT 1 FROM verifications v
      WHERE v.artifact_block_id = b.id
        AND v.invalidated_at IS NULL
        AND NOT EXISTS (
          SELECT ref.content_atom_id
          FROM block_source_refs ref
          WHERE ref.artifact_block_id=b.id
          EXCEPT
          SELECT verification_ref.content_atom_id
          FROM verification_source_refs verification_ref
          WHERE verification_ref.verification_id=v.id
        )
        AND NOT EXISTS (
          SELECT verification_ref.content_atom_id
          FROM verification_source_refs verification_ref
          WHERE verification_ref.verification_id=v.id
          EXCEPT
          SELECT ref.content_atom_id
          FROM block_source_refs ref
          WHERE ref.artifact_block_id=b.id
        )
    ) AS human_verified
    FROM artifact_blocks b WHERE b.artifact_version_id = $1 ORDER BY b.ordinal`, [
    artifact.current_version_id
  ]);
  const sourceDrift = await currentVersionDriftFromRefs(db, { workspaceId, artifactId });
  const sourceDriftBlockIds = new Set(sourceDrift.map((block) => block.block_id));
  const refs = blocks.length ? (await db.query(`SELECT r.artifact_block_id, a.id AS atom_id,
      a.snapshot_id,a.position_label,a.text,s.id AS segment_id
    FROM block_source_refs r
    JOIN content_atoms a ON a.id = r.content_atom_id
    JOIN source_segments s ON s.id = a.segment_id
    WHERE r.artifact_block_id = ANY($1::text[])
    ORDER BY a.snapshot_id,a.position_label`, [
    blocks.map((block) => block.id)
  ])).map((ref) => {
    const source = sourceBySnapshot.get(ref.snapshot_id);
    return withSourceHandle({
      ...ref,
      source_item_id: source?.source_item_id,
      source_key: source?.source_key
    });
  }).sort((left, right) =>
    Number(sourceBySnapshot.get(left.snapshot_id)?.ordinal || 1)
      - Number(sourceBySnapshot.get(right.snapshot_id)?.ordinal || 1)
    || left.position_label.localeCompare(right.position_label, 'ko')) : [];
  const refsByBlock = new Map(blocks.map((block) => [block.id, []]));
  for (const ref of refs) refsByBlock.get(ref.artifact_block_id)?.push(ref);

  const automaticFindings = await db.query(`SELECT finding.artifact_block_id, finding.block_key, finding.surface_path,
      finding.code, finding.dimension, finding.severity, finding.status, finding.message, finding.recovery,
      finding.details, finding.created_at, finding.resolved_at,
      evaluation.assurance, evaluation.evaluator_version
    FROM generation_executions execution
    JOIN quality_evaluation_runs evaluation ON evaluation.execution_id = execution.id
    JOIN quality_findings finding ON finding.evaluation_run_id = evaluation.id
    WHERE execution.artifact_version_id = $1
    ORDER BY finding.created_at, finding.code`, [artifact.current_version_id]);
  const humanVerificationHistory = await db.query(`SELECT verification.artifact_block_id, block.block_key,
      version.version_no, verification.note, verification.verified_at, verification.invalidated_at,
      verification.invalidation_reason, reviewer.email AS reviewer_email,
      NOT EXISTS (
        SELECT ref.content_atom_id
        FROM block_source_refs ref
        WHERE ref.artifact_block_id=block.id
        EXCEPT
        SELECT verification_ref.content_atom_id
        FROM verification_source_refs verification_ref
        WHERE verification_ref.verification_id=verification.id
      ) AND NOT EXISTS (
        SELECT verification_ref.content_atom_id
        FROM verification_source_refs verification_ref
        WHERE verification_ref.verification_id=verification.id
        EXCEPT
        SELECT ref.content_atom_id
        FROM block_source_refs ref
        WHERE ref.artifact_block_id=block.id
      ) AS matches_version_snapshot
    FROM artifact_versions version
    JOIN artifact_blocks block ON block.artifact_version_id = version.id
    JOIN verifications verification ON verification.artifact_block_id = block.id
    JOIN users reviewer ON reviewer.id = verification.verified_by
    WHERE version.artifact_id = $1
    ORDER BY verification.verified_at DESC`, [artifactId]);
  const context = (await db.query(`SELECT plan.id AS plan_id,plan.source_readiness_acknowledged,
      identity.version_no AS identity_version_no,
      voice.version_no AS voice_version_no,
      persona.version_no AS persona_version_no, persona.name AS persona_name,
      definition.display_name AS channel_name, definition.version_no AS channel_version_no,
      assessment.readiness AS source_readiness,
      assessment.omissions AS source_omissions,
      run.run_type, run.status AS run_status, run.started_at, run.completed_at,
      execution.status AS execution_status, execution.stage AS execution_stage,
      execution.pipeline_version, execution.prompt_bundle_version AS execution_prompt_bundle_version,
      execution.evaluator_version AS execution_evaluator_version,
      execution.evaluator_assurance, execution.readiness_state
    FROM artifact_versions version
    JOIN artifacts artifact ON artifact.id = version.artifact_id
    LEFT JOIN generation_executions execution ON execution.artifact_version_id = version.id
    LEFT JOIN plan_outputs execution_output ON execution_output.id = execution.plan_output_id
    LEFT JOIN plan_outputs artifact_output ON artifact_output.artifact_id = artifact.id AND execution_output.id IS NULL
    LEFT JOIN plans plan ON plan.id = COALESCE(execution_output.plan_id, artifact_output.plan_id)
    LEFT JOIN creator_identity_versions identity ON identity.id = plan.creator_identity_version_id
    LEFT JOIN creator_voice_versions voice ON voice.id = plan.creator_voice_version_id
    LEFT JOIN audience_persona_versions persona ON persona.id = plan.audience_persona_version_id
    LEFT JOIN channel_definition_versions definition ON definition.id = version.channel_definition_version_id
    LEFT JOIN runs run ON run.id = $2
    LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id = $4
    WHERE version.id = $3 AND artifact.id = $1
    ORDER BY execution.created_at DESC
    LIMIT 1`, [
    artifactId,
    artifact.created_by_run_id,
    artifact.current_version_id,
    artifact.source_snapshot_id
  ]))[0] || {};
  const assessmentRows = await db.query(`SELECT snapshot_id,readiness,rights_status,
      omissions,signals,acknowledgement_required
    FROM source_snapshot_assessments
    WHERE snapshot_id=ANY($1::text[])`, [versionSources.map((source) => source.snapshot_id)]);
  const assessmentBySnapshot = new Map(assessmentRows.map((source) => [source.snapshot_id, source]));
  const versionSourceAssessments = versionSources.map((source) => ({
    ...assessmentBySnapshot.get(source.snapshot_id),
    source_key: source.source_key,
    snapshot_id: source.snapshot_id
  }));
  const sourceAssessment = combinedSourceAssessment(versionSourceAssessments);
  const reviewSourceAcknowledgements = await db.query(`SELECT
      version_source.snapshot_id,version_source.readiness_acknowledged,
      assessment.readiness,assessment.acknowledgement_required
    FROM artifact_version_source_snapshots version_source
    LEFT JOIN source_snapshot_assessments assessment
      ON assessment.snapshot_id=version_source.snapshot_id
    WHERE version_source.artifact_version_id=$1
    ORDER BY version_source.ordinal`, [artifact.current_version_id]);
  const allRequiredSourcesAcknowledged = reviewSourceAcknowledgements.length
    ? reviewSourceAcknowledgements.every((source) =>
      (source.readiness !== 'partial' && !source.acknowledgement_required)
        || source.readiness_acknowledged)
    : false;
  const versions = await db.query(`SELECT version_no, created_at,
      id = $2 AS current, prompt_bundle_version, evaluator_version
    FROM artifact_versions WHERE artifact_id = $1 ORDER BY version_no DESC`, [artifactId, artifact.current_version_id]);
  const exports = await db.query(`SELECT version.version_no, export.target, export.status, export.external_id,
      export.error_message, export.created_at, export.updated_at
    FROM exports export JOIN artifact_versions version ON version.id = export.artifact_version_id
    WHERE version.artifact_id = $1 ORDER BY export.created_at DESC`, [artifactId]);
  const comments = await db.query(`SELECT comment.id,comment.artifact_version_id,
      comment.artifact_block_id,block.block_key,version.version_no,
      version.id=$2 AS current_version,comment.body,
      comment.created_at,comment.resolved_at,author.email AS author_email,
      resolver.email AS resolved_by_email
    FROM artifact_comments comment
    JOIN artifact_versions version ON version.id = comment.artifact_version_id
    LEFT JOIN artifact_blocks block ON block.id = comment.artifact_block_id
    JOIN users author ON author.id = comment.author_id
    LEFT JOIN users resolver ON resolver.id = comment.resolved_by
    WHERE version.artifact_id = $1 ORDER BY comment.created_at DESC`, [artifactId, artifact.current_version_id]);
  const approvalHistory = await db.query(`SELECT version.version_no, approval.approved_at, approval.revoked_at,
      approval.note, approver.email AS approver_email
    FROM approvals approval
    JOIN artifact_versions version ON version.id = approval.artifact_version_id
    JOIN users approver ON approver.id = approval.approved_by
    WHERE version.artifact_id = $1 ORDER BY approval.approved_at DESC`, [artifactId]);
  const blockers = await approvalBlockers(db, { workspaceId, artifactId });
  const currentApproval = approvalHistory.find((approval) => approval.version_no === artifact.version_no && !approval.revoked_at);
  const reviewBlocks = blocks.map((block) => ({
    ...block,
    human_verified: Boolean(block.human_verified) && !sourceDriftBlockIds.has(block.id),
    source_drift_pending: sourceDriftBlockIds.has(block.id),
    auto_check: parseJson(block.auto_check),
    sourceRefs: refsByBlock.get(block.id) || []
  }));
  const humanVerificationBlocker = blockers.find((blocker) => blocker.type === 'human_verification');
  const blockerPendingIds = new Set((humanVerificationBlocker?.blocks || []).map((block) => block.blockId));
  const factualBlocks = reviewBlocks.filter((block) => block.content_kind === 'factual');
  const pendingHumanVerification = factualBlocks
    .filter((block) => blockerPendingIds.has(block.id) || !block.human_verified)
    .map((block) => ({
      blockId: block.id,
      blockKey: block.block_key,
      ordinal: block.ordinal,
      blockType: block.block_type,
      sourceRefCount: block.sourceRefs.length,
      state: block.source_drift_pending
        ? 'source_update_pending'
        : block.stale
          ? 'stale'
          : block.held
            ? 'held'
            : block.evidence_state === 'conflict'
              ? 'conflict'
              : !block.sourceRefs.length
                ? 'source_required'
                : 'ready'
    }));

  return {
    artifact: {
      ...artifact,
      content: parseJson(artifact.content),
      approved: Boolean(currentApproval),
      label: `${context.channel_name || artifact.channel} · 버전 ${artifact.version_no}`
    },
    blocks: reviewBlocks,
    automaticFindings: automaticFindings.map((finding) => ({
      ...finding,
      details: parseJson(finding.details),
      label: finding.surface_path || finding.block_key || finding.dimension
    })),
    humanVerification: {
      current: humanVerificationHistory.filter((verification) =>
        verification.version_no === artifact.version_no
        && !verification.invalidated_at
        && verification.matches_version_snapshot
        && !sourceDriftBlockIds.has(verification.artifact_block_id)
      ),
      history: humanVerificationHistory,
      progress: {
        total: factualBlocks.length,
        completed: factualBlocks.length - pendingHumanVerification.length,
        pending: pendingHumanVerification.length
      },
      pending: pendingHumanVerification
    },
    profile: {
      channel: {
        name: context.channel_name || artifact.channel,
        version: context.channel_version_no || null,
        label: context.channel_version_no
          ? `${context.channel_name} · 프로필 버전 ${context.channel_version_no}`
          : (context.channel_name || artifact.channel)
      },
      creatorIdentity: context.identity_version_no
        ? { version: context.identity_version_no, label: `Creator Identity · 버전 ${context.identity_version_no}` }
        : null,
      creatorVoice: context.voice_version_no
        ? { version: context.voice_version_no, label: `Creator Voice · 버전 ${context.voice_version_no}` }
        : null,
      audience: context.persona_version_no
        ? { name: context.persona_name, version: context.persona_version_no, label: `${context.persona_name} · 버전 ${context.persona_version_no}` }
        : null,
      source: {
        readiness: sourceAssessment.readiness,
        omissions: sourceAssessment.omissions,
        sources: sourceAssessment.sources,
        partialAcknowledged: allRequiredSourcesAcknowledged
      }
    },
    run: {
      type: context.run_type || null,
      status: context.run_status || null,
      startedAt: context.started_at || null,
      completedAt: context.completed_at || null,
      execution: context.execution_status ? {
        status: context.execution_status,
        stage: context.execution_stage,
        pipelineVersion: context.pipeline_version,
        promptBundleVersion: context.execution_prompt_bundle_version,
        evaluatorVersion: context.execution_evaluator_version,
        evaluatorAssurance: context.evaluator_assurance,
        readiness: context.readiness_state
      } : null
    },
    versions: versions.map((version) => ({ ...version, label: `버전 ${version.version_no}` })),
    exports,
    comments,
    approval: { active: currentApproval || null, history: approvalHistory, blockers }
  };
}

async function lockCurrentBlock(tx, { workspaceId, blockId, lockSource = false }) {
  // Every mutation that can change approval safety starts with the artifact
  // row. Approval, export, source invalidation, verification, conflict, and
  // hold transitions therefore serialize on one stable lock order.
  const artifact = (await tx.query(`SELECT a.id,a.current_version_id,a.source_item_id
    FROM artifacts a
    WHERE a.workspace_id=$2
      AND a.id=(
        SELECT version.artifact_id
        FROM artifact_blocks block
        JOIN artifact_versions version ON version.id=block.artifact_version_id
        WHERE block.id=$1
      )
    FOR UPDATE`, [blockId, workspaceId]))[0];
  if (!artifact) return null;

  if (lockSource) {
    const versionSources = await loadArtifactVersionSourceSnapshots(tx, artifact.current_version_id);
    const sources = await lockSourceItems(tx, versionSources.map((source) => source.source_item_id));
    if (!versionSources.length || sources.length !== versionSources.length) {
      throw issue('SOURCE_ITEM_NOT_FOUND', '결과물의 원본 항목을 찾을 수 없습니다.', 409);
    }
  }

  const block = (await tx.query(`SELECT block.*,
      (SELECT source_snapshot_id FROM artifact_versions WHERE id=block.artifact_version_id) AS source_snapshot_id
    FROM artifact_blocks block
    WHERE block.id=$1 AND block.artifact_version_id=$2
    FOR UPDATE`, [blockId, artifact.current_version_id]))[0];
  if (!block) return null;
  return { artifact, block };
}

async function updateArtifactSafetyState(tx, { artifactId, artifactVersionId }) {
  const safety = (await tx.query(`SELECT
      count(*) FILTER (WHERE held=true)::int AS held,
      count(*) FILTER (WHERE stale=true)::int AS stale
    FROM artifact_blocks
    WHERE artifact_version_id=$1`, [artifactVersionId]))[0];
  const state = Number(safety.held) > 0
    ? 'held'
    : Number(safety.stale) > 0
      ? 'stale'
      : 'review_required';
  await tx.query('UPDATE artifacts SET state=$2,updated_at=now() WHERE id=$1', [
    artifactId,
    state
  ]);
  return state;
}

export async function verifyBlock(db, { workspaceId, userId, blockId, note = '' }) {
  return db.transaction(async (tx) => {
    const locked = await lockCurrentBlock(tx, { workspaceId, blockId, lockSource: true });
    if (!locked) throw issue('BLOCK_NOT_FOUND', '검토할 블록을 찾을 수 없습니다.', 404);
    const { artifact, block } = locked;
    if (
      block.content_kind !== 'factual'
      || block.stale
      || block.held
      || block.evidence_state === 'conflict'
    ) {
      throw issue(
        'VERIFICATION_BLOCKED',
        '변경 영향·불일치·보류 상태를 먼저 해결한 뒤 현재 원본과 대조하세요.',
        409,
        {
          stale: Boolean(block.stale),
          held: Boolean(block.held),
          conflict: block.evidence_state === 'conflict'
        }
      );
    }
    const refState = (await tx.query(`SELECT count(*)::int AS count,
        count(*) FILTER (WHERE version_source.snapshot_id IS NOT NULL)::int AS current_snapshot_count
      FROM block_source_refs ref
      JOIN content_atoms atom ON atom.id = ref.content_atom_id
      LEFT JOIN artifact_version_source_snapshots version_source
        ON version_source.artifact_version_id=$2
        AND version_source.snapshot_id=atom.snapshot_id
      WHERE ref.artifact_block_id = $1`, [blockId, block.artifact_version_id]))[0];
    if (!refState.count) throw issue('VERIFICATION_SOURCE_REQUIRED', '원본 연결이 없는 블록은 사람 확인을 기록할 수 없습니다.', 409);
    if (refState.count !== refState.current_snapshot_count) throw issue('VERIFICATION_SOURCE_MISMATCH', '현재 결과물 버전의 원본 스냅샷에 속하지 않는 연결이 있어 사람 확인을 기록할 수 없습니다.', 409);
    const sourceDrift = await currentVersionDriftFromRefs(tx, {
      workspaceId,
      artifactId: artifact.id
    });
    if (sourceDrift.some((drift) => drift.block_id === block.id)) {
      throw issue(
        'SOURCE_UPDATE_PENDING',
        '연결된 원본 변경 영향 처리가 끝나지 않아 사람 확인을 기록할 수 없습니다.',
        409,
        { blockId: block.id }
      );
    }
    const sourceRefs = await tx.query(`SELECT content_atom_id
      FROM block_source_refs WHERE artifact_block_id=$1 ORDER BY content_atom_id`, [blockId]);
    await tx.query('UPDATE verifications SET invalidated_at = now(), invalidation_reason = $2 WHERE artifact_block_id = $1 AND invalidated_at IS NULL', [blockId, '새 사람 확인으로 대체됨']);
    const verificationId = id();
    await tx.query('INSERT INTO verifications (id, artifact_block_id, source_snapshot_id, verified_by, note) VALUES ($1,$2,$3,$4,$5)', [verificationId, blockId, block.source_snapshot_id, userId, String(note).slice(0, 2_000)]);
    await insertVerificationSourceRefs(tx, verificationId, sourceRefs.map((ref) => ref.content_atom_id));
    await tx.query("UPDATE artifact_blocks SET evidence_state='verified' WHERE id=$1", [blockId]);
    await audit(tx, { workspaceId, actorId: userId, action: 'block.human_verified', entityType: 'artifact_block', entityId: blockId });
    await recordDomainEvent(tx, { workspaceId, actorId: userId, eventType: 'block.human_verified', aggregateType: 'artifact_block', aggregateId: blockId });
  });
}

export async function setBlockConflict(db, { workspaceId, userId, blockId, conflict, note = '' }) {
  return db.transaction(async (tx) => {
    const locked = await lockCurrentBlock(tx, { workspaceId, blockId });
    if (!locked) throw issue('BLOCK_NOT_FOUND', '블록을 찾을 수 없습니다.', 404);
    const { artifact, block } = locked;
    const nextConflict = Boolean(conflict);
    await tx.query(`UPDATE artifact_blocks
      SET evidence_state = $2
      WHERE id = $1`, [blockId, nextConflict ? 'conflict' : 'review_required']);
    if (nextConflict) {
      await tx.query(`UPDATE verifications
        SET invalidated_at = now(), invalidation_reason = $2
        WHERE artifact_block_id = $1 AND invalidated_at IS NULL`, [blockId, String(note).trim() || '사람 검토에서 원본 불일치가 확인됨']);
      await tx.query('UPDATE approvals SET revoked_at = now() WHERE artifact_version_id = $1 AND revoked_at IS NULL', [block.artifact_version_id]);
    }
    await updateArtifactSafetyState(tx, {
      artifactId: artifact.id,
      artifactVersionId: block.artifact_version_id
    });
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: nextConflict ? 'block.conflict_recorded' : 'block.conflict_cleared',
      entityType: 'artifact_block',
      entityId: blockId,
      detail: { note: String(note).slice(0, 2_000) }
    });
    await recordDomainEvent(tx, {
      workspaceId,
      actorId: userId,
      eventType: nextConflict ? 'block.conflict_recorded' : 'block.conflict_cleared',
      aggregateType: 'artifact_block',
      aggregateId: blockId
    });
    return { blockId, evidenceState: nextConflict ? 'conflict' : 'review_required' };
  });
}

export async function setBlockHold(db, { workspaceId, userId, blockId, held }) {
  return db.transaction(async (tx) => {
    const locked = await lockCurrentBlock(tx, { workspaceId, blockId });
    if (!locked) throw issue('BLOCK_NOT_FOUND', '블록을 찾을 수 없습니다.', 404);
    const { artifact, block } = locked;
    await tx.query('UPDATE artifact_blocks SET held = $2 WHERE id = $1', [blockId, Boolean(held)]);
    if (held) {
      await tx.query('UPDATE approvals SET revoked_at=now() WHERE artifact_version_id=$1 AND revoked_at IS NULL', [block.artifact_version_id]);
    }
    await updateArtifactSafetyState(tx, {
      artifactId: artifact.id,
      artifactVersionId: block.artifact_version_id
    });
    await audit(tx, { workspaceId, actorId: userId, action: held ? 'block.held' : 'block.released', entityType: 'artifact_block', entityId: blockId });
  });
}

export async function addArtifactComment(db, {
  workspaceId,
  userId,
  artifactId,
  blockId = null,
  body
}) {
  const commentBody = String(body ?? '').replace(/\u0000/gu, '').trim().slice(0, 4_000);
  if (!commentBody) throw issue('COMMENT_BODY_REQUIRED', '검토 의견을 입력하세요.', 422);
  return db.transaction(async (tx) => {
    const artifact = (await tx.query(`SELECT id,current_version_id
      FROM artifacts WHERE id=$1 AND workspace_id=$2`, [artifactId, workspaceId]))[0];
    if (!artifact) throw issue('ARTIFACT_NOT_FOUND', '의견을 남길 결과물을 찾을 수 없습니다.', 404);
    let targetBlockId = null;
    if (blockId) {
      const block = (await tx.query(`SELECT id FROM artifact_blocks
        WHERE id=$1 AND artifact_version_id=$2`, [blockId, artifact.current_version_id]))[0];
      if (!block) throw issue('BLOCK_NOT_FOUND', '현재 결과물 버전의 블록을 찾을 수 없습니다.', 404);
      targetBlockId = block.id;
    }
    const commentId = id();
    await tx.query(`INSERT INTO artifact_comments
      (id,artifact_version_id,artifact_block_id,author_id,body)
      VALUES ($1,$2,$3,$4,$5)`, [
      commentId,
      artifact.current_version_id,
      targetBlockId,
      userId,
      commentBody
    ]);
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: 'artifact.comment_added',
      entityType: 'artifact',
      entityId: artifactId,
      detail: { blockScoped: Boolean(targetBlockId) }
    });
    return { commentId };
  });
}

export async function resolveArtifactComment(db, {
  workspaceId,
  userId,
  artifactId,
  commentId
}) {
  return db.transaction(async (tx) => {
    const comment = (await tx.query(`SELECT comment.id,comment.resolved_at
      FROM artifact_comments comment
      JOIN artifact_versions version ON version.id=comment.artifact_version_id
      JOIN artifacts artifact ON artifact.id=version.artifact_id
      WHERE comment.id=$1 AND artifact.id=$2 AND artifact.workspace_id=$3
      FOR UPDATE`, [commentId, artifactId, workspaceId]))[0];
    if (!comment) throw issue('COMMENT_NOT_FOUND', '검토 의견을 찾을 수 없습니다.', 404);
    if (!comment.resolved_at) {
      await tx.query(`UPDATE artifact_comments
        SET resolved_at=now(),resolved_by=$2 WHERE id=$1`, [commentId, userId]);
      await audit(tx, {
        workspaceId,
        actorId: userId,
        action: 'artifact.comment_resolved',
        entityType: 'artifact',
        entityId: artifactId,
        detail: { commentId }
      });
    }
    return { resolved: true };
  });
}

export async function editArtifactBlock(db, {
  workspaceId,
  userId,
  artifactId,
  blockId,
  content,
  sourcePositions = [],
  note = ''
}) {
  const nextContent = cleanEditableContent(content);
  return db.transaction(async (tx) => {
    const artifact = (await tx.query(`SELECT a.*,version.version_no,version.source_snapshot_id,
        version.content AS preview_content,version.channel_definition_version_id,
        version.prompt_bundle_version,version.evaluator_version,version.created_by_run_id,
        (
          SELECT output.plan_id
          FROM plan_outputs output
          WHERE output.artifact_id=a.id
          ORDER BY output.created_at DESC
          LIMIT 1
        ) AS plan_id
      FROM artifacts a JOIN artifact_versions version ON version.id=a.current_version_id
      WHERE a.id=$1 AND a.workspace_id=$2 FOR UPDATE`, [artifactId, workspaceId]))[0];
    if (!artifact) throw issue('ARTIFACT_NOT_FOUND', '편집할 결과물을 찾을 수 없습니다.', 404);
    const blocks = await tx.query('SELECT * FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal', [artifact.current_version_id]);
    const target = blocks.find((block) => block.id === blockId);
    if (!target) throw issue('BLOCK_NOT_FOUND', '현재 결과물 버전의 편집 블록을 찾을 수 없습니다.', 404);
    const versionSources = await loadArtifactVersionSourceSnapshots(tx, artifact.current_version_id);
    if (!versionSources.length) throw issue('ARTIFACT_SOURCE_SET_MISSING', '현재 결과물 버전의 원본 집합을 찾을 수 없습니다.', 409);
    const sourceBySnapshot = new Map(versionSources.map((source) => [source.snapshot_id, source]));
    const snapshotAtoms = (await tx.query(`SELECT atom.id,atom.snapshot_id,atom.position_label,
        atom.fingerprint,segment.segment_type
      FROM content_atoms atom
      JOIN source_segments segment ON segment.id=atom.segment_id
      WHERE atom.snapshot_id=ANY($1::text[])
      ORDER BY atom.snapshot_id,atom.position_label`, [versionSources.map((source) => source.snapshot_id)]))
      .map((atom) => {
        const source = sourceBySnapshot.get(atom.snapshot_id);
        return withSourceHandle({
          ...atom,
          source_item_id: source?.source_item_id,
          source_key: source?.source_key
        });
      });
    const assessmentRows = await tx.query(`SELECT snapshot_id,usable_atom_ids
      FROM source_snapshot_assessments
      WHERE snapshot_id=ANY($1::text[])`, [versionSources.map((source) => source.snapshot_id)]);
    const assessmentBySnapshot = new Map(assessmentRows.map((assessment) => [
      assessment.snapshot_id,
      new Set(parseJson(assessment.usable_atom_ids, []))
    ]));
    const primarySource = versionSources.find((source) => source.is_primary) || versionSources[0];
    const runSeedRows = artifact.created_by_run_id
      ? await tx.query(`SELECT content_atom_id
          FROM run_source_seed_atoms WHERE run_id=$1`, [artifact.created_by_run_id])
      : [];
    const supplementalSeedIds = new Set((runSeedRows.length
      ? runSeedRows
      : artifact.plan_id
        ? await tx.query(`SELECT content_atom_id
            FROM plan_source_seed_atoms WHERE plan_id=$1`, [artifact.plan_id])
        : [])
      .map((seed) => seed.content_atom_id));
    const allAtoms = snapshotAtoms.filter((atom) => {
      const source = sourceBySnapshot.get(atom.snapshot_id);
      const usableIds = assessmentBySnapshot.get(atom.snapshot_id) || new Set();
      if (!usableIds.has(atom.id)) return false;
      return source?.source_key === primarySource.source_key
        || supplementalSeedIds.has(atom.id);
    });
    const positions = [...new Set((Array.isArray(sourcePositions) ? sourcePositions : []).map((value) => String(value).trim()).filter(Boolean))];
    let targetRefs = [];
    if (target.content_kind === 'factual') {
      if (!positions.length) throw issue('EDIT_SOURCE_REFERENCE_REQUIRED', '사실 블록 편집에는 현재 원본 위치가 하나 이상 필요합니다.', 422);
      targetRefs = positions.map((position) => {
        const qualified = allAtoms.find((atom) => atom.handle === position);
        if (qualified) return qualified;
        const matches = allAtoms.filter((atom) => atom.position_label === position);
        if (matches.length !== 1) return null;
        return matches[0];
      }).filter(Boolean);
      if (targetRefs.length !== positions.length) throw issue('EDIT_SOURCE_REFERENCE_REQUIRED', '현재 원본 스냅샷에 없는 위치가 포함되어 있습니다.', 422);
    } else if (positions.length) {
      throw issue('ARTIFACT_EDIT_SCHEMA_INVALID', 'editorial/production 블록에는 사실 원본 위치를 연결할 수 없습니다.', 422);
    }
    let preview = String(target.surface_path).startsWith('$.') && !String(target.surface_path).startsWith('$.legacy.')
      ? previewWithBlockEdits(parseJson(artifact.preview_content), [{
        surfacePath: target.surface_path,
        content: nextContent
      }])
      : legacyPreviewWithBlockEdit(artifact.channel, parseJson(artifact.preview_content), {
        blockKey: target.block_key,
        content: nextContent
      });
    const oldRefs = blocks.length ? (await tx.query(`SELECT ref.artifact_block_id,atom.id,
        atom.snapshot_id,atom.fingerprint,atom.position_label
      FROM block_source_refs ref
      JOIN content_atoms atom ON atom.id=ref.content_atom_id
      WHERE ref.artifact_block_id=ANY($1::text[])`, [
        blocks.map((block) => block.id)
      ])).map((ref) => {
        const source = sourceBySnapshot.get(ref.snapshot_id);
        return withSourceHandle({
          ...ref,
          source_item_id: source?.source_item_id,
          source_key: source?.source_key
        });
      }) : [];
    const refsByBlock = new Map(blocks.map((block) => [block.id, []]));
    for (const ref of oldRefs) refsByBlock.get(ref.artifact_block_id)?.push(ref);
    let editDeterministicChecks = [];
    if (
      String(target.surface_path).startsWith('$.')
      && !String(target.surface_path).startsWith('$.legacy.')
      && !isLegacyPlatformProfileId(artifact.channel_definition_version_id)
    ) {
      const profile = await loadPlatformProfile(tx, artifact.channel_definition_version_id);
      const planContext = (await tx.query(`SELECT output.settings,plan.common_cta
        FROM plan_outputs output JOIN plans plan ON plan.id=output.plan_id
        WHERE output.artifact_id=$1`, [artifact.id]))[0];
      if (!planContext) throw issue('ARTIFACT_EDIT_CONTEXT_MISSING', '현재 결과물의 Platform Profile 설정을 찾을 수 없습니다.', 409);
      const prospectiveBlocks = blocks.map((block) => {
        const changed = block.id === target.id;
        const refs = changed ? targetRefs : refsByBlock.get(block.id);
        return {
          key: block.block_key,
          surfacePath: block.surface_path,
          content: changed ? nextContent : block.content,
          contentKind: block.content_kind,
          sourceHandles: refs.map((ref) => atomSourceHandle(ref))
        };
      });
      const validated = validateEditedPreview({
        profile,
        preview,
        blocks: prospectiveBlocks,
        settings: parseJson(planContext.settings),
        atomByHandle: new Map(allAtoms.map((atom) => [atomSourceHandle(atom), atom.id])),
        commonContext: { commonCta: planContext.common_cta || '' }
      });
      preview = validated.preview;
      editDeterministicChecks = validated.deterministicChecks;
    }
    const activeVerifications = await matchingActiveVerifications(tx, blocks.map((block) => block.id));
    const verificationByBlock = new Map(activeVerifications.map((verification) => [verification.artifact_block_id, verification]));
    const versionId = id();
    const versionNo = Number(artifact.version_no) + 1;
    await tx.query(`INSERT INTO artifact_versions
        (id,artifact_id,version_no,source_snapshot_id,content,created_by_run_id,
         channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`, [
      versionId,
      artifact.id,
      versionNo,
      artifact.source_snapshot_id,
      JSON.stringify(preview),
      artifact.created_by_run_id,
      artifact.channel_definition_version_id,
      artifact.prompt_bundle_version,
      artifact.evaluator_version
    ]);
    await persistArtifactVersionSourceSnapshots(tx, versionId, versionSources);
    let carriedVerificationCount = 0;
    let nextVersionHasHeldBlock = false;
    let nextVersionHasStaleBlock = false;
    for (const original of blocks) {
      const changed = original.id === target.id;
      const newBlockId = id();
      const refs = changed ? targetRefs : refsByBlock.get(original.id);
      const fingerprints = refs.map((ref) => sourceFingerprintKey(ref)).filter(Boolean).sort();
      // A text edit can replace the target conflict/hold, but it cannot make an
      // old source snapshot fresh. Safety state on every untouched block must
      // survive the immutable-version transition.
      const nextStale = Boolean(original.stale);
      const nextHeld = changed ? false : Boolean(original.held);
      const nextEvidenceState = changed
        ? (original.content_kind === 'factual' ? 'review_required' : 'not_required')
        : original.evidence_state;
      nextVersionHasStaleBlock ||= nextStale;
      nextVersionHasHeldBlock ||= nextHeld;
      const autoCheck = parseJson(original.auto_check, {});
      if (changed) {
        autoCheck.automaticSupport = original.content_kind === 'factual'
          ? 'human_verification_required_after_user_edit'
          : 'not_applicable';
        autoCheck.deterministicChecks = editDeterministicChecks;
        autoCheck.deterministicRevalidated = true;
        autoCheck.humanVerified = false;
        autoCheck.lastEditNote = String(note).trim().slice(0, 2_000);
      }
      await tx.query(`INSERT INTO artifact_blocks
          (id,artifact_version_id,block_key,block_type,ordinal,content,evidence_state,auto_check,
           stale,held,surface_path,content_kind,content_hash,atom_fingerprint_set,origin)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15)`, [
        newBlockId,
        versionId,
        original.block_key,
        original.block_type,
        original.ordinal,
        changed ? nextContent : original.content,
        nextEvidenceState,
        JSON.stringify(autoCheck),
        nextStale,
        nextHeld,
        original.surface_path,
        original.content_kind,
        changed ? sha256(nextContent) : original.content_hash,
        JSON.stringify(fingerprints),
        changed ? 'user_edit' : original.origin
      ]);
      for (const ref of refs) await tx.query('INSERT INTO block_source_refs (artifact_block_id,content_atom_id) VALUES ($1,$2)', [newBlockId, ref.id]);
      const verification = verificationByBlock.get(original.id);
      const priorRefIds = refsByBlock.get(original.id).map((ref) => ref.id).sort();
      const nextRefIds = refs.map((ref) => ref.id).sort();
      const contentUnchanged = !changed;
      const refsUnchanged = JSON.stringify(priorRefIds) === JSON.stringify(nextRefIds);
      if (verification && contentUnchanged && refsUnchanged) {
        const verificationId = id();
        await tx.query(`INSERT INTO verifications
            (id,artifact_block_id,source_snapshot_id,verified_by,note)
          VALUES ($1,$2,$3,$4,$5)`, [
          verificationId,
          newBlockId,
          artifact.source_snapshot_id,
          verification.verified_by,
          `내용과 정확한 원본 atom 참조가 동일해 이전 사람 확인을 이관함. ${verification.note || ''}`.trim().slice(0, 2_000)
        ]);
        await insertVerificationSourceRefs(tx, verificationId, refs.map((ref) => ref.id));
        await tx.query("UPDATE artifact_blocks SET evidence_state='verified' WHERE id=$1", [newBlockId]);
        carriedVerificationCount += 1;
      }
    }
    await tx.query('UPDATE approvals SET revoked_at=now() WHERE artifact_version_id=$1 AND revoked_at IS NULL', [artifact.current_version_id]);
    const nextArtifactState = nextVersionHasHeldBlock ? 'held' : nextVersionHasStaleBlock ? 'stale' : 'review_required';
    await tx.query('UPDATE artifacts SET current_version_id=$2,state=$3,updated_at=now() WHERE id=$1', [
      artifact.id,
      versionId,
      nextArtifactState
    ]);
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: 'artifact.block_edited',
      entityType: 'artifact',
      entityId: artifact.id,
      detail: {
        blockKey: target.block_key,
        previousVersion: artifact.version_no,
        nextVersion: versionNo,
        carriedVerificationCount,
        note: String(note).trim().slice(0, 2_000)
      }
    });
    await recordDomainEvent(tx, {
      workspaceId,
      actorId: userId,
      eventType: 'artifact.block_edited',
      aggregateType: 'artifact',
      aggregateId: artifact.id,
      payload: { blockKey: target.block_key, versionId, versionNo }
    });
    return { artifactId: artifact.id, versionId, versionNo, carriedVerificationCount };
  });
}

function cleanEditableContent(value) {
  const normalized = String(value ?? '').replace(/\u0000/gu, '').trim();
  if (!normalized || normalized.length > 8_000) throw issue('ARTIFACT_EDIT_SCHEMA_INVALID', '편집 내용은 1~8,000자여야 합니다.', 422);
  return normalized;
}

export async function approveArtifact(db, { workspaceId, userId, artifactId, note = '' }) {
  return db.transaction(async (tx) => {
    const artifact = (await tx.query('SELECT * FROM artifacts WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [artifactId, workspaceId]))[0];
    if (!artifact) throw issue('ARTIFACT_NOT_FOUND', '결과물을 찾을 수 없습니다.', 404);
    // Source snapshot transitions take FOR UPDATE on this row. Holding a shared
    // lock through blocker evaluation and approval closes the commit-after-check
    // race without replacing block_source_refs as the impact relation.
    const versionSources = await loadArtifactVersionSourceSnapshots(tx, artifact.current_version_id);
    const sourceLocks = await lockSourceItems(tx, versionSources.map((source) => source.source_item_id));
    if (!versionSources.length || sourceLocks.length !== versionSources.length) {
      throw issue('SOURCE_ITEM_NOT_FOUND', '결과물의 원본 항목을 찾을 수 없습니다.', 409);
    }
    const blockers = await approvalBlockers(tx, { workspaceId, artifactId });
    if (blockers.length) {
      const blocker = blockers[0];
      throw issue(blocker.code, blocker.message, 409, { blockers });
    }
    await tx.query('UPDATE approvals SET revoked_at = now() WHERE artifact_version_id = $1 AND revoked_at IS NULL', [artifact.current_version_id]);
    await tx.query('INSERT INTO approvals (id, artifact_version_id, approved_by, note) VALUES ($1,$2,$3,$4)', [id(), artifact.current_version_id, userId, String(note).slice(0, 2_000)]);
    await tx.query("UPDATE artifacts SET state = 'approved', updated_at = now() WHERE id = $1", [artifactId]);
    await audit(tx, { workspaceId, actorId: userId, action: 'artifact.approved', entityType: 'artifact', entityId: artifactId });
    await recordDomainEvent(tx, { workspaceId, actorId: userId, eventType: 'artifact.approved', aggregateType: 'artifact', aggregateId: artifactId });
  });
}

export async function requestRegeneration(db, {
  workspaceId,
  userId,
  artifactId,
  providerId,
  acknowledgedSourceSnapshotIds = [],
  confirmHumanVerificationReset = false
}) {
  if (!providerId) throw issue('PROVIDER_REQUIRED', '재생성에 사용할 Provider를 선택하세요.', 422);
  if (confirmHumanVerificationReset !== true) {
    throw issue(
      'HUMAN_VERIFICATION_RESET_CONFIRMATION_REQUIRED',
      '새 버전에서는 사람 원본 대조를 다시 기록해야 합니다. 재생성 확인을 선택하세요.',
      422
    );
  }
  return db.transaction(async (tx) => {
    const lockedArtifact = (await tx.query(`SELECT *
      FROM artifacts
      WHERE id=$1 AND workspace_id=$2
      FOR UPDATE`, [artifactId, workspaceId]))[0];
    if (!lockedArtifact) throw issue('REGENERATION_UNAVAILABLE', '생성 계획과 연결된 결과물만 재생성할 수 있습니다.', 409);
    const versionSources = await loadArtifactVersionSourceSnapshots(tx, lockedArtifact.current_version_id);
    const sourceLocks = await lockSourceItems(tx, versionSources.map((source) => source.source_item_id));
    if (!versionSources.length || sourceLocks.length !== versionSources.length) {
      throw issue('SOURCE_ITEM_NOT_FOUND', '결과물의 원본 항목을 찾을 수 없습니다.', 409);
    }
    const artifact = (await tx.query(`SELECT a.*,po.id AS plan_output_id,p.id AS plan_id,
        count(block.id) FILTER (WHERE block.stale=true)::int AS stale_count
      FROM artifacts a
      JOIN plan_outputs po ON po.artifact_id=a.id
      JOIN plans p ON p.id=po.plan_id
      JOIN artifact_versions version ON version.id=a.current_version_id
      LEFT JOIN artifact_blocks block ON block.artifact_version_id=version.id
      WHERE a.id=$1 AND a.workspace_id=$2
      GROUP BY a.id,po.id,p.id`, [artifactId, workspaceId]))[0];
    if (!artifact) throw issue('REGENERATION_UNAVAILABLE', '생성 계획과 연결된 결과물만 재생성할 수 있습니다.', 409);
    const sourceDrift = await currentVersionDriftFromRefs(tx, { workspaceId, artifactId });
    const pendingDrift = sourceDrift.filter((block) => !block.stale);
    if (pendingDrift.length) throw issue(
      'SOURCE_UPDATE_PENDING',
      '원본 변경 영향 처리가 끝난 뒤 변경 영향 결정에서 전체 재생성을 선택하세요.',
      409,
      { affectedBlockCount: pendingDrift.length }
    );
    if (artifact.stale_count) throw issue('SOURCE_REFRESH_DECISION_REQUIRED', '원본 변경 결과물은 변경 영향 결정에서 전체 재생성을 선택하세요.', 409);
    const provider = (await tx.query(`SELECT id FROM model_provider_configs
      WHERE id=$1 AND workspace_id=$2 AND enabled=true
        AND provider_type<>'fixture' AND secret_ciphertext IS NOT NULL`, [
      providerId,
      workspaceId
    ]))[0];
    if (!provider) throw issue('PROVIDER_NOT_READY', '재생성에 사용할 실제 Provider가 준비되지 않았습니다.', 409);
    const runId = id();
    await tx.query("INSERT INTO runs (id, workspace_id, plan_id, run_type, status, created_by) VALUES ($1,$2,$3,'artifact_regeneration','queued',$4)", [runId, workspaceId, artifact.plan_id, userId]);
    await freezeLatestRunSources(tx, {
      runId,
      artifactVersionId: lockedArtifact.current_version_id,
      acknowledgedSourceSnapshotIds
    });
    await enqueue(tx, {
      workspaceId,
      eventType: 'regenerate_artifact',
      payload: {
        artifactId,
        baseVersionId: artifact.current_version_id,
        providerId,
        runId,
        acknowledgedSourceSnapshotIds: Array.isArray(acknowledgedSourceSnapshotIds)
          ? acknowledgedSourceSnapshotIds
          : [],
        requestedBy: userId
      },
      dedupeKey: `regenerate:${artifactId}:${runId}`
    });
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: 'artifact.regeneration_requested',
      entityType: 'artifact',
      entityId: artifactId,
      detail: { baseVersionId: artifact.current_version_id, humanVerificationResetConfirmed: true }
    });
    return { runId, baseVersionId: artifact.current_version_id, status: 'queued' };
  });
}
