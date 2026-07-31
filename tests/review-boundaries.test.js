import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { id } from '../apps/shared/ids.js';
import {
  addArtifactComment,
  approveArtifact,
  approvalBlockers,
  editArtifactBlock,
  getArtifactReview,
  requestRegeneration,
  resolveArtifactComment,
  setBlockConflict,
  setBlockHold,
  verifyBlock
} from '../apps/shared/review.js';
import {
  affectedBlocksFromRefs,
  applySourceUpdate,
  changedAtomIds,
  currentVersionDriftFromRefs,
  recordRefreshDecision
} from '../apps/shared/freshness.js';
import { exportMarkdown } from '../apps/shared/export.js';
import { processNextEvent } from '../apps/worker/worker.js';

async function migrateThrough(db, lastFile) {
  const directory = join(process.cwd(), 'migrations');
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql') && file <= lastFile)
    .sort();
  await db.transaction(async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    for (const file of files) {
      const sql = await readFile(join(directory, file), 'utf8');
      const statements = sql.split(/;\s*(?:\r?\n|$)/u)
        .map((part) => part.trim())
        .filter(Boolean);
      for (const statement of statements) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    }
  });
}

async function fixture(t, { readiness = 'complete', acknowledged = false } = {}) {
  const pglite = new PGlite();
  const db = createPgliteDatabase(pglite);
  t.after(() => db.close());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: `${id()}@example.com`,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  const sourceId = id();
  const sourceItemId = id();
  const snapshotId = id();
  const segmentId = id();
  const atomIds = [id(), id()];
  const providerId = id();
  const planId = id();
  const runId = id();
  const outputId = id();
  const artifactId = id();
  const versionId = id();
  const blockIds = [id(), id(), id()];
  const executionId = id();

  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO sources
      (id, workspace_id, name, connector_type, feed_url, rights_status, created_by)
      VALUES ($1,$2,'검토 경계 원본','rss','https://example.com/feed.xml','owned',$3)`, [sourceId, workspaceId, user.id]);
    await tx.query(`INSERT INTO source_items
      (id, source_id, external_key, title)
      VALUES ($1,$2,'review-boundary','검토 경계')`, [sourceItemId, sourceId]);
    await tx.query(`INSERT INTO source_snapshots
      (id, source_item_id, version_no, content_hash, title, body)
      VALUES ($1,$2,1,'snapshot-one','검토 경계','가격은 100원입니다. 배송은 내일입니다.')`, [snapshotId, sourceItemId]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [sourceItemId, snapshotId]);
    await tx.query(`INSERT INTO source_segments
      (id, snapshot_id, position_label, ordinal, segment_type, text)
      VALUES ($1,$2,'본문 1',1,'paragraph','가격은 100원입니다. 배송은 내일입니다.')`, [segmentId, snapshotId]);
    await tx.query(`INSERT INTO content_atoms
      (id, snapshot_id, segment_id, position_label, atom_type, text, fingerprint)
      VALUES
      ($1,$3,$4,'본문 1 · 문장 1','number','가격은 100원입니다.','price-v1'),
      ($2,$3,$4,'본문 1 · 문장 2','claim','배송은 내일입니다.','delivery-stable')`, [
      atomIds[0], atomIds[1], snapshotId, segmentId
    ]);
    await tx.query(`INSERT INTO source_snapshot_assessments
      (snapshot_id, readiness, rights_status, usable_atom_ids, omissions, signals, acknowledgement_required)
      VALUES ($1,$2,'owned',$3::jsonb,$4::jsonb,'[]'::jsonb,$5)`, [
      snapshotId,
      readiness,
      JSON.stringify(atomIds),
      JSON.stringify(readiness === 'partial' ? ['본문 일부가 누락됨'] : []),
      readiness === 'partial'
    ]);
    await tx.query(`INSERT INTO model_provider_configs
      (id, workspace_id, name, provider_type, base_url, model, secret_ciphertext, enabled, created_by)
      VALUES ($1,$2,'검토 경계 Provider','openai_compatible','https://example.com/v1','boundary-model','test-ciphertext',true,$3)`, [
      providerId, workspaceId, user.id
    ]);
    await tx.query(`INSERT INTO plans
      (id, workspace_id, source_item_id, snapshot_id, language, common_cta, created_by,
       source_readiness_acknowledged, source_readiness_acknowledged_at)
      VALUES ($1,$2,$3,$4,'ko','',$5,$6,CASE WHEN $6 THEN now() ELSE NULL END)`, [
      planId, workspaceId, sourceItemId, snapshotId, user.id, acknowledged
    ]);
    await tx.query(`INSERT INTO plan_source_snapshots
      (plan_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
       readiness_acknowledged,readiness_acknowledged_at)
      VALUES ($1,$2,$3,'source_1',1,true,$4,
       CASE WHEN $4 THEN now() ELSE NULL END)`, [
      planId, sourceItemId, snapshotId, acknowledged
    ]);
    await tx.query(`INSERT INTO runs
      (id, workspace_id, plan_id, run_type, status, created_by, started_at, completed_at)
      VALUES ($1,$2,$3,'artifact_generation','succeeded',$4,now(),now())`, [
      runId, workspaceId, planId, user.id
    ]);
    await tx.query(`INSERT INTO plan_outputs
      (id, plan_id, output_type, channel_definition_version_id, selected, settings, status, quality_status)
      VALUES ($1,$2,'naver_blog','naver_blog:v1',true,'{}'::jsonb,'succeeded','passed')`, [
      outputId, planId
    ]);
    await tx.query(`INSERT INTO artifacts
      (id, workspace_id, source_item_id, channel, state, created_by)
      VALUES ($1,$2,$3,'naver_blog','review_required',$4)`, [
      artifactId, workspaceId, sourceItemId, user.id
    ]);
    await tx.query(`INSERT INTO artifact_versions
      (id, artifact_id, version_no, source_snapshot_id, content, created_by_run_id,
       channel_definition_version_id, prompt_bundle_version, evaluator_version)
      VALUES ($1,$2,1,$3,
       '{"type":"naver_article","title":"검토 경계","intro":"가격은 100원입니다.","sections":[{"heading":"배송","body":"배송은 내일입니다."}],"cta":"원본을 확인하세요.","tags":[]}'::jsonb,
       $4,'naver_blog:v1','prompt.v1','evaluator.v1')`, [
      versionId, artifactId, snapshotId, runId
    ]);
    await tx.query(`INSERT INTO artifact_version_source_snapshots
      (artifact_version_id,source_item_id,snapshot_id,source_key,ordinal,is_primary,
       readiness_acknowledged,readiness_acknowledged_at)
      VALUES ($1,$2,$3,'source_1',1,true,$4,
       CASE WHEN $4 THEN now() ELSE NULL END)`, [
      versionId, sourceItemId, snapshotId, acknowledged
    ]);
    await tx.query('UPDATE artifacts SET current_version_id=$2 WHERE id=$1', [artifactId, versionId]);
    await tx.query('UPDATE plan_outputs SET artifact_id=$2 WHERE id=$1', [outputId, artifactId]);
    await tx.query(`INSERT INTO artifact_blocks
      (id, artifact_version_id, block_key, block_type, ordinal, content, evidence_state,
      auto_check, surface_path, content_kind, content_hash)
      VALUES
      ($1,$4,'fact-one','paragraph',1,'가격은 100원입니다.','review_required','{"supported":true}'::jsonb,'$.intro','factual','hash-one'),
      ($2,$4,'fact-two','paragraph',2,'배송은 내일입니다.','review_required','{"supported":true}'::jsonb,'$.sections[0].body','factual','hash-two'),
      ($3,$4,'cta','cta',3,'원본을 확인하세요.','not_required','{"supported":true}'::jsonb,'$.cta','editorial','hash-cta')`, [
      blockIds[0], blockIds[1], blockIds[2], versionId
    ]);
    await tx.query(`INSERT INTO block_source_refs (artifact_block_id, content_atom_id)
      VALUES ($1,$3),($2,$4)`, [blockIds[0], blockIds[1], atomIds[0], atomIds[1]]);
    await tx.query(`INSERT INTO generation_executions
      (id, run_id, plan_output_id, source_snapshot_id, channel_definition_version_id,
       generator_provider_id, evaluator_provider_id, generator_model, evaluator_model,
       pipeline_version, prompt_bundle_version, evaluator_version, evaluator_assurance,
       status, stage, readiness_state, artifact_version_id, completed_at)
      VALUES ($1,$2,$3,$4,'naver_blog:v2',$5,$5,'boundary-model','boundary-model',
       'pipeline.v1','prompt.v1','evaluator.v1','HIGH_ASSURANCE',
       'succeeded','artifact_finalize',$6,$7,now())`, [
      executionId, runId, outputId, snapshotId, providerId, readiness, versionId
    ]);
  });

  return {
    db,
    workspaceId,
    userId: user.id,
    sourceId,
    sourceItemId,
    snapshotId,
    segmentId,
    atomIds,
    providerId,
    planId,
    runId,
    outputId,
    artifactId,
    versionId,
    blockIds,
    executionId
  };
}

test('refresh decision migration backfills the artifact version current at acknowledgement time', async (t) => {
  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrateThrough(db, '007_extensible_platform_channels.sql');
  const user = await bootstrapAdministrator(db, {
    email: `${id()}@example.com`,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query(
    'SELECT workspace_id FROM users WHERE id=$1',
    [user.id]
  ))[0].workspace_id;
  const sourceId = id();
  const sourceItemId = id();
  const snapshotId = id();
  const artifactId = id();
  const firstVersionId = id();
  const secondVersionId = id();
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,rights_status,created_by)
      VALUES ($1,$2,'migration source','rss','https://example.com/feed.xml','owned',$3)`, [
      sourceId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO source_items
      (id,source_id,external_key,title)
      VALUES ($1,$2,'migration-entry','migration entry')`, [
      sourceItemId,
      sourceId
    ]);
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,1,'migration-snapshot','migration entry','body')`, [
      snapshotId,
      sourceItemId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      sourceItemId,
      snapshotId
    ]);
    await tx.query(`INSERT INTO artifacts
      (id,workspace_id,source_item_id,channel,state,created_by)
      VALUES ($1,$2,$3,'naver_blog','stale',$4)`, [
      artifactId,
      workspaceId,
      sourceItemId,
      user.id
    ]);
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,
       channel_definition_version_id,prompt_bundle_version,evaluator_version,created_at)
      VALUES
      ($1,$3,1,$4,'{}'::jsonb,'naver_blog:v2','prompt.v1','evaluator.v1','2026-01-01T00:00:00Z'),
      ($2,$3,2,$4,'{}'::jsonb,'naver_blog:v2','prompt.v1','evaluator.v1','2026-01-03T00:00:00Z')`, [
      firstVersionId,
      secondVersionId,
      artifactId,
      snapshotId
    ]);
    await tx.query('UPDATE artifacts SET current_version_id=$2 WHERE id=$1', [
      artifactId,
      secondVersionId
    ]);
    await tx.query(`INSERT INTO refresh_decisions
      (id,artifact_id,decision,affected_block_count,acknowledged_by,acknowledged_at,note)
      VALUES ($1,$2,'keep',1,$3,'2026-01-02T00:00:00Z','legacy decision')`, [
      id(),
      artifactId,
      user.id
    ]);
  });

  await migrate(db, process.cwd());
  const decision = (await db.query(`SELECT base_version_id
    FROM refresh_decisions WHERE artifact_id=$1`, [artifactId]))[0];
  assert.equal(decision.base_version_id, firstVersionId);
  await assert.rejects(
    db.query(`INSERT INTO refresh_decisions
      (id,artifact_id,decision,affected_block_count,acknowledged_by,note)
      VALUES ($1,$2,'keep',1,$3,'missing base version')`, [
      id(),
      artifactId,
      user.id
    ])
  );
});

async function addFinding(db, fx, { severity = 'fail', status = 'open', code = 'GROUNDING_FAILED' } = {}) {
  const attemptId = id();
  const evaluationId = id();
  const findingId = id();
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO generation_attempts
      (id, execution_id, attempt_no, attempt_kind, provider_model, provider_capability,
       request_hash, status, completed_at)
      VALUES ($1,$2,1,'draft','boundary-model','json_object','request-hash','accepted',now())`, [
      attemptId, fx.executionId
    ]);
    await tx.query(`INSERT INTO quality_evaluation_runs
      (id, execution_id, generation_attempt_id, evaluator_provider_id, evaluator_model,
       evaluator_version, rubric_version, assurance, status, completed_at)
      VALUES ($1,$2,$3,$4,'boundary-model','evaluator.v1','rubric.v1','HIGH_ASSURANCE','failed',now())`, [
      evaluationId, fx.executionId, attemptId, fx.providerId
    ]);
    await tx.query(`INSERT INTO quality_findings
      (id, evaluation_run_id, artifact_block_id, block_key, surface_path, code, dimension,
       severity, status, message, recovery, details)
      VALUES ($1,$2,$3,'fact-one','sections.0',$4,'grounding',$5,$6,
       '자동 검사에서 근거 불일치','원본과 블록을 다시 비교','{"automatic":true}'::jsonb)`, [
      findingId, evaluationId, fx.blockIds[0], code, severity, status
    ]);
  });
  return findingId;
}

async function verifyAllFactual(fx) {
  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    note: '가격 문장을 직접 비교함'
  });
  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[1],
    note: '배송 문장을 직접 비교함'
  });
}

test('one verified factual block is insufficient, while every factual block verified against the current snapshot can be approved', async (t) => {
  const fx = await fixture(t);
  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    note: '가격 문장을 직접 비교함'
  });
  await assert.rejects(
    approveArtifact(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    (error) => error.code === 'HUMAN_VERIFICATION_REQUIRED'
  );
  assert.deepEqual(
    (await approvalBlockers(fx.db, { workspaceId: fx.workspaceId, artifactId: fx.artifactId }))
      .map((blocker) => blocker.code),
    ['HUMAN_VERIFICATION_REQUIRED']
  );

  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[1],
    note: '배송 문장을 직접 비교함'
  });
  await approveArtifact(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    note: '모든 사실 블록을 확인함'
  });
  assert.equal((await fx.db.query('SELECT state FROM artifacts WHERE id=$1', [fx.artifactId]))[0].state, 'approved');
});

test('human verification matches the exact current atom set rather than a snapshot-level flag', async (t) => {
  const fx = await fixture(t);
  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    note: '가격 atom 한 개를 직접 확인함'
  });
  const initiallyVerifiedReview = await getArtifactReview(
    fx.db,
    fx.workspaceId,
    fx.artifactId
  );
  assert.equal(initiallyVerifiedReview.blocks.find((block) => block.id === fx.blockIds[0]).human_verified, true);
  assert.deepEqual(initiallyVerifiedReview.humanVerification.progress, {
    total: 2,
    completed: 1,
    pending: 1
  });
  assert.deepEqual(initiallyVerifiedReview.humanVerification.pending.map((block) => ({
    blockId: block.blockId,
    ordinal: block.ordinal,
    state: block.state,
    sourceRefCount: block.sourceRefCount
  })), [{
    blockId: fx.blockIds[1],
    ordinal: 2,
    state: 'ready',
    sourceRefCount: 1
  }]);

  await fx.db.query(`INSERT INTO block_source_refs
    (artifact_block_id,content_atom_id)
    VALUES ($1,$2)`, [fx.blockIds[0], fx.atomIds[1]]);
  const changedReview = await getArtifactReview(fx.db, fx.workspaceId, fx.artifactId);
  assert.equal(
    changedReview.blocks.find((block) => block.id === fx.blockIds[0]).human_verified,
    false
  );
  assert.deepEqual(changedReview.humanVerification.progress, {
    total: 2,
    completed: 0,
    pending: 2
  });
  assert.equal(
    changedReview.humanVerification.pending.find((block) => block.blockId === fx.blockIds[0]).sourceRefCount,
    2
  );
  assert.ok((await approvalBlockers(fx.db, {
    workspaceId: fx.workspaceId,
    artifactId: fx.artifactId
  })).some((blocker) =>
    blocker.type === 'human_verification'
      && blocker.blocks.some((block) => block.blockId === fx.blockIds[0])));

  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    note: '가격과 배송 atom 둘을 다시 직접 확인함'
  });
  const currentVerification = (await fx.db.query(`SELECT verification.id
    FROM verifications verification
    WHERE verification.artifact_block_id=$1
      AND verification.invalidated_at IS NULL`, [fx.blockIds[0]]))[0];
  assert.equal(Number((await fx.db.query(`SELECT count(*)::int AS count
    FROM verification_source_refs WHERE verification_id=$1`, [
    currentVerification.id
  ]))[0].count), 2);
});

test('an open automatic failure blocks approval and remains separate from human verification in the review read model', async (t) => {
  const fx = await fixture(t);
  await verifyAllFactual(fx);
  const findingId = await addFinding(fx.db, fx);
  await fx.db.query(`INSERT INTO artifact_comments
    (id, artifact_version_id, artifact_block_id, author_id, body)
    VALUES ($1,$2,$3,$4,'자동 검사와 별도로 사람이 확인함')`, [
    id(), fx.versionId, fx.blockIds[0], fx.userId
  ]);

  await assert.rejects(
    approveArtifact(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    (error) => error.code === 'APPROVAL_AUTOMATED_FAILURE_UNRESOLVED'
  );
  const review = await getArtifactReview(fx.db, fx.workspaceId, fx.artifactId);
  assert.equal(review.automaticFindings.length, 1);
  assert.equal(review.automaticFindings[0].details.automatic, true);
  assert.equal(review.humanVerification.current.length, 2);
  assert.equal(review.humanVerification.history.length, 2);
  assert.equal(review.approval.blockers[0].code, 'APPROVAL_AUTOMATED_FAILURE_UNRESOLVED');
  assert.equal(review.profile.channel.name, 'Naver Blog Draft');
  assert.equal(review.run.execution.pipelineVersion, 'pipeline.v1');
  assert.equal(review.versions[0].label, '버전 1');
  assert.equal(review.comments.length, 1);
  assert.ok(review.blocks.every((block) => Array.isArray(block.sourceRefs)));
  assert.doesNotMatch(review.artifact.label, new RegExp(fx.artifactId));

  await fx.db.query("UPDATE quality_findings SET status='resolved', resolved_at=now() WHERE id=$1", [findingId]);
  await approveArtifact(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId
  });
  await fx.db.query(`INSERT INTO exports
    (id, artifact_version_id, target, idempotency_key, status, created_by)
    VALUES ($1,$2,'markdown',$3,'succeeded',$4)`, [id(), fx.versionId, id(), fx.userId]);
  const approvedReview = await getArtifactReview(fx.db, fx.workspaceId, fx.artifactId);
  assert.equal(approvedReview.approval.active.version_no, 1);
  assert.equal(approvedReview.exports[0].target, 'markdown');
});

test('partial source readiness requires acknowledgement on the originating plan', async (t) => {
  const fx = await fixture(t, { readiness: 'partial', acknowledged: false });
  await verifyAllFactual(fx);
  await assert.rejects(
    approveArtifact(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    (error) => error.code === 'APPROVAL_BLOCKED'
      && error.meta.blockers.some((blocker) => blocker.type === 'partial_source_acknowledgement')
  );
  await fx.db.query(`UPDATE plans
    SET source_readiness_acknowledged=true, source_readiness_acknowledged_at=now()
    WHERE id=$1`, [fx.planId]);
  await fx.db.query(`UPDATE plan_source_snapshots
    SET readiness_acknowledged=true, readiness_acknowledged_at=now()
    WHERE plan_id=$1`, [fx.planId]);
  await fx.db.query(`UPDATE artifact_version_source_snapshots
    SET readiness_acknowledged=true, readiness_acknowledged_at=now()
    WHERE artifact_version_id=$1`, [fx.versionId]);
  await approveArtifact(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId
  });
});

test('recording a conflict invalidates human verification, audits the transition, and requires a new verification after clearing', async (t) => {
  const fx = await fixture(t);
  await verifyAllFactual(fx);
  await setBlockConflict(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    conflict: true,
    note: '원본 가격과 블록 가격이 다름'
  });
  const verification = (await fx.db.query(
    'SELECT invalidated_at, invalidation_reason FROM verifications WHERE artifact_block_id=$1',
    [fx.blockIds[0]]
  ))[0];
  assert.ok(verification.invalidated_at);
  assert.match(verification.invalidation_reason, /원본 가격/);
  await assert.rejects(
    approveArtifact(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    (error) => error.code === 'APPROVAL_BLOCKED'
  );
  await setBlockConflict(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    conflict: false,
    note: '블록 내용을 원본과 일치시킴'
  });
  await assert.rejects(
    approveArtifact(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    (error) => error.code === 'HUMAN_VERIFICATION_REQUIRED'
  );
  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    note: '수정 후 원본 가격 문장을 다시 비교함'
  });
  await approveArtifact(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId
  });
  assert.deepEqual(
    (await fx.db.query(`SELECT action FROM audit_events
      WHERE entity_id=$1 AND action LIKE 'block.conflict_%' ORDER BY created_at`, [fx.blockIds[0]]))
      .map((row) => row.action),
    ['block.conflict_recorded', 'block.conflict_cleared']
  );
});

test('verification rejects source refs outside the artifact version snapshot', async (t) => {
  const fx = await fixture(t);
  const foreignSnapshotId = id();
  const foreignSegmentId = id();
  const foreignAtomId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id, source_item_id, version_no, content_hash, title, body)
      VALUES ($1,$2,2,'snapshot-two','검토 경계','가격은 120원입니다.')`, [
      foreignSnapshotId, fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id, snapshot_id, position_label, ordinal, segment_type, text)
      VALUES ($1,$2,'본문 1',1,'paragraph','가격은 120원입니다.')`, [
      foreignSegmentId, foreignSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id, snapshot_id, segment_id, position_label, atom_type, text, fingerprint)
      VALUES ($1,$2,$3,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v2')`, [
      foreignAtomId, foreignSnapshotId, foreignSegmentId
    ]);
    await tx.query('INSERT INTO block_source_refs (artifact_block_id, content_atom_id) VALUES ($1,$2)', [
      fx.blockIds[0], foreignAtomId
    ]);
  });
  await assert.rejects(
    verifyBlock(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      blockId: fx.blockIds[0],
      note: '잘못된 스냅샷 연결'
    }),
    (error) => error.code === 'VERIFICATION_SOURCE_MISMATCH'
  );
});

test('verification is blocked for stale, held, conflict, and live source-drift states', async (t) => {
  const fx = await fixture(t);
  const verify = () => verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    note: '안전하지 않은 상태에서는 기록되면 안 됨'
  });

  await fx.db.query('UPDATE artifact_blocks SET stale=true WHERE id=$1', [fx.blockIds[0]]);
  await assert.rejects(verify, { code: 'VERIFICATION_BLOCKED' });
  await fx.db.query('UPDATE artifact_blocks SET stale=false WHERE id=$1', [fx.blockIds[0]]);

  await setBlockHold(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    held: true
  });
  await assert.rejects(verify, { code: 'VERIFICATION_BLOCKED' });
  await setBlockHold(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    held: false
  });

  await setBlockConflict(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    conflict: true,
    note: '원본과 불일치'
  });
  await assert.rejects(verify, { code: 'VERIFICATION_BLOCKED' });
  await setBlockConflict(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    conflict: false,
    note: '불일치 해제'
  });

  const nextSnapshotId = id();
  const nextSegmentId = id();
  const nextAtomIds = [id(), id()];
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,2,'verification-pending-source','검토 경계',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSnapshotId,
      fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES ($1,$2,'본문 1',1,'paragraph',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSegmentId,
      nextSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES
      ($1,$3,$4,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v2'),
      ($2,$3,$4,'본문 1 · 문장 2','claim','배송은 내일입니다.','delivery-stable')`, [
      nextAtomIds[0],
      nextAtomIds[1],
      nextSnapshotId,
      nextSegmentId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      fx.sourceItemId,
      nextSnapshotId
    ]);
  });

  await assert.rejects(verify, { code: 'SOURCE_UPDATE_PENDING' });
  assert.equal(
    (await fx.db.query('SELECT count(*)::int AS count FROM verifications WHERE artifact_block_id=$1', [
      fx.blockIds[0]
    ]))[0].count,
    0
  );
  const review = await getArtifactReview(fx.db, fx.workspaceId, fx.artifactId);
  assert.equal(
    review.blocks.find((block) => block.id === fx.blockIds[0]).source_drift_pending,
    true
  );
  assert.equal(
    review.humanVerification.current.some((verification) => verification.artifact_block_id === fx.blockIds[0]),
    false
  );
});

test('export revalidates current blockers and artifact state even if an active approval row survives', async (t) => {
  const fx = await fixture(t);
  await verifyAllFactual(fx);
  await approveArtifact(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    note: '내보내기 경계 검증'
  });

  await fx.db.query("UPDATE artifacts SET state='review_required' WHERE id=$1", [fx.artifactId]);
  await assert.rejects(
    exportMarkdown(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    { code: 'APPROVAL_REQUIRED' }
  );

  await fx.db.transaction(async (tx) => {
    await tx.query("UPDATE artifacts SET state='held' WHERE id=$1", [fx.artifactId]);
    await tx.query('UPDATE artifact_blocks SET held=true WHERE id=$1', [fx.blockIds[0]]);
  });
  await assert.rejects(
    exportMarkdown(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    { code: 'APPROVAL_BLOCKED' }
  );
  assert.equal(
    (await fx.db.query('SELECT count(*)::int AS count FROM exports WHERE artifact_version_id=$1', [
      fx.versionId
    ]))[0].count,
    0
  );
});

test('keep requires an explicit note, persists acknowledgement, and does not clear or disguise stale state', async (t) => {
  const fx = await fixture(t);
  await fx.db.query("UPDATE artifact_blocks SET stale=true WHERE id=$1", [fx.blockIds[0]]);
  await fx.db.query("UPDATE artifacts SET state='stale' WHERE id=$1", [fx.artifactId]);
  await assert.rejects(
    recordRefreshDecision(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId,
      decision: 'keep',
      note: '   '
    }),
    (error) => error.code === 'KEEP_ACKNOWLEDGEMENT_REQUIRED'
  );
  const result = await recordRefreshDecision(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    decision: 'keep',
    note: '변경된 가격을 인지했으며 기존 문구를 유지함'
  });
  assert.equal(result.affected, 1);
  assert.equal(result.affectedBlockCount, 1);
  assert.equal(result.decision, 'keep');
  assert.equal(result.acknowledged, true);
  assert.equal(result.status, 'acknowledged');
  assert.equal(result.runId, null);
  assert.ok(result.decisionId);
  assert.equal((await fx.db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [fx.blockIds[0]]))[0].stale, true);
  assert.equal((await fx.db.query('SELECT state FROM artifacts WHERE id=$1', [fx.artifactId]))[0].state, 'stale');
  const persistedDecision = (await fx.db.query(`SELECT note,base_version_id,affected_block_count
    FROM refresh_decisions WHERE artifact_id=$1`, [fx.artifactId]))[0];
  assert.equal(persistedDecision.note, '변경된 가격을 인지했으며 기존 문구를 유지함');
  assert.equal(persistedDecision.base_version_id, fx.versionId);
  assert.equal(persistedDecision.affected_block_count, 1);

  await recordRefreshDecision(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    decision: 'patch',
    providerId: fx.providerId,
    confirmHumanVerificationReset: true
  });
  await recordRefreshDecision(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    decision: 'regenerate',
    providerId: fx.providerId
  });
  assert.deepEqual(
    (await fx.db.query(`SELECT event_type, status FROM outbox_events
      WHERE event_type IN ('patch_artifact','regenerate_artifact') ORDER BY event_type`)),
    [
      { event_type: 'patch_artifact', status: 'pending' },
      { event_type: 'regenerate_artifact', status: 'pending' }
    ]
  );
  const refreshPayloads = await fx.db.query(`SELECT event_type,payload
    FROM outbox_events
    WHERE event_type IN ('patch_artifact','regenerate_artifact')
    ORDER BY event_type`);
  assert.ok(refreshPayloads.every((event) => event.payload.baseVersionId === fx.versionId));

  await fx.db.query('UPDATE artifact_blocks SET stale=false WHERE artifact_version_id=$1', [fx.versionId]);
  await assert.rejects(
    recordRefreshDecision(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId,
      decision: 'keep',
      note: '영향 없음'
    }),
    (error) => error.code === 'REFRESH_NOT_REQUIRED'
  );
});

test('editing one block cannot clear stale or held safety state from the immutable successor version', async (t) => {
  const fx = await fixture(t);
  await fx.db.query('UPDATE artifact_blocks SET stale=true WHERE id=$1', [fx.blockIds[0]]);
  await fx.db.query('UPDATE artifact_blocks SET held=true WHERE id=$1', [fx.blockIds[1]]);
  await fx.db.query("UPDATE artifacts SET state='held' WHERE id=$1", [fx.artifactId]);

  const edited = await editArtifactBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    blockId: fx.blockIds[0],
    content: '가격은 원본 스냅샷 기준 100원입니다.',
    sourcePositions: ['본문 1 · 문장 1'],
    note: '표현을 명확하게 수정'
  });
  const successor = await fx.db.query(`SELECT block_key,stale,held
    FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal`, [edited.versionId]);
  assert.equal(successor.find((block) => block.block_key === 'fact-one').stale, true);
  assert.equal(successor.find((block) => block.block_key === 'fact-two').held, true);
  assert.equal((await fx.db.query('SELECT state FROM artifacts WHERE id=$1', [fx.artifactId]))[0].state, 'held');
  const safety = (await approvalBlockers(fx.db, {
    workspaceId: fx.workspaceId,
    artifactId: fx.artifactId
  })).find((blocker) => blocker.type === 'safety');
  assert.ok(safety);
  assert.equal(safety.detail.stale, 1);
  assert.equal(safety.detail.held, 1);
});

test('user edit clears verification on the changed factual block and carries only untouched exact refs', async (t) => {
  const fx = await fixture(t);
  await verifyAllFactual(fx);
  const edited = await editArtifactBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    blockId: fx.blockIds[0],
    content: '가격은 공개된 원본 기준으로 100원입니다.',
    sourcePositions: ['본문 1 · 문장 1'],
    note: '의미를 바꾸지 않고 표현을 명확하게 수정함'
  });
  assert.equal(edited.carriedVerificationCount, 1);
  const nextBlocks = await fx.db.query(`SELECT id,block_key,evidence_state
    FROM artifact_blocks WHERE artifact_version_id=$1 ORDER BY ordinal`, [edited.versionId]);
  const changed = nextBlocks.find((block) => block.block_key === 'fact-one');
  const untouched = nextBlocks.find((block) => block.block_key === 'fact-two');
  assert.equal(changed.evidence_state, 'review_required');
  assert.equal(untouched.evidence_state, 'verified');
  assert.equal(Number((await fx.db.query(`SELECT count(*)::int AS count
    FROM verifications WHERE artifact_block_id=$1 AND invalidated_at IS NULL`, [
    changed.id
  ]))[0].count), 0);
  const carried = (await fx.db.query(`SELECT id FROM verifications
    WHERE artifact_block_id=$1 AND invalidated_at IS NULL`, [untouched.id]))[0];
  assert.ok(carried);
  assert.deepEqual((await fx.db.query(`SELECT content_atom_id
    FROM verification_source_refs WHERE verification_id=$1
    ORDER BY content_atom_id`, [carried.id])).map((row) => row.content_atom_id), [
    fx.atomIds[1]
  ]);
});

test('review comments and non-stale regeneration are persisted real recovery controls', async (t) => {
  const fx = await fixture(t);
  const added = await addArtifactComment(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    blockId: fx.blockIds[0],
    body: '가격 표현을 원본과 다시 비교해 주세요.'
  });
  let review = await getArtifactReview(fx.db, fx.workspaceId, fx.artifactId);
  assert.equal(review.comments.length, 1);
  assert.equal(review.comments[0].id, added.commentId);
  assert.equal(review.comments[0].current_version, true);
  assert.equal(review.comments[0].resolved_at, null);

  await resolveArtifactComment(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    commentId: added.commentId
  });
  review = await getArtifactReview(fx.db, fx.workspaceId, fx.artifactId);
  assert.ok(review.comments[0].resolved_at);
  assert.equal(review.comments[0].resolved_by_email.endsWith('@example.com'), true);

  await assert.rejects(
    requestRegeneration(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId,
      providerId: fx.providerId
    }),
    { code: 'HUMAN_VERIFICATION_RESET_CONFIRMATION_REQUIRED' }
  );

  const regeneration = await requestRegeneration(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    providerId: fx.providerId,
    confirmHumanVerificationReset: true
  });
  assert.equal(regeneration.status, 'queued');
  assert.ok(regeneration.runId);
  assert.deepEqual(
    await fx.db.query(`SELECT event_type,status FROM outbox_events
      WHERE event_type='regenerate_artifact'`),
    [{ event_type: 'regenerate_artifact', status: 'pending' }]
  );

  await fx.db.query('UPDATE artifact_blocks SET stale=true WHERE id=$1', [fx.blockIds[0]]);
  await assert.rejects(
    requestRegeneration(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId,
      providerId: fx.providerId,
      confirmHumanVerificationReset: true
    }),
    { code: 'SOURCE_REFRESH_DECISION_REQUIRED' }
  );
});

test('patch worker rejects a refresh decision after the artifact base version changes', async (t) => {
  const fx = await fixture(t);
  await fx.db.query('UPDATE artifact_blocks SET stale=true WHERE id=$1', [fx.blockIds[0]]);
  await fx.db.query("UPDATE artifacts SET state='stale' WHERE id=$1", [fx.artifactId]);
  const refresh = await recordRefreshDecision(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    decision: 'patch',
    providerId: fx.providerId,
    confirmHumanVerificationReset: true
  });
  const successorVersionId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,
       channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,2,$3,'{"title":"newer user version"}'::jsonb,
       'naver_blog:v2','prompt.v1','evaluator.v1')`, [
      successorVersionId,
      fx.artifactId,
      fx.snapshotId
    ]);
    await tx.query("UPDATE artifacts SET current_version_id=$2,state='review_required' WHERE id=$1", [
      fx.artifactId,
      successorVersionId
    ]);
  });

  const result = await processNextEvent(fx.db, { environment: 'test', testMode: true });
  assert.equal(result.eventType, 'patch_artifact');
  assert.equal(result.error?.code, 'PATCH_BASE_VERSION_CHANGED');
  assert.equal(result.retry, false);
  assert.equal(
    (await fx.db.query('SELECT current_version_id FROM artifacts WHERE id=$1', [fx.artifactId]))[0].current_version_id,
    successorVersionId
  );
  assert.equal(
    (await fx.db.query('SELECT status FROM runs WHERE id=$1', [refresh.runId]))[0].status,
    'failed'
  );
});

test('regeneration worker rejects a queued request after the artifact base version changes', async (t) => {
  const fx = await fixture(t);
  const regeneration = await requestRegeneration(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    providerId: fx.providerId,
    confirmHumanVerificationReset: true
  });
  assert.equal(regeneration.baseVersionId, fx.versionId);
  const event = (await fx.db.query(`SELECT payload
    FROM outbox_events WHERE event_type='regenerate_artifact'`))[0];
  assert.equal(event.payload.baseVersionId, fx.versionId);

  const successorVersionId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,
       channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,2,$3,'{"title":"newer user version"}'::jsonb,
       'naver_blog:v2','prompt.v1','evaluator.v1')`, [
      successorVersionId,
      fx.artifactId,
      fx.snapshotId
    ]);
    await tx.query("UPDATE artifacts SET current_version_id=$2,state='review_required' WHERE id=$1", [
      fx.artifactId,
      successorVersionId
    ]);
  });

  const result = await processNextEvent(fx.db, { environment: 'test', testMode: true });
  assert.equal(result.eventType, 'regenerate_artifact');
  assert.equal(result.error?.code, 'REGENERATION_BASE_VERSION_CHANGED');
  assert.equal(result.retry, false);
  assert.equal(
    (await fx.db.query('SELECT current_version_id FROM artifacts WHERE id=$1', [fx.artifactId]))[0].current_version_id,
    successorVersionId
  );
  assert.equal(
    (await fx.db.query('SELECT status FROM runs WHERE id=$1', [regeneration.runId]))[0].status,
    'failed'
  );
});

test('source impact remains the exact block_source_refs dependency set', async (t) => {
  const fx = await fixture(t);
  const nextSnapshotId = id();
  const nextSegmentId = id();
  const nextAtomIds = [id(), id()];
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id, source_item_id, version_no, content_hash, title, body)
      VALUES ($1,$2,2,'snapshot-two','검토 경계','가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSnapshotId, fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id, snapshot_id, position_label, ordinal, segment_type, text)
      VALUES ($1,$2,'본문 1',1,'paragraph','가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSegmentId, nextSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id, snapshot_id, segment_id, position_label, atom_type, text, fingerprint)
      VALUES
      ($1,$3,$4,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v2'),
      ($2,$3,$4,'본문 1 · 문장 2','claim','배송은 내일입니다.','delivery-stable')`, [
      nextAtomIds[0], nextAtomIds[1], nextSnapshotId, nextSegmentId
    ]);
  });
  const changed = await changedAtomIds(fx.db, fx.snapshotId, nextSnapshotId);
  const affected = await affectedBlocksFromRefs(fx.db, changed);
  assert.deepEqual(changed, [fx.atomIds[0]]);
  assert.deepEqual(affected.map((row) => row.block_id), [fx.blockIds[0]]);
});

test('source invalidation compares historical refs with the locked latest snapshot across unchanged intermediate fingerprints', async (t) => {
  const fx = await fixture(t);
  await verifyBlock(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    blockId: fx.blockIds[0],
    note: 'v1 가격을 원본과 직접 대조함'
  });

  const secondSnapshotId = id();
  const secondSegmentId = id();
  const secondAtomIds = [id(), id()];
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,2,'transitive-snapshot-two','검토 경계',
       '가격은 100원입니다. 배송은 내일입니다.')`, [
      secondSnapshotId,
      fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES ($1,$2,'본문 1',1,'paragraph',
       '가격은 100원입니다. 배송은 내일입니다.')`, [
      secondSegmentId,
      secondSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES
      ($1,$3,$4,'본문 1 · 문장 1','number','가격은 100원입니다.','price-v1'),
      ($2,$3,$4,'본문 1 · 문장 2','claim','배송은 내일입니다.','delivery-stable')`, [
      secondAtomIds[0],
      secondAtomIds[1],
      secondSnapshotId,
      secondSegmentId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      fx.sourceItemId,
      secondSnapshotId
    ]);
  });

  const unchanged = await applySourceUpdate(fx.db, {
    sourceItemId: fx.sourceItemId,
    oldSnapshotId: fx.snapshotId,
    newSnapshotId: secondSnapshotId
  });
  assert.deepEqual(unchanged.changedAtomIds, []);
  assert.deepEqual(unchanged.affectedBlockIds, []);
  assert.equal(
    (await fx.db.query('SELECT invalidated_at FROM verifications WHERE artifact_block_id=$1', [
      fx.blockIds[0]
    ]))[0].invalidated_at,
    null,
    'an unchanged fingerprint must preserve the existing human verification'
  );

  const thirdSnapshotId = id();
  const thirdSegmentId = id();
  const thirdAtomIds = [id(), id()];
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,3,'transitive-snapshot-three','검토 경계',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      thirdSnapshotId,
      fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES ($1,$2,'본문 1',1,'paragraph',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      thirdSegmentId,
      thirdSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES
      ($1,$3,$4,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v3'),
      ($2,$3,$4,'본문 1 · 문장 2','claim','배송은 내일입니다.','delivery-stable')`, [
      thirdAtomIds[0],
      thirdAtomIds[1],
      thirdSnapshotId,
      thirdSegmentId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      fx.sourceItemId,
      thirdSnapshotId
    ]);
  });

  const changed = await applySourceUpdate(fx.db, {
    sourceItemId: fx.sourceItemId,
    oldSnapshotId: secondSnapshotId,
    newSnapshotId: thirdSnapshotId
  });
  assert.deepEqual(changed.changedAtomIds, [fx.atomIds[0]]);
  assert.deepEqual(changed.affectedBlockIds, [fx.blockIds[0]]);
  assert.equal(
    (await fx.db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [fx.blockIds[0]]))[0].stale,
    true
  );
  assert.equal(
    (await fx.db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [fx.blockIds[1]]))[0].stale,
    false
  );
  assert.notEqual(
    (await fx.db.query('SELECT invalidated_at FROM verifications WHERE artifact_block_id=$1', [
      fx.blockIds[0]
    ]))[0].invalidated_at,
    null,
    'the later changed fingerprint must invalidate verification attached to the v1 ref'
  );

  const delayed = await applySourceUpdate(fx.db, {
    sourceItemId: fx.sourceItemId,
    oldSnapshotId: fx.snapshotId,
    newSnapshotId: secondSnapshotId
  });
  const replayed = await applySourceUpdate(fx.db, {
    sourceItemId: fx.sourceItemId,
    oldSnapshotId: secondSnapshotId,
    newSnapshotId: thirdSnapshotId
  });
  assert.deepEqual(delayed.affectedBlockIds, [fx.blockIds[0]]);
  assert.deepEqual(replayed.affectedBlockIds, [fx.blockIds[0]]);
});

test('a committed source update is fenced from approval and export while invalidation is pending', async (t) => {
  const fx = await fixture(t);
  await verifyAllFactual(fx);
  await approveArtifact(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    artifactId: fx.artifactId,
    note: '변경 전 원본을 직접 확인함'
  });

  const nextSnapshotId = id();
  const nextSegmentId = id();
  const nextAtomIds = [id(), id()];
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,2,'pending-source-update','검토 경계',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSnapshotId,
      fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES ($1,$2,'본문 1',1,'paragraph',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSegmentId,
      nextSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES
      ($1,$3,$4,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v2'),
      ($2,$3,$4,'본문 1 · 문장 2','claim','배송은 내일입니다.','delivery-stable')`, [
      nextAtomIds[0],
      nextAtomIds[1],
      nextSnapshotId,
      nextSegmentId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      fx.sourceItemId,
      nextSnapshotId
    ]);
    await tx.query(`INSERT INTO outbox_events
      (id,workspace_id,event_type,payload,status,dedupe_key)
      VALUES ($1,$2,'apply_source_update',$3::jsonb,'pending',$4)`, [
      id(),
      fx.workspaceId,
      JSON.stringify({
        sourceItemId: fx.sourceItemId,
        oldSnapshotId: fx.snapshotId,
        newSnapshotId: nextSnapshotId
      }),
      `source-update:${fx.sourceItemId}:${nextSnapshotId}`
    ]);
  });

  assert.equal(
    (await fx.db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [fx.blockIds[0]]))[0].stale,
    false,
    'the worker has intentionally not applied the pending invalidation yet'
  );
  assert.deepEqual(
    (await currentVersionDriftFromRefs(fx.db, {
      workspaceId: fx.workspaceId,
      artifactId: fx.artifactId
    })).map((block) => block.block_id),
    [fx.blockIds[0]]
  );
  const blockers = await approvalBlockers(fx.db, {
    workspaceId: fx.workspaceId,
    artifactId: fx.artifactId
  });
  assert.equal(blockers[0].type, 'safety');
  assert.equal(blockers[0].detail.pendingSourceDrift, 1);
  await assert.rejects(
    approveArtifact(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId,
      note: 'pending update를 우회하면 안 됨'
    }),
    { code: 'APPROVAL_BLOCKED' }
  );
  await assert.rejects(
    recordRefreshDecision(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId,
      decision: 'keep',
      note: '비동기 변경 영향 적용 전에 기록하면 안 됨'
    }),
    { code: 'SOURCE_UPDATE_PENDING' }
  );
  await assert.rejects(
    exportMarkdown(fx.db, {
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      artifactId: fx.artifactId
    }),
    { code: 'SOURCE_UPDATE_PENDING' }
  );
});

test('source invalidation repeats block_source_refs impact after locking so a concurrent current version is complete', async (t) => {
  const fx = await fixture(t);
  const nextSnapshotId = id();
  const nextSegmentId = id();
  const nextPriceAtomId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,2,'concurrent-source-update','검토 경계','가격은 120원입니다.')`, [
      nextSnapshotId,
      fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES ($1,$2,'본문 1',1,'paragraph','가격은 120원입니다.')`, [
      nextSegmentId,
      nextSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES ($1,$2,$3,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v2')`, [
      nextPriceAtomId,
      nextSnapshotId,
      nextSegmentId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      fx.sourceItemId,
      nextSnapshotId
    ]);
  });

  const concurrentVersionId = id();
  const concurrentBlockId = id();
  let switched = false;
  const intercept = (query) => async (text, params = []) => {
    const rows = await query(text, params);
    if (!switched && text.includes('SELECT DISTINCT b.id AS block_id')) {
      switched = true;
      await query(`INSERT INTO artifact_versions
        (id,artifact_id,version_no,source_snapshot_id,content,
         channel_definition_version_id,prompt_bundle_version,evaluator_version)
        VALUES ($1,$2,2,$3,'{"title":"동시 버전"}'::jsonb,
         'naver_blog:v2','prompt.v1','evaluator.v1')`, [
        concurrentVersionId,
        fx.artifactId,
        fx.snapshotId
      ]);
      await query(`INSERT INTO artifact_blocks
        (id,artifact_version_id,block_key,block_type,ordinal,content,evidence_state,
         auto_check,surface_path,content_kind,content_hash)
        VALUES ($1,$2,'concurrent-price','paragraph',1,'가격은 100원입니다.',
         'review_required','{}'::jsonb,'$.intro','factual','concurrent-price-hash')`, [
        concurrentBlockId,
        concurrentVersionId
      ]);
      await query('INSERT INTO block_source_refs (artifact_block_id,content_atom_id) VALUES ($1,$2)', [
        concurrentBlockId,
        fx.atomIds[0]
      ]);
      await query("UPDATE artifacts SET current_version_id=$2,state='review_required' WHERE id=$1", [
        fx.artifactId,
        concurrentVersionId
      ]);
    }
    return rows;
  };
  const interleavingDb = {
    query: intercept((text, params) => fx.db.query(text, params)),
    transaction: (fn) => fx.db.transaction(async (tx) => fn({
      query: intercept((text, params) => tx.query(text, params))
    }))
  };

  const impact = await applySourceUpdate(interleavingDb, {
    sourceItemId: fx.sourceItemId,
    oldSnapshotId: fx.snapshotId,
    newSnapshotId: nextSnapshotId
  });
  assert.equal(switched, true);
  assert.deepEqual(
    impact.affectedBlockIds.sort(),
    [fx.blockIds[0], fx.blockIds[1], concurrentBlockId].sort()
  );
  assert.equal(
    (await fx.db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [concurrentBlockId]))[0].stale,
    true
  );
  assert.equal(
    (await fx.db.query('SELECT state FROM artifacts WHERE id=$1', [fx.artifactId]))[0].state,
    'stale'
  );
});

test('historical referencing blocks are invalidated without falsely marking an unaffected current version stale', async (t) => {
  const fx = await fixture(t);
  const currentVersionId = id();
  const currentBlockId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,channel_definition_version_id,
       prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,2,$3,'{"title":"배송만 안내"}'::jsonb,
       'naver_blog:v2','prompt.v1','evaluator.v1')`, [
      currentVersionId,
      fx.artifactId,
      fx.snapshotId
    ]);
    await tx.query(`INSERT INTO artifact_blocks
      (id,artifact_version_id,block_key,block_type,ordinal,content,evidence_state,
       auto_check,surface_path,content_kind,content_hash)
      VALUES ($1,$2,'delivery-current','paragraph',1,'배송은 내일입니다.',
       'review_required','{"automaticSupport":"supported"}'::jsonb,
       '$.sections[0].body','factual','delivery-current-hash')`, [
      currentBlockId,
      currentVersionId
    ]);
    await tx.query('INSERT INTO block_source_refs (artifact_block_id,content_atom_id) VALUES ($1,$2)', [
      currentBlockId,
      fx.atomIds[1]
    ]);
    await tx.query("UPDATE artifacts SET current_version_id=$2,state='review_required' WHERE id=$1", [
      fx.artifactId,
      currentVersionId
    ]);
  });

  const nextSnapshotId = id();
  const nextSegmentId = id();
  const nextPriceAtomId = id();
  const nextDeliveryAtomId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,2,'snapshot-price-change','검토 경계',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSnapshotId,
      fx.sourceItemId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES ($1,$2,'본문 1',1,'paragraph',
       '가격은 120원입니다. 배송은 내일입니다.')`, [
      nextSegmentId,
      nextSnapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES
      ($1,$3,$4,'본문 1 · 문장 1','number','가격은 120원입니다.','price-v2'),
      ($2,$3,$4,'본문 1 · 문장 2','claim','배송은 내일입니다.','delivery-stable')`, [
      nextPriceAtomId,
      nextDeliveryAtomId,
      nextSnapshotId,
      nextSegmentId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [
      fx.sourceItemId,
      nextSnapshotId
    ]);
  });

  const impact = await applySourceUpdate(fx.db, {
    sourceItemId: fx.sourceItemId,
    oldSnapshotId: fx.snapshotId,
    newSnapshotId: nextSnapshotId
  });
  assert.deepEqual(impact.affectedBlockIds, [fx.blockIds[0]]);
  assert.equal((await fx.db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [fx.blockIds[0]]))[0].stale, true);
  assert.equal((await fx.db.query('SELECT stale FROM artifact_blocks WHERE id=$1', [currentBlockId]))[0].stale, false);
  assert.equal(
    (await fx.db.query('SELECT state FROM artifacts WHERE id=$1', [fx.artifactId]))[0].state,
    'review_required'
  );
});
