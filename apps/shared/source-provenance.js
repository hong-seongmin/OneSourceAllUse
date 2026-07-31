import { parseJson } from './ids.js';
import { issue } from './errors.js';

const READINESS_PRIORITY = new Map([
  ['complete', 0],
  ['partial', 1],
  ['insufficient', 2],
  ['incompatible', 3],
  ['quarantined', 4]
]);

export async function loadPlanSourceSnapshots(db, planId) {
  const sources = await db.query(`SELECT plan_source.plan_id,plan_source.source_item_id,plan_source.snapshot_id,
      plan_source.source_key,plan_source.ordinal,plan_source.is_primary,
      plan_source.suggestion_source_id,plan_source.readiness_acknowledged,
      plan_source.readiness_acknowledged_at,
      snapshot.version_no,snapshot.title,
      assessment.readiness,assessment.rights_status,assessment.usable_atom_ids,
      assessment.omissions,assessment.signals,assessment.acknowledgement_required
    FROM plan_source_snapshots plan_source
    JOIN source_snapshots snapshot ON snapshot.id=plan_source.snapshot_id
    LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=plan_source.snapshot_id
    WHERE plan_source.plan_id=$1
    ORDER BY plan_source.ordinal`, [planId]);
  if (sources.length) return sources;
  return db.query(`SELECT plan.id AS plan_id,plan.source_item_id,plan.snapshot_id,
      'source_1' AS source_key,1 AS ordinal,true AS is_primary,
      NULL::text AS suggestion_source_id,
      plan.source_readiness_acknowledged AS readiness_acknowledged,
      plan.source_readiness_acknowledged_at AS readiness_acknowledged_at,
      snapshot.version_no,snapshot.title,
      assessment.readiness,assessment.rights_status,assessment.usable_atom_ids,
      assessment.omissions,assessment.signals,assessment.acknowledgement_required
    FROM plans plan
    JOIN source_snapshots snapshot ON snapshot.id=plan.snapshot_id
    LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=plan.snapshot_id
    WHERE plan.id=$1`, [planId]);
}

export async function loadRunSourceSnapshots(db, runId, planId) {
  const sources = await db.query(`SELECT run_source.run_id,run_source.source_item_id,
      run_source.snapshot_id,run_source.source_key,run_source.ordinal,
      run_source.is_primary,NULL::text AS suggestion_source_id,
      run_source.readiness_acknowledged,run_source.readiness_acknowledged_at,
      snapshot.version_no,snapshot.title,
      assessment.readiness,assessment.rights_status,assessment.usable_atom_ids,
      assessment.omissions,assessment.signals,assessment.acknowledgement_required
    FROM run_source_snapshots run_source
    JOIN runs run ON run.id=run_source.run_id
    JOIN source_snapshots snapshot ON snapshot.id=run_source.snapshot_id
    LEFT JOIN source_snapshot_assessments assessment
      ON assessment.snapshot_id=run_source.snapshot_id
    WHERE run_source.run_id=$1 AND run.plan_id=$2
    ORDER BY run_source.ordinal`, [runId, planId]);
  if (sources.length) return sources;
  return loadPlanSourceSnapshots(db, planId);
}

export async function loadArtifactVersionSourceSnapshots(db, artifactVersionId) {
  const sources = await db.query(`SELECT version_source.artifact_version_id,version_source.source_item_id,
      version_source.snapshot_id,version_source.source_key,version_source.ordinal,
      version_source.is_primary,version_source.readiness_acknowledged,
      version_source.readiness_acknowledged_at,snapshot.version_no,snapshot.title
    FROM artifact_version_source_snapshots version_source
    JOIN source_snapshots snapshot ON snapshot.id=version_source.snapshot_id
    WHERE version_source.artifact_version_id=$1
    ORDER BY version_source.ordinal`, [artifactVersionId]);
  if (sources.length) return sources;
  return db.query(`SELECT version.id AS artifact_version_id,snapshot.source_item_id,
      version.source_snapshot_id AS snapshot_id,'source_1' AS source_key,
      1 AS ordinal,true AS is_primary,
      COALESCE(plan_source.readiness_acknowledged,false) AS readiness_acknowledged,
      plan_source.readiness_acknowledged_at,snapshot.version_no,snapshot.title
    FROM artifact_versions version
    JOIN source_snapshots snapshot ON snapshot.id=version.source_snapshot_id
    LEFT JOIN runs run ON run.id=version.created_by_run_id
    LEFT JOIN plan_source_snapshots plan_source
      ON plan_source.plan_id=run.plan_id
      AND plan_source.source_item_id=snapshot.source_item_id
      AND plan_source.snapshot_id=version.source_snapshot_id
    WHERE version.id=$1`, [artifactVersionId]);
}

export async function persistArtifactVersionSourceSnapshots(db, artifactVersionId, sources) {
  for (const source of sources) {
    await db.query(`INSERT INTO artifact_version_source_snapshots
        (artifact_version_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
         readiness_acknowledged,readiness_acknowledged_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      artifactVersionId,
      source.source_item_id ?? source.sourceItemId,
      source.snapshot_id ?? source.snapshotId,
      source.source_key ?? source.sourceKey,
      Number(source.ordinal),
      Boolean(source.is_primary ?? source.isPrimary),
      Boolean(source.readiness_acknowledged ?? source.readinessAcknowledged),
      source.readiness_acknowledged_at ?? source.readinessAcknowledgedAt ?? null
    ]);
  }
}

export async function lockSourceItems(db, sourceItemIds) {
  const ids = [...new Set(sourceItemIds.filter(Boolean))].sort();
  if (!ids.length) return [];
  return db.query(`SELECT id,latest_snapshot_id
    FROM source_items
    WHERE id=ANY($1::text[])
    ORDER BY id
    FOR SHARE`, [ids]);
}

export async function latestSnapshotsForVersionSources(db, artifactVersionId) {
  const versionSources = await loadArtifactVersionSourceSnapshots(db, artifactVersionId);
  if (!versionSources.length) return [];
  const rows = await db.query(`SELECT item.id AS source_item_id,item.latest_snapshot_id AS snapshot_id,
      snapshot.version_no,snapshot.title,assessment.readiness,assessment.rights_status,
      assessment.usable_atom_ids,assessment.omissions,assessment.signals,
      assessment.acknowledgement_required
    FROM source_items item
    JOIN source_snapshots snapshot ON snapshot.id=item.latest_snapshot_id
    LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=item.latest_snapshot_id
    WHERE item.id=ANY($1::text[])`, [versionSources.map((source) => source.source_item_id)]);
  const byItem = new Map(rows.map((row) => [row.source_item_id, row]));
  return versionSources.map((source) => ({
    ...byItem.get(source.source_item_id),
    source_key: source.source_key,
    ordinal: source.ordinal,
    is_primary: source.is_primary
  })).filter((source) => source.source_item_id);
}

function readinessIssue(source) {
  if (source.readiness === 'quarantined') {
    return issue('SOURCE_PROMPT_INJECTION', '최신 원본에 격리된 보안 신호가 있어 재생성할 수 없습니다.', 409, {
      sourceKey: source.source_key
    });
  }
  if (source.readiness === 'incompatible') {
    return issue('SOURCE_RIGHTS_INCOMPATIBLE', '최신 원본의 권리 상태가 파생 콘텐츠 재생성을 허용하지 않습니다.', 409, {
      sourceKey: source.source_key
    });
  }
  return issue('SOURCE_CONTENT_INSUFFICIENT', '최신 원본에 재생성할 수 있는 근거가 부족합니다.', 409, {
    sourceKey: source.source_key,
    readiness: source.readiness || null
  });
}

/**
 * Freeze a regeneration's complete source and supplemental evidence set.
 * The plan stays immutable; retries read only these run-scoped relations.
 */
export async function freezeLatestRunSources(db, {
  runId,
  artifactVersionId,
  acknowledgedSourceSnapshotIds = []
}) {
  const existing = await db.query(`SELECT source_item_id,snapshot_id,source_key,ordinal,is_primary,
      readiness_acknowledged,readiness_acknowledged_at
    FROM run_source_snapshots
    WHERE run_id=$1
    ORDER BY ordinal`, [runId]);
  if (existing.length) return existing;

  const versionSources = await loadArtifactVersionSourceSnapshots(db, artifactVersionId);
  if (!versionSources.length) {
    throw issue('SOURCE_SNAPSHOT_REQUIRED', '재생성할 결과물 버전의 원본 집합을 찾을 수 없습니다.', 409);
  }
  const lockedItems = await lockSourceItems(db, versionSources.map((source) => source.source_item_id));
  if (lockedItems.length !== versionSources.length) {
    throw issue('SOURCE_ITEM_NOT_FOUND', '재생성할 원본 항목 전체를 고정할 수 없습니다.', 409);
  }
  const latestSources = await latestSnapshotsForVersionSources(db, artifactVersionId);
  if (latestSources.length !== versionSources.length) {
    throw issue('SOURCE_SNAPSHOT_REQUIRED', '선택한 원본 전체의 최신 스냅샷을 찾을 수 없습니다.', 409);
  }
  const priorByItem = new Map(versionSources.map((source) => [source.source_item_id, source]));
  const acknowledgedSnapshots = new Set(
    (Array.isArray(acknowledgedSourceSnapshotIds) ? acknowledgedSourceSnapshotIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  const acknowledgementTargets = new Set(latestSources
    .filter((source) => {
      const prior = priorByItem.get(source.source_item_id);
      return prior?.snapshot_id !== source.snapshot_id
        && (source.readiness === 'partial' || Boolean(source.acknowledgement_required));
    })
    .map((source) => source.snapshot_id));
  const unexpectedAcknowledgement = [...acknowledgedSnapshots]
    .find((snapshotId) => !acknowledgementTargets.has(snapshotId));
  if (unexpectedAcknowledgement) {
    throw issue(
      'SOURCE_ACKNOWLEDGEMENT_MISMATCH',
      '현재 재생성에 확인이 필요한 최신 원본만 선택할 수 있습니다.',
      409
    );
  }
  for (const source of latestSources) {
    if (!['complete', 'partial'].includes(source.readiness)) throw readinessIssue(source);
    const prior = priorByItem.get(source.source_item_id);
    const changed = prior?.snapshot_id !== source.snapshot_id;
    const acknowledgementRequired = source.readiness === 'partial'
      || Boolean(source.acknowledgement_required);
    const acknowledged = acknowledgementRequired
      ? changed
        ? acknowledgedSnapshots.has(source.snapshot_id)
        : Boolean(prior?.readiness_acknowledged)
      : false;
    if (acknowledgementRequired && !acknowledged) {
      throw issue(
        source.is_primary
          ? 'SOURCE_ACKNOWLEDGEMENT_REQUIRED'
          : 'SUPPLEMENTAL_SOURCE_ACKNOWLEDGEMENT_REQUIRED',
        source.is_primary
          ? '최신 주 원본의 누락 범위를 확인한 뒤 재생성하세요.'
          : '최신 보조 원본의 누락 범위를 확인한 뒤 재생성하세요.',
        409,
        {
          sourceKey: source.source_key,
          omissions: parseJson(source.omissions, [])
        }
      );
    }
    source.readiness_acknowledged = acknowledged;
    source.readiness_acknowledged_at = acknowledged
      ? (changed ? new Date().toISOString() : prior?.readiness_acknowledged_at || new Date().toISOString())
      : null;
  }

  const version = (await db.query(`SELECT version.created_by_run_id,
      COALESCE(execution.plan_output_id,artifact_output.id) AS plan_output_id,
      COALESCE(execution_output.plan_id,artifact_output.plan_id) AS plan_id
    FROM artifact_versions version
    JOIN artifacts artifact ON artifact.id=version.artifact_id
    LEFT JOIN generation_executions execution ON execution.artifact_version_id=version.id
    LEFT JOIN plan_outputs execution_output ON execution_output.id=execution.plan_output_id
    LEFT JOIN plan_outputs artifact_output
      ON artifact_output.artifact_id=artifact.id AND execution.plan_output_id IS NULL
    WHERE version.id=$1
    ORDER BY execution.created_at DESC NULLS LAST
    LIMIT 1`, [artifactVersionId]))[0];
  if (!version?.plan_id) {
    throw issue('REFRESH_PLAN_REQUIRED', '재생성할 원본 근거 계획을 찾을 수 없습니다.', 409);
  }
  let priorSeeds = version.created_by_run_id
    ? await db.query(`SELECT seed.source_item_id,atom.fingerprint,atom.position_label
        FROM run_source_seed_atoms seed
        JOIN content_atoms atom ON atom.id=seed.content_atom_id
        WHERE seed.run_id=$1
        ORDER BY seed.source_item_id,atom.position_label,atom.id`, [version.created_by_run_id])
    : [];
  if (!priorSeeds.length) {
    priorSeeds = await db.query(`SELECT seed.source_item_id,atom.fingerprint,atom.position_label
      FROM plan_source_seed_atoms seed
      JOIN content_atoms atom ON atom.id=seed.content_atom_id
      WHERE seed.plan_id=$1
      ORDER BY seed.source_item_id,atom.position_label,atom.id`, [version.plan_id]);
  }
  const priorSeedsByItem = new Map();
  for (const seed of priorSeeds) {
    if (!priorSeedsByItem.has(seed.source_item_id)) priorSeedsByItem.set(seed.source_item_id, []);
    priorSeedsByItem.get(seed.source_item_id).push(seed);
  }

  const latestSnapshotIds = latestSources.map((source) => source.snapshot_id);
  const latestAtoms = await db.query(`SELECT atom.id,atom.snapshot_id,atom.fingerprint,
      atom.position_label,segment.segment_type
    FROM content_atoms atom
    JOIN source_segments segment ON segment.id=atom.segment_id
    WHERE atom.snapshot_id=ANY($1::text[])
    ORDER BY atom.snapshot_id,segment.ordinal,atom.position_label,atom.id`, [latestSnapshotIds]);
  const atomsBySnapshot = new Map();
  for (const atom of latestAtoms) {
    if (!atomsBySnapshot.has(atom.snapshot_id)) atomsBySnapshot.set(atom.snapshot_id, []);
    atomsBySnapshot.get(atom.snapshot_id).push(atom);
  }
  const primarySource = latestSources.find((source) => source.is_primary) || latestSources[0];
  const primaryUsable = new Set(parseJson(primarySource.usable_atom_ids, []));
  const primaryFingerprints = new Set((atomsBySnapshot.get(primarySource.snapshot_id) || [])
    .filter((atom) => primaryUsable.size
      ? primaryUsable.has(atom.id)
      : atom.segment_type !== 'title')
    .map((atom) => atom.fingerprint));
  const mappedSeeds = [];
  const seenSupplementalFingerprints = new Set();
  for (const source of latestSources.filter((candidate) => !candidate.is_primary)) {
    const prior = priorSeedsByItem.get(source.source_item_id) || [];
    if (!prior.length) {
      throw issue('REGENERATION_SOURCE_RANGE_MISSING', '보조 원본의 고정된 근거 범위를 찾을 수 없어 새 계획이 필요합니다.', 409, {
        sourceKey: source.source_key
      });
    }
    const usable = new Set(parseJson(source.usable_atom_ids, []));
    const candidates = (atomsBySnapshot.get(source.snapshot_id) || []).filter((atom) =>
      usable.size ? usable.has(atom.id) : atom.segment_type !== 'title');
    const usedAtomIds = new Set();
    for (const seed of prior) {
      const atom = candidates.find((candidate) =>
        !usedAtomIds.has(candidate.id) && candidate.fingerprint === seed.fingerprint)
        || candidates.find((candidate) =>
          !usedAtomIds.has(candidate.id) && candidate.position_label === seed.position_label);
      if (!atom) continue;
      usedAtomIds.add(atom.id);
      if (primaryFingerprints.has(atom.fingerprint)
        || seenSupplementalFingerprints.has(atom.fingerprint)) continue;
      seenSupplementalFingerprints.add(atom.fingerprint);
      mappedSeeds.push({ source, atom });
    }
    if (!mappedSeeds.some((entry) => entry.source.source_item_id === source.source_item_id)) {
      throw issue('REGENERATION_SOURCE_RANGE_MISSING', '보조 원본의 최신 스냅샷에서 고정 근거 범위를 복원할 수 없어 새 추천이 필요합니다.', 409, {
        sourceKey: source.source_key
      });
    }
  }

  for (const source of latestSources) {
    await db.query(`INSERT INTO run_source_snapshots
        (run_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
         readiness_acknowledged,readiness_acknowledged_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      runId,
      source.source_item_id,
      source.snapshot_id,
      source.source_key,
      Number(source.ordinal),
      Boolean(source.is_primary),
      Boolean(source.readiness_acknowledged),
      source.readiness_acknowledged_at
    ]);
  }
  for (const { source, atom } of mappedSeeds) {
    await db.query(`INSERT INTO run_source_seed_atoms
        (run_id,source_item_id,snapshot_id,content_atom_id)
      VALUES ($1,$2,$3,$4)`, [
      runId,
      source.source_item_id,
      source.snapshot_id,
      atom.id
    ]);
  }
  return latestSources;
}

export function combinedSourceAssessment(sources) {
  const ordered = [...sources].sort((left, right) =>
    (READINESS_PRIORITY.get(right.readiness) ?? 2) - (READINESS_PRIORITY.get(left.readiness) ?? 2));
  const readiness = ordered[0]?.readiness || 'insufficient';
  return {
    readiness,
    rightsStatus: sources.every((source) => source.rights_status === 'owned')
      ? 'owned'
      : sources.some((source) => source.rights_status === 'restricted')
        ? 'restricted'
        : 'mixed',
    omissions: sources.flatMap((source) =>
      parseJson(source.omissions, []).map((value) => `${source.source_key}: ${value}`)),
    signals: sources.flatMap((source) =>
      parseJson(source.signals, []).map((value) => `${source.source_key}: ${value}`)),
    acknowledgementRequired: sources.some((source) => Boolean(source.acknowledgement_required)),
    sources: sources.map((source) => ({
      sourceKey: source.source_key,
      snapshotId: source.snapshot_id,
      readiness: source.readiness || 'insufficient',
      omissions: parseJson(source.omissions, [])
    }))
  };
}

export async function insertVerificationSourceRefs(db, verificationId, atomIds) {
  for (const atomId of [...new Set(atomIds.filter(Boolean))]) {
    await db.query(`INSERT INTO verification_source_refs
        (verification_id,content_atom_id)
      VALUES ($1,$2)`, [verificationId, atomId]);
  }
}

export async function matchingActiveVerifications(db, blockIds) {
  if (!blockIds.length) return [];
  return db.query(`SELECT verification.*
    FROM verifications verification
    WHERE verification.artifact_block_id=ANY($1::text[])
      AND verification.invalidated_at IS NULL
      AND NOT EXISTS (
        SELECT ref.content_atom_id
        FROM block_source_refs ref
        WHERE ref.artifact_block_id=verification.artifact_block_id
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
        WHERE ref.artifact_block_id=verification.artifact_block_id
      )`, [blockIds]);
}
