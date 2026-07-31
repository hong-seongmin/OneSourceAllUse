import { audit, enqueue, recordDomainEvent } from './audit.js';
import { issue } from './errors.js';
import { id, parseJson, stableKey } from './ids.js';
import { assessSourceReadiness } from './source-readiness.js';

export async function requestSourceReadinessReassessment(db, { workspaceId, sourceItemId, userId }) {
  return db.transaction(async (tx) => {
    const source = (await tx.query(`
      SELECT item.id, item.latest_snapshot_id, assessment.readiness
      FROM source_items item
      JOIN sources source ON source.id=item.source_id
      LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=item.latest_snapshot_id
      WHERE item.id=$1 AND source.workspace_id=$2 AND source.enabled=true
      FOR UPDATE OF item`, [sourceItemId, workspaceId]))[0];
    if (!source) throw issue('SOURCE_ITEM_NOT_FOUND', '재평가할 원본을 찾을 수 없습니다.', 404);
    if (!source.latest_snapshot_id) throw issue('SOURCE_REASSESSMENT_UNAVAILABLE', '재평가할 원본 스냅샷이 없습니다.', 409);
    if (source.readiness !== 'quarantined') {
      throw issue('SOURCE_REASSESSMENT_NOT_REQUIRED', '현재 원본은 보안 격리 상태가 아니어서 재평가할 필요가 없습니다.', 409);
    }
    const eventId = await enqueue(tx, {
      workspaceId,
      eventType: 'reassess_source_readiness',
      payload: { sourceItemId, snapshotId: source.latest_snapshot_id, requestedBy: userId },
      dedupeKey: stableKey(`readiness-reassessment:${sourceItemId}:${source.latest_snapshot_id}`)
    });
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: 'source.readiness_reassessment_requested',
      entityType: 'source_item',
      entityId: sourceItemId,
      detail: { snapshotId: source.latest_snapshot_id, eventId }
    });
    return { status: 'queued', eventId, snapshotId: source.latest_snapshot_id };
  });
}

export async function reassessSourceReadiness(db, { sourceItemId, snapshotId, requestedBy = null } = {}) {
  return db.transaction(async (tx) => {
    const source = (await tx.query(`
      SELECT item.id AS source_item_id, item.latest_snapshot_id,
        source.workspace_id, source.rights_status,
        snapshot.id AS snapshot_id, snapshot.body, snapshot.ingestion_meta,
        assessment.readiness AS previous_readiness,
        assessment.omissions AS previous_omissions,
        assessment.signals AS previous_signals
      FROM source_items item
      JOIN sources source ON source.id=item.source_id
      JOIN source_snapshots snapshot ON snapshot.id=item.latest_snapshot_id
      LEFT JOIN source_snapshot_assessments assessment ON assessment.snapshot_id=snapshot.id
      WHERE item.id=$1 AND ($2::text IS NULL OR snapshot.id=$2)
      FOR UPDATE OF item`, [sourceItemId, snapshotId || null]))[0];
    if (!source) throw issue('SOURCE_REASSESSMENT_UNAVAILABLE', '재평가할 최신 원본 스냅샷을 찾을 수 없습니다.', 409);

    const atoms = await tx.query(`
      SELECT atom.id, atom.text, atom.atom_type AS "atomType", segment.segment_type AS "segmentType"
      FROM content_atoms atom
      JOIN source_segments segment ON segment.id=atom.segment_id
      WHERE atom.snapshot_id=$1
      ORDER BY atom.position_label`, [source.snapshot_id]);
    const assessment = assessSourceReadiness({
      body: source.body,
      atoms,
      ingestionMeta: parseJson(source.ingestion_meta, {}),
      rightsStatus: source.rights_status
    });
    await tx.query(`UPDATE source_snapshot_assessments
      SET readiness=$2, rights_status=$3, usable_atom_ids=$4::jsonb, omissions=$5::jsonb,
        signals=$6::jsonb, acknowledgement_required=$7, detector_version=$8, assessed_at=now()
      WHERE snapshot_id=$1`, [
      source.snapshot_id,
      assessment.readiness,
      assessment.rightsStatus,
      JSON.stringify(assessment.usableAtomIds),
      JSON.stringify(assessment.omissions),
      JSON.stringify(assessment.signals),
      assessment.acknowledgementRequired,
      assessment.detectorVersion
    ]);
    await tx.query(`INSERT INTO source_snapshot_assessment_events
      (id, workspace_id, source_item_id, snapshot_id, previous_readiness, readiness,
       previous_omissions, omissions, previous_signals, signals, detector_version, trigger, requested_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,'manual_reassessment',$12)`, [
      id(),
      source.workspace_id,
      source.source_item_id,
      source.snapshot_id,
      source.previous_readiness || null,
      assessment.readiness,
      JSON.stringify(parseJson(source.previous_omissions, [])),
      JSON.stringify(assessment.omissions),
      JSON.stringify(parseJson(source.previous_signals, [])),
      JSON.stringify(assessment.signals),
      assessment.detectorVersion,
      requestedBy
    ]);
    await recordDomainEvent(tx, {
      workspaceId: source.workspace_id,
      actorId: requestedBy,
      eventType: 'source.readiness_reassessed',
      aggregateType: 'source_item',
      aggregateId: source.source_item_id,
      payload: {
        snapshotId: source.snapshot_id,
        previousReadiness: source.previous_readiness || null,
        readiness: assessment.readiness,
        detectorVersion: assessment.detectorVersion
      }
    });
    return {
      sourceItemId: source.source_item_id,
      snapshotId: source.snapshot_id,
      previousReadiness: source.previous_readiness || null,
      readiness: assessment.readiness,
      detectorVersion: assessment.detectorVersion
    };
  });
}
