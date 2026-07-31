import { audit, enqueue, recordDomainEvent } from './audit.js';
import { id } from './ids.js';
import { issue } from './errors.js';
import {
  freezeLatestRunSources,
  loadArtifactVersionSourceSnapshots,
  lockSourceItems
} from './source-provenance.js';

export async function changedAtomIds(db, oldSnapshotId, newSnapshotId) {
  const rows = await db.query(`SELECT old.id
    FROM content_atoms old
    WHERE old.snapshot_id = $1 AND NOT EXISTS (
      SELECT 1 FROM content_atoms next WHERE next.snapshot_id = $2 AND next.fingerprint = old.fingerprint
    )`, [oldSnapshotId, newSnapshotId]);
  return rows.map((row) => row.id);
}

// This is intentionally the single impact dependency lookup. No artifact, segment, or text heuristic is used here.
export async function affectedBlocksFromRefs(db, atomIds) {
  if (!atomIds.length) return [];
  return db.query(`SELECT DISTINCT b.id AS block_id, av.artifact_id, b.artifact_version_id,
      artifact.current_version_id = b.artifact_version_id AS is_current
    FROM block_source_refs ref
    JOIN artifact_blocks b ON b.id = ref.artifact_block_id
    JOIN artifact_versions av ON av.id = b.artifact_version_id
    JOIN artifacts artifact ON artifact.id = av.artifact_id
    WHERE ref.content_atom_id = ANY($1::text[])`, [atomIds]);
}

async function referencedAtomIdsMissingFromSnapshot(db, { sourceItemId, snapshotId }) {
  const rows = await db.query(`SELECT DISTINCT referenced_atom.id
    FROM block_source_refs ref
    JOIN content_atoms referenced_atom ON referenced_atom.id=ref.content_atom_id
    JOIN source_snapshots referenced_snapshot ON referenced_snapshot.id=referenced_atom.snapshot_id
    WHERE referenced_snapshot.source_item_id=$1
      AND NOT EXISTS (
        SELECT 1
        FROM content_atoms latest_atom
        WHERE latest_atom.snapshot_id=$2
          AND latest_atom.fingerprint=referenced_atom.fingerprint
      )
    ORDER BY referenced_atom.id`, [sourceItemId, snapshotId]);
  return rows.map((row) => row.id);
}

// Approval and export use this live fence while the asynchronous invalidation
// event is pending. The persisted block_source_refs relation remains the only
// artifact-to-source dependency used to calculate impact.
export async function currentVersionDriftFromRefs(db, { workspaceId, artifactId }) {
  return db.query(`SELECT DISTINCT block.id AS block_id, block.evidence_state, block.stale, block.held
    FROM artifacts artifact
    JOIN artifact_blocks block ON block.artifact_version_id=artifact.current_version_id
    JOIN block_source_refs ref ON ref.artifact_block_id=block.id
    JOIN content_atoms referenced_atom ON referenced_atom.id=ref.content_atom_id
    JOIN source_snapshots referenced_snapshot ON referenced_snapshot.id=referenced_atom.snapshot_id
    JOIN source_items item ON item.id=referenced_snapshot.source_item_id
    JOIN sources source ON source.id=item.source_id
    WHERE artifact.id=$1
      AND artifact.workspace_id=$2
      AND source.workspace_id=artifact.workspace_id
      AND item.latest_snapshot_id IS NOT NULL
      AND referenced_atom.snapshot_id<>item.latest_snapshot_id
      AND NOT EXISTS (
        SELECT 1
        FROM content_atoms latest_atom
        WHERE latest_atom.snapshot_id=item.latest_snapshot_id
          AND latest_atom.fingerprint=referenced_atom.fingerprint
      )
    ORDER BY block.id`, [artifactId, workspaceId]);
}

export async function applySourceUpdate(db, { sourceItemId, oldSnapshotId, newSnapshotId }) {
  return db.transaction(async (tx) => {
    // RSS persistence updates latest_snapshot_id while holding FOR UPDATE on
    // this row. A shared lock therefore gives this invalidation one immutable
    // view of the actual latest snapshot, while remaining compatible with the
    // source fences held by approval, export, verification, and generation.
    const sourceItem = (await tx.query(`SELECT item.id,item.latest_snapshot_id,
        source.workspace_id
      FROM source_items item
      JOIN sources source ON source.id=item.source_id
      WHERE item.id=$1
      FOR SHARE OF item`, [sourceItemId]))[0];
    const transition = sourceItem && (await tx.query(`SELECT item.id
      FROM source_items item
      JOIN source_snapshots old_snapshot ON old_snapshot.source_item_id=item.id
      JOIN source_snapshots new_snapshot ON new_snapshot.source_item_id=item.id
      WHERE item.id=$1 AND old_snapshot.id=$2 AND new_snapshot.id=$3`, [
      sourceItemId,
      oldSnapshotId,
      newSnapshotId
    ]))[0];
    if (!transition) throw issue('SOURCE_SNAPSHOT_TRANSITION_INVALID', '같은 원본 항목의 스냅샷 변경만 처리할 수 있습니다.', 409);
    if (!sourceItem.latest_snapshot_id) {
      throw issue('SOURCE_SNAPSHOT_TRANSITION_INVALID', '원본 항목의 최신 스냅샷을 확인할 수 없습니다.', 409);
    }

    // Events can be delayed or arrive out of order. Comparing only the event's
    // immediate old snapshot misses a v1 reference when v1→v2 preserves a
    // fingerprint and v2→v3 later changes it. Re-evaluate every historical atom
    // reached through block_source_refs against the locked item's actual latest
    // snapshot instead. This keeps block_source_refs as the sole persisted
    // artifact dependency and makes replayed events idempotently converge on
    // current source truth.
    const changedIds = await referencedAtomIdsMissingFromSnapshot(tx, {
      sourceItemId,
      snapshotId: sourceItem.latest_snapshot_id
    });
    if (!changedIds.length) {
      return {
        changedAtomIds: [],
        affectedBlockIds: []
      };
    }

    // First discover candidate artifacts solely through block_source_refs, then
    // lock them in deterministic order and repeat the dependency query. The
    // repeat is required: a concurrent immutable-version transition can change
    // which referencing version is current between discovery and locking.
    const candidates = await affectedBlocksFromRefs(tx, changedIds);
    const artifactIds = [...new Set(candidates.map((row) => row.artifact_id))].sort();
    if (artifactIds.length) {
      await tx.query(`SELECT id
        FROM artifacts
        WHERE id=ANY($1::text[])
        ORDER BY id
        FOR UPDATE`, [artifactIds]);
    }
    const affected = await affectedBlocksFromRefs(tx, changedIds);
    if (!affected.length) {
      return {
        changedAtomIds: changedIds,
        affectedBlockIds: []
      };
    }
    for (const block of affected) {
      await tx.query("UPDATE artifact_blocks SET stale = true, evidence_state = 'review_required' WHERE id = $1", [block.block_id]);
      await tx.query("UPDATE verifications SET invalidated_at = now(), invalidation_reason = '연결된 원본 내용이 변경됨' WHERE artifact_block_id = $1 AND invalidated_at IS NULL", [block.block_id]);
      if (block.is_current) {
        await tx.query("UPDATE artifacts SET state = 'stale', updated_at = now() WHERE id = $1", [block.artifact_id]);
      }
      await tx.query('UPDATE approvals SET revoked_at = now() WHERE artifact_version_id = $1 AND revoked_at IS NULL', [block.artifact_version_id]);
      await recordDomainEvent(tx, {
        workspaceId: sourceItem.workspace_id,
        eventType: 'block.staled',
        aggregateType: 'artifact_block',
        aggregateId: block.block_id,
        payload: {
          oldSnapshotId,
          newSnapshotId,
          latestSnapshotId: sourceItem.latest_snapshot_id
        }
      });
    }
    return {
      changedAtomIds: changedIds,
      affectedBlockIds: affected.map((row) => row.block_id)
    };
  });
}

export async function recordRefreshDecision(db, {
  workspaceId,
  userId,
  artifactId,
  decision,
  providerId = null,
  note = '',
  acknowledgedSourceSnapshotIds = []
}) {
  if (!['patch', 'regenerate', 'keep'].includes(decision)) throw issue('INVALID_REFRESH_DECISION', '부분 새로고침, 전체 재생성, 현재 결과 유지 중 하나를 선택하세요.');
  const acknowledgedSnapshots = (Array.isArray(acknowledgedSourceSnapshotIds)
    ? acknowledgedSourceSnapshotIds
    : []).map((value) => String(value || '').trim()).filter(Boolean);
  return db.transaction(async (tx) => {
    const artifact = (await tx.query(`SELECT a.*,
        (
          SELECT output.plan_id
          FROM plan_outputs output
          WHERE output.artifact_id=a.id
          ORDER BY output.created_at DESC
          LIMIT 1
        ) AS plan_id
      FROM artifacts a
      WHERE a.id=$1 AND a.workspace_id=$2
      FOR UPDATE`, [artifactId, workspaceId]))[0];
    if (!artifact) throw issue('ARTIFACT_NOT_FOUND', '결과물을 찾을 수 없습니다.', 404);
    const versionSources = await loadArtifactVersionSourceSnapshots(tx, artifact.current_version_id);
    const sourceLocks = await lockSourceItems(tx, versionSources.map((source) => source.source_item_id));
    if (!versionSources.length || sourceLocks.length !== versionSources.length) {
      throw issue('SOURCE_ITEM_NOT_FOUND', '결과물의 원본 항목을 찾을 수 없습니다.', 409);
    }

    const sourceDrift = await currentVersionDriftFromRefs(tx, { workspaceId, artifactId });
    const staleBlocks = await tx.query(`SELECT id
      FROM artifact_blocks
      WHERE artifact_version_id=$1 AND stale=true
      ORDER BY id`, [artifact.current_version_id]);
    const staleBlockIds = new Set(staleBlocks.map((block) => block.id));
    const pendingDrift = sourceDrift.filter((block) => !staleBlockIds.has(block.block_id));
    if (pendingDrift.length) {
      throw issue(
        'SOURCE_UPDATE_PENDING',
        '원본 변경 영향 처리가 끝난 뒤 현재 버전의 변경 영향 결정을 기록하세요.',
        409,
        { affectedBlockCount: pendingDrift.length }
      );
    }
    const affected = staleBlocks.length;
    if (!affected) throw issue('REFRESH_NOT_REQUIRED', '변경 영향을 받은 블록이 없어 새로고침 결정을 기록할 필요가 없습니다.', 409);
    if (decision !== 'keep' && !providerId) throw issue('REFRESH_PROVIDER_REQUIRED', '부분 새로고침 또는 전체 재생성에 사용할 Model Provider를 선택하세요.');
    const acknowledgement = String(note).trim().slice(0, 2_000);
    if (decision === 'keep' && !acknowledgement) throw issue('KEEP_ACKNOWLEDGEMENT_REQUIRED', '현재 결과를 유지하는 이유와 변경 영향을 확인했다는 메모를 입력하세요.', 409);
    const decisionId = id();
    await tx.query(`INSERT INTO refresh_decisions
      (id,artifact_id,base_version_id,decision,affected_block_count,acknowledged_by,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      decisionId,
      artifactId,
      artifact.current_version_id,
      decision,
      affected,
      userId,
      acknowledgement
    ]);
    let runId = null;
    if (decision !== 'keep') {
      if (!artifact.plan_id) throw issue('REFRESH_PLAN_REQUIRED', '새로고침할 원래 생성 계획을 찾을 수 없습니다.', 409);
      runId = id();
      await tx.query(`INSERT INTO runs
          (id,workspace_id,plan_id,run_type,status,created_by)
        VALUES ($1,$2,$3,$4,'queued',$5)`, [
        runId,
        workspaceId,
        artifact.plan_id,
        decision === 'patch' ? 'artifact_patch' : 'artifact_regeneration',
        userId
      ]);
      await freezeLatestRunSources(tx, {
        runId,
        artifactVersionId: artifact.current_version_id,
        acknowledgedSourceSnapshotIds: acknowledgedSnapshots
      });
    }
    if (decision === 'patch') await enqueue(tx, {
      workspaceId,
      eventType: 'patch_artifact',
      payload: {
        artifactId,
        baseVersionId: artifact.current_version_id,
        providerId,
        runId,
        acknowledgedSourceSnapshotIds: acknowledgedSnapshots,
        requestedBy: userId
      },
      dedupeKey: `patch:${artifactId}:${runId}`
    });
    if (decision === 'regenerate') await enqueue(tx, {
      workspaceId,
      eventType: 'regenerate_artifact',
      payload: {
        artifactId,
        baseVersionId: artifact.current_version_id,
        providerId,
        runId,
        acknowledgedSourceSnapshotIds: acknowledgedSnapshots,
        requestedBy: userId
      },
      dedupeKey: `full-regenerate:${artifactId}:${runId}`
    });
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: `artifact.refresh_${decision}`,
      entityType: 'artifact',
      entityId: artifactId,
      detail: { affected, baseVersionId: artifact.current_version_id }
    });
    return {
      decisionId,
      baseVersionId: artifact.current_version_id,
      affected,
      affectedBlockCount: affected,
      decision,
      runId,
      status: decision === 'keep' ? 'acknowledged' : 'queued',
      acknowledged: decision === 'keep'
    };
  });
}
