import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { aggregateRun } from '../apps/shared/generation.js';
import { id } from '../apps/shared/ids.js';
import { evaluatePatch } from '../apps/shared/patch.js';
import { retryPlanOutput } from '../apps/shared/planner.js';
import { processNextEvent } from '../apps/worker/worker.js';

async function persistedPlan(t) {
  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: `${id()}@example.test`,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query('SELECT workspace_id FROM users WHERE id=$1', [user.id]))[0].workspace_id;
  const sourceId = id();
  const sourceItemId = id();
  const snapshotId = id();
  const planId = id();
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,rights_status,created_by)
      VALUES ($1,$2,'run 경계 원본','rss','https://example.test/feed.xml','owned',$3)`, [
      sourceId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO source_items
      (id,source_id,external_key,title)
      VALUES ($1,$2,'run-boundary','run 경계')`, [sourceItemId, sourceId]);
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES ($1,$2,1,'run-boundary-snapshot','run 경계','가격은 100원입니다.')`, [
      snapshotId,
      sourceItemId
    ]);
    await tx.query('UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1', [sourceItemId, snapshotId]);
    await tx.query(`INSERT INTO plans
      (id,workspace_id,source_item_id,snapshot_id,created_by)
      VALUES ($1,$2,$3,$4,$5)`, [planId, workspaceId, sourceItemId, snapshotId, user.id]);
  });
  return { db, userId: user.id, workspaceId, sourceItemId, snapshotId, planId };
}

test('terminal worker failure closes the persisted run, open steps, execution, and outbox event', async (t) => {
  const fx = await persistedPlan(t);
  const providerId = id();
  const outputId = id();
  const runId = id();
  const stepId = id();
  const executionId = id();
  const eventId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO model_provider_configs
      (id,workspace_id,name,provider_type,base_url,model,enabled,created_by)
      VALUES ($1,$2,'terminal failure provider','openai_compatible',
        'https://provider.example.test/v1','boundary-model',true,$3)`, [
      providerId,
      fx.workspaceId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO plan_outputs
      (id,plan_id,output_type,channel_definition_version_id,selected,settings,status,quality_status)
      VALUES ($1,$2,'naver_blog','naver_blog:v2',true,
        '{"purpose":"terminal failure"}'::jsonb,'running','checking')`, [
      outputId,
      fx.planId
    ]);
    await tx.query(`INSERT INTO runs
      (id,workspace_id,plan_id,run_type,status,created_by,started_at)
      VALUES ($1,$2,$3,'terminal_failure_canary','running',$4,now())`, [
      runId,
      fx.workspaceId,
      fx.planId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO run_steps
      (id,run_id,step_name,status)
      VALUES ($1,$2,'terminal_failure_canary','running')`, [stepId, runId]);
    await tx.query(`INSERT INTO generation_executions
      (id,run_id,plan_output_id,source_snapshot_id,channel_definition_version_id,
       generator_provider_id,evaluator_provider_id,generator_model,evaluator_model,
       pipeline_version,prompt_bundle_version,evaluator_version,evaluator_assurance,
       status,stage,readiness_state)
      VALUES ($1,$2,$3,$4,'naver_blog:v2',$5,$5,'boundary-model','boundary-model',
        'boundary-pipeline','boundary-prompt','boundary-evaluator','LOW_ASSURANCE',
        'running','semantic_checks','complete')`, [
      executionId,
      runId,
      outputId,
      fx.snapshotId,
      providerId
    ]);
    await tx.query(`INSERT INTO outbox_events
      (id,workspace_id,event_type,payload,status,attempts)
      VALUES ($1,$2,'unknown_terminal_canary',$3::jsonb,'pending',4)`, [
      eventId,
      fx.workspaceId,
      JSON.stringify({ runId, planOutputId: outputId })
    ]);
  });

  const result = await processNextEvent(fx.db, { environment: 'test', testMode: true });
  assert.equal(result.error.code, 'UNKNOWN_JOB');
  assert.equal(result.retry, false);
  const run = (await fx.db.query('SELECT status,error_message,completed_at FROM runs WHERE id=$1', [runId]))[0];
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /지원하지 않는 비동기 작업/u);
  assert.ok(run.completed_at);
  const step = (await fx.db.query('SELECT status,detail,completed_at FROM run_steps WHERE id=$1', [stepId]))[0];
  assert.equal(step.status, 'failed');
  assert.match(step.detail, /^UNKNOWN_JOB:/u);
  assert.ok(step.completed_at);
  const execution = (await fx.db.query(`SELECT status,error_code,error_message,completed_at
    FROM generation_executions WHERE id=$1`, [executionId]))[0];
  assert.equal(execution.status, 'failed');
  assert.equal(execution.error_code, 'UNKNOWN_JOB');
  assert.match(execution.error_message, /지원하지 않는 비동기 작업/u);
  assert.ok(execution.completed_at);
  assert.deepEqual(
    await fx.db.query('SELECT status,quality_status FROM plan_outputs WHERE id=$1', [outputId]),
    [{ status: 'failed', quality_status: 'failed' }]
  );
  const event = (await fx.db.query('SELECT status,attempts,last_error,completed_at FROM outbox_events WHERE id=$1', [eventId]))[0];
  assert.equal(event.status, 'failed');
  assert.equal(event.attempts, 5);
  assert.match(event.last_error, /지원하지 않는 비동기 작업/u);
  assert.ok(event.completed_at);
});

test('run aggregation ignores failed sibling outputs not attached to the current run', async (t) => {
  const fx = await persistedPlan(t);
  const targetOutputId = id();
  const siblingOutputId = id();
  const runId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO plan_outputs
      (id,plan_id,output_type,channel_definition_version_id,selected,settings,status,quality_status)
      VALUES
      ($1,$3,'naver_blog','naver_blog:v2',true,'{"purpose":"현재 run 대상"}'::jsonb,'succeeded','passed'),
      ($2,$3,'wordpress_article','wordpress_article:v2',true,'{"purpose":"다른 실행의 형제"}'::jsonb,'failed','failed')`, [
      targetOutputId,
      siblingOutputId,
      fx.planId
    ]);
    await tx.query(`INSERT INTO runs
      (id,workspace_id,plan_id,run_type,status,created_by,started_at)
      VALUES ($1,$2,$3,'artifact_regeneration','running',$4,now())`, [
      runId,
      fx.workspaceId,
      fx.planId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO outbox_events
      (id,workspace_id,event_type,payload,status,completed_at)
      VALUES ($1,$2,'generate_plan_output',$3::jsonb,'succeeded',now())`, [
      id(),
      fx.workspaceId,
      JSON.stringify({ runId, planOutputId: targetOutputId })
    ]);
  });

  assert.equal(await aggregateRun(fx.db, runId), 'succeeded');
  const run = (await fx.db.query('SELECT status,completed_at FROM runs WHERE id=$1', [runId]))[0];
  assert.equal(run.status, 'succeeded');
  assert.ok(run.completed_at);
});

test('a failed selected output creates one new persisted retry run and cannot be double queued', async (t) => {
  const fx = await persistedPlan(t);
  const providerId = id();
  const oldEvaluatorProviderId = id();
  const outputId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO model_provider_configs
      (id,workspace_id,name,provider_type,base_url,model,enabled,secret_ciphertext,created_by)
      VALUES ($1,$2,'real retry provider','openai_compatible',
        'https://provider.example.test/v1','retry-model',true,'encrypted-test-secret',$3)`, [
      providerId,
      fx.workspaceId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO model_provider_configs
      (id,workspace_id,name,provider_type,base_url,model,enabled,secret_ciphertext,created_by)
      VALUES ($1,$2,'old evaluator provider','openai_compatible',
        'https://old-evaluator.example.test/v1','old-evaluator-model',true,'encrypted-test-secret',$3)`, [
      oldEvaluatorProviderId,
      fx.workspaceId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO plan_outputs
      (id,plan_id,output_type,channel_definition_version_id,evaluator_provider_id,
       selected,settings,status,quality_status,error_message)
      VALUES ($1,$2,'naver_blog','naver_blog:v2',$3,true,
        '{"purpose":"실패 결과 복구"}'::jsonb,'failed','failed','upstream failed')`, [
      outputId,
      fx.planId,
      oldEvaluatorProviderId
    ]);
  });

  const retried = await retryPlanOutput(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    planOutputId: outputId,
    providerId,
    evaluatorProviderId: providerId
  });
  assert.equal(retried.status, 'queued');
  assert.deepEqual(
    await fx.db.query('SELECT status,quality_status,error_message,evaluator_provider_id FROM plan_outputs WHERE id=$1', [outputId]),
    [{ status: 'queued', quality_status: 'pending', error_message: null, evaluator_provider_id: providerId }]
  );
  assert.deepEqual(
    await fx.db.query('SELECT run_type,status FROM runs WHERE id=$1', [retried.runId]),
    [{ run_type: 'artifact_generation_retry', status: 'queued' }]
  );
  const events = await fx.db.query(`SELECT event_type,status,payload->>'planOutputId' AS plan_output_id,
      payload->>'runId' AS run_id,payload->>'evaluatorProviderId' AS evaluator_provider_id
    FROM outbox_events WHERE payload->>'runId'=$1`, [retried.runId]);
  assert.deepEqual(events, [{
    event_type: 'generate_plan_output',
    status: 'pending',
    plan_output_id: outputId,
    run_id: retried.runId,
    evaluator_provider_id: providerId
  }]);
  await assert.rejects(() => retryPlanOutput(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    planOutputId: outputId,
    providerId
  }), { code: 'PLAN_OUTPUT_RETRY_NOT_ALLOWED' });
});

test('retry of an output with an artifact pins its current base version and fails closed after a successor', async (t) => {
  const fx = await persistedPlan(t);
  const providerId = id();
  const outputId = id();
  const artifactId = id();
  const versionId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO model_provider_configs
      (id,workspace_id,name,provider_type,base_url,model,enabled,secret_ciphertext,created_by)
      VALUES ($1,$2,'artifact retry provider','openai_compatible',
        'https://provider.example.test/v1','retry-model',true,'encrypted-test-secret',$3)`, [
      providerId,
      fx.workspaceId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO artifacts
      (id,workspace_id,source_item_id,channel,state,created_by)
      VALUES ($1,$2,$3,'naver_blog','review_required',$4)`, [
      artifactId,
      fx.workspaceId,
      fx.sourceItemId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,
       channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,1,$3,'{}'::jsonb,'naver_blog:v2','prompt.v1','evaluator.v1')`, [
      versionId,
      artifactId,
      fx.snapshotId
    ]);
    await tx.query('UPDATE artifacts SET current_version_id=$2 WHERE id=$1', [
      artifactId,
      versionId
    ]);
    await tx.query(`INSERT INTO plan_outputs
      (id,plan_id,output_type,channel_definition_version_id,evaluator_provider_id,
       selected,settings,status,quality_status,error_message,artifact_id)
      VALUES ($1,$2,'naver_blog','naver_blog:v2',$3,true,
        '{"purpose":"artifact retry"}'::jsonb,'failed','failed','old failure',$4)`, [
      outputId,
      fx.planId,
      providerId,
      artifactId
    ]);
  });

  const retried = await retryPlanOutput(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    planOutputId: outputId,
    providerId,
    evaluatorProviderId: providerId
  });
  assert.equal(retried.baseVersionId, versionId);
  const queued = (await fx.db.query(`SELECT payload
    FROM outbox_events WHERE payload->>'runId'=$1`, [retried.runId]))[0];
  assert.equal(queued.payload.baseVersionId, versionId);

  const successorVersionId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO artifact_versions
      (id,artifact_id,version_no,source_snapshot_id,content,
       channel_definition_version_id,prompt_bundle_version,evaluator_version)
      VALUES ($1,$2,2,$3,'{}'::jsonb,'naver_blog:v2','prompt.v1','evaluator.v1')`, [
      successorVersionId,
      artifactId,
      fx.snapshotId
    ]);
    await tx.query('UPDATE artifacts SET current_version_id=$2 WHERE id=$1', [
      artifactId,
      successorVersionId
    ]);
  });

  const result = await processNextEvent(fx.db, { environment: 'test', testMode: true });
  assert.equal(result.eventType, 'generate_plan_output');
  assert.equal(result.error?.code, 'REGENERATION_BASE_VERSION_CHANGED');
  assert.equal(result.retry, false);
  assert.equal(
    (await fx.db.query('SELECT current_version_id FROM artifacts WHERE id=$1', [artifactId]))[0].current_version_id,
    successorVersionId
  );
});

test('patch evaluator retry reuses one run execution and appends a bounded attempt', async (t) => {
  const fx = await persistedPlan(t);
  const providerId = id();
  const outputId = id();
  const runId = id();
  await fx.db.transaction(async (tx) => {
    await tx.query(`INSERT INTO model_provider_configs
      (id,workspace_id,name,provider_type,base_url,model,enabled,capabilities,created_by)
      VALUES ($1,$2,'patch retry fixture','fixture','https://fixture.invalid/v1',
        'fixture-model',true,'{"structuredOutput":"json_object"}'::jsonb,$3)`, [
      providerId,
      fx.workspaceId,
      fx.userId
    ]);
    await tx.query(`INSERT INTO plan_outputs
      (id,plan_id,output_type,channel_definition_version_id,selected,settings,status,quality_status,
       evaluator_provider_id)
      VALUES ($1,$2,'naver_blog','naver_blog:v2',true,
        '{"purpose":"patch retry"}'::jsonb,'succeeded','passed',$3)`, [
      outputId,
      fx.planId,
      providerId
    ]);
    await tx.query(`INSERT INTO runs
      (id,workspace_id,plan_id,run_type,status,created_by,started_at)
      VALUES ($1,$2,$3,'artifact_patch','running',$4,now())`, [
      runId,
      fx.workspaceId,
      fx.planId,
      fx.userId
    ]);
  });

  const atom = {
    id: id(),
    snapshot_id: fx.snapshotId,
    position_label: '본문 1 · 문장 1',
    text: '가격은 100원입니다.',
    fingerprint: 'patch-retry-price'
  };
  const artifact = {
    plan_output_id: outputId,
    channel_definition_version_id: 'naver_blog:v2',
    prompt_bundle_version: 'naver_blog:v2:patch.v2'
  };
  const context = { settings: { purpose: '가격 안내' }, identityFacts: [] };
  const profile = {
    id: 'naver_blog:v2',
    channel: 'naver_blog',
    profileConfig: { rubric: [] }
  };
  const structured = {
    channel: 'naver_blog',
    preview: { intro: '가격은 100원입니다.' },
    blocks: [{
      key: 'intro',
      type: 'paragraph',
      surfacePath: '$.intro',
      content: '가격은 100원입니다.',
      contentKind: 'factual',
      refs: [atom.id],
      ordinal: 1
    }],
    deterministicChecks: []
  };
  const provider = {
    id: providerId,
    model: 'fixture-model',
    providerType: 'fixture',
    capabilities: { structuredOutput: 'json_object' }
  };
  const input = {
    artifact,
    context,
    profile,
    structured,
    atoms: [atom],
    provider,
    evaluator: provider,
    runId,
    completion: {
      content: '{"blocks":[{"key":"intro"}]}',
      capability: 'json_object',
      usage: {},
      finishReason: 'stop'
    },
    response: { blocks: [{ key: 'intro' }] },
    requestHash: 'patch-retry-request'
  };

  await assert.rejects(
    evaluatePatch(fx.db, {
      ...input,
      config: { environment: 'test', testMode: true, fixtureResponse: {} }
    }),
    { code: 'EVALUATOR_CONTRACT_FAILED' }
  );
  assert.equal((await fx.db.query('SELECT count(*)::int AS count FROM generation_executions'))[0].count, 1);
  assert.deepEqual(
    await fx.db.query('SELECT attempt_no,status FROM generation_attempts ORDER BY attempt_no'),
    [{ attempt_no: 1, status: 'generated' }]
  );

  const quality = await evaluatePatch(fx.db, {
    ...input,
    config: {
      environment: 'test',
      testMode: true,
      fixtureResponse: {
        purposeFit: 'supported',
        purposeReason: '원본 문장이 주장을 직접 지원함',
        blocks: [{
          blockKey: 'intro',
          claims: [{
            claim: '가격은 100원입니다.',
            verdict: 'supported',
            sourceHandles: [atom.position_label],
            reason: '연결된 문장과 동일함'
          }]
        }],
        allVisibleBlocksReviewed: true,
        creatorIdentityClaims: [],
        platformChecks: []
      }
    }
  });
  assert.equal(quality.held, false);
  assert.equal(quality.attemptNo, 2);
  assert.equal((await fx.db.query('SELECT count(*)::int AS count FROM generation_executions'))[0].count, 1);
  assert.deepEqual(
    await fx.db.query('SELECT attempt_no,status FROM generation_attempts ORDER BY attempt_no'),
    [
      { attempt_no: 1, status: 'generated' },
      { attempt_no: 2, status: 'accepted' }
    ]
  );
  assert.deepEqual(
    await fx.db.query(`SELECT attempt.attempt_no
      FROM quality_evaluation_runs evaluation
      JOIN generation_attempts attempt ON attempt.id=evaluation.generation_attempt_id`),
    [{ attempt_no: 2 }]
  );
});
