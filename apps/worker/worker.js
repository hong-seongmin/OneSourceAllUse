import { cleanText, id, parseJson } from '../shared/ids.js';
import { syncRssSource } from '../shared/rss.js';
import { generatePlanOutput } from '../shared/generation.js';
import { applySourceUpdate, recordRefreshDecision } from '../shared/freshness.js';
import { issue } from '../shared/errors.js';
import { patchArtifact as applyArtifactPatch } from '../shared/patch.js';
import { ingestTranscript, ingestYouTubeMetadata } from '../shared/connectors.js';
import { freezeLatestRunSources } from '../shared/source-provenance.js';
import {
  analyzePlannerSuggestionBatch,
  finalizePlannerSuggestion,
  PLANNER_SUGGESTION_EVENTS,
  preparePlannerSuggestion
} from '../shared/planner-suggestions.js';

export async function claimNextEvent(db) {
  return db.transaction(async (tx) => {
    const row = (await tx.query(`WITH candidate AS (
      SELECT id FROM outbox_events
      WHERE (status = 'pending' AND available_at <= now())
         OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE outbox_events outbox SET status='processing', attempts=attempts+1, locked_at=now()
    FROM candidate WHERE outbox.id=candidate.id
    RETURNING outbox.*`))[0];
    return row ? { ...row, payload: parseJson(row.payload) } : null;
  });
}

export async function completeEvent(db, eventId) {
  await db.query("UPDATE outbox_events SET status='succeeded', completed_at=now(), last_error=NULL WHERE id=$1", [eventId]);
}

export async function failEvent(db, eventId, error) {
  const current = (await db.query('SELECT attempts FROM outbox_events WHERE id=$1', [eventId]))[0];
  const attempts = current?.attempts || 1;
  const explicitlyRetryable = error?.meta?.retryable === true;
  const retryableCode = [
    'RSS_FETCH_FAILED',
    'YOUTUBE_METADATA_FETCH_FAILED',
    'REMOTE_TIMEOUT',
    'MODEL_RESPONSE_INCOMPLETE'
  ].includes(error?.code);
  const retry = attempts < 5 && (explicitlyRetryable || retryableCode || !error?.code);
  const delaySeconds = Math.min(900, 2 ** attempts * 5);
  await db.query(`UPDATE outbox_events
    SET status=$2, last_error=$3, available_at=CASE WHEN $2='pending' THEN now() + ($4 || ' seconds')::interval ELSE available_at END,
      locked_at=NULL,completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END
    WHERE id=$1`, [eventId, retry ? 'pending' : 'failed', cleanText(error.message, 1_000), String(delaySeconds)]);
  return { retry, attempts, delaySeconds };
}

async function regenerateArtifact(db, payload, config) {
  const artifact = (await db.query(`SELECT a.id,a.current_version_id,
      po.id AS plan_output_id,p.id AS plan_id,p.source_item_id,p.workspace_id
    FROM artifacts a JOIN plan_outputs po ON po.artifact_id=a.id JOIN plans p ON p.id=po.plan_id WHERE a.id=$1`, [payload.artifactId]))[0];
  if (!artifact) throw issue('REGENERATION_UNAVAILABLE', '재생성할 계획 연결을 찾을 수 없습니다.');
  if (!payload.baseVersionId || artifact.current_version_id !== payload.baseVersionId) {
    throw issue(
      'REGENERATION_BASE_VERSION_CHANGED',
      '재생성 요청 뒤 더 최신 결과물 버전이 저장되었습니다. 최신 버전에서 재생성을 다시 요청하세요.',
      409,
      {
        retryable: false,
        expectedBaseVersionId: payload.baseVersionId || null
      }
    );
  }
  let runId = payload.runId;
  if (!runId) {
    runId = id();
    await db.query("INSERT INTO runs (id, workspace_id, plan_id, run_type, status) VALUES ($1,$2,$3,'artifact_regeneration','queued')", [runId, artifact.workspace_id, artifact.plan_id]);
  }
  await db.transaction(async (tx) => {
    const currentArtifact = (await tx.query(`SELECT current_version_id
      FROM artifacts
      WHERE id=$1
      FOR UPDATE`, [artifact.id]))[0];
    if (!currentArtifact || currentArtifact.current_version_id !== payload.baseVersionId) {
      throw issue(
        'REGENERATION_BASE_VERSION_CHANGED',
        '재생성 요청 뒤 더 최신 결과물 버전이 저장되었습니다. 최신 버전에서 재생성을 다시 요청하세요.',
        409,
        { retryable: false, expectedBaseVersionId: payload.baseVersionId }
      );
    }
    await freezeLatestRunSources(tx, {
      runId,
      artifactVersionId: payload.baseVersionId,
      acknowledgedSourceSnapshotIds: Array.isArray(payload.acknowledgedSourceSnapshotIds)
        ? payload.acknowledgedSourceSnapshotIds
        : []
    });
  });
  await generatePlanOutput(db, {
    planOutputId: artifact.plan_output_id,
    providerId: payload.providerId,
    evaluatorProviderId: payload.evaluatorProviderId || null,
    baseVersionId: payload.baseVersionId,
    runId
  }, config);
}

async function patchArtifact(db, payload, config) {
  return applyArtifactPatch(db, payload, config);
}

export async function processEvent(db, event, config) {
  switch (event.event_type) {
    case 'sync_rss': return syncRssSource(db, event.payload.sourceId, config);
    case 'ingest_transcript': return ingestTranscript(db, event.payload);
    case 'ingest_youtube_metadata': return ingestYouTubeMetadata(db, event.payload, config);
    case 'apply_source_update': return applySourceUpdate(db, event.payload);
    case PLANNER_SUGGESTION_EVENTS.prepare:
      return preparePlannerSuggestion(db, event.payload, config);
    case PLANNER_SUGGESTION_EVENTS.analyzeBatch:
      return analyzePlannerSuggestionBatch(db, event.payload, config);
    case PLANNER_SUGGESTION_EVENTS.finalize:
      return finalizePlannerSuggestion(db, event.payload, config);
    case 'generate_plan_output': return generatePlanOutput(db, event.payload, config);
    case 'regenerate_artifact': return regenerateArtifact(db, event.payload, config);
    case 'patch_artifact': return patchArtifact(db, event.payload, config);
    default: throw issue('UNKNOWN_JOB', `지원하지 않는 비동기 작업입니다: ${event.event_type}`, 500);
  }
}

export async function processNextEvent(db, config) {
  const event = await claimNextEvent(db);
  if (!event) return null;
  try {
    const result = await processEvent(db, event, config);
    await completeEvent(db, event.id);
    return { id: event.id, eventType: event.event_type, result };
  } catch (error) {
    const failure = await failEvent(db, event.id, error);
    const runId = event.payload?.runId;
    if (runId) {
      const errorMessage = cleanText(error?.message || '비동기 작업이 실패했습니다.', 1_000);
      const errorCode = cleanText(error?.code || 'INTERNAL_ERROR', 200);
      await db.transaction(async (tx) => {
        if (failure.retry) {
          await tx.query("UPDATE runs SET status='retrying',error_message=$2,completed_at=NULL WHERE id=$1", [
            runId,
            errorMessage
          ]);
          await tx.query(`UPDATE planner_suggestion_runs
            SET error_code=$2,completed_at=NULL,updated_at=now()
            WHERE run_id=$1`, [runId, errorCode]);
          if (event.payload?.planOutputId) {
            await tx.query("UPDATE plan_outputs SET status='queued' WHERE id=$1", [event.payload.planOutputId]);
          }
          return;
        }
        await tx.query(`UPDATE runs
          SET status='failed',error_message=$2,completed_at=now()
          WHERE id=$1`, [runId, errorMessage]);
        await tx.query(`UPDATE planner_suggestion_runs
          SET error_code=$2,completed_at=now(),updated_at=now()
          WHERE run_id=$1`, [runId, errorCode]);
        await tx.query(`UPDATE run_steps
          SET status='failed',detail=$2,completed_at=now()
          WHERE run_id=$1 AND status='running'`, [
          runId,
          cleanText(`${errorCode}: ${errorMessage}`, 2_000)
        ]);
        await tx.query(`UPDATE generation_executions
          SET status='failed',error_code=$2,error_message=$3,
              completed_at=now(),updated_at=now()
          WHERE run_id=$1 AND status='running'`, [
          runId,
          errorCode,
          errorMessage
        ]);
        if (event.payload?.planOutputId) {
          await tx.query(`UPDATE plan_outputs
            SET status='failed',quality_status='failed',error_message=$2
            WHERE id=$1 AND status IN ('queued','running')`, [
            event.payload.planOutputId,
            errorMessage
          ]);
        }
      });
    }
    return { id: event.id, eventType: event.event_type, error, retry: failure.retry };
  }
}
