import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { id } from '../apps/shared/ids.js';
import { createPlan, normalizeSourceSelections } from '../apps/shared/planner.js';

test('source selection assigns the primary first and preserves supplemental input order', () => {
  assert.deepEqual(normalizeSourceSelections({
    sourceSelections: [
      { sourceItemId: 'supplemental-a', expectedSnapshotId: 'snapshot-a', isPrimary: false },
      { sourceItemId: 'primary', expectedSnapshotId: 'snapshot-primary', isPrimary: true },
      { sourceItemId: 'supplemental-b', expectedSnapshotId: 'snapshot-b', isPrimary: false }
    ]
  }).map(({ sourceItemId, sourceKey, ordinal, isPrimary }) => ({
    sourceItemId,
    sourceKey,
    ordinal,
    isPrimary
  })), [
    { sourceItemId: 'primary', sourceKey: 'source_1', ordinal: 1, isPrimary: true },
    { sourceItemId: 'supplemental-a', sourceKey: 'source_2', ordinal: 2, isPrimary: false },
    { sourceItemId: 'supplemental-b', sourceKey: 'source_3', ordinal: 3, isPrimary: false }
  ]);
});

test('plan creation freezes exact multi-source selections, de-duplicates supplemental evidence, and separates acknowledgement', async (t) => {
  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  const user = await bootstrapAdministrator(db, {
    email: `${id()}@example.test`,
    password: 'correct-horse-battery-staple'
  });
  const workspaceId = (await db.query(
    'SELECT workspace_id FROM users WHERE id=$1',
    [user.id]
  ))[0].workspace_id;
  const primary = {
    sourceId: id(),
    itemId: id(),
    snapshotId: id(),
    segmentId: id(),
    atoms: [id(), id()]
  };
  const supplemental = {
    sourceId: id(),
    itemId: id(),
    snapshotId: id(),
    segmentId: id(),
    atoms: [id(), id()]
  };
  const providerId = id();
  const identityVersionId = id();
  const suggestionExecutionId = id();
  const suggestionRunId = id();
  const suggestionSourceId = id();
  const suggestionProfileId = id();

  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,rights_status,created_by)
      VALUES
      ($1,$3,'주 원본','rss','https://example.test/primary.xml','owned',$4),
      ($2,$3,'보조 원본','rss','https://example.test/supplemental.xml','owned',$4)`, [
      primary.sourceId,
      supplemental.sourceId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO source_items
      (id,source_id,external_key,title)
      VALUES
      ($1,$3,'primary','주 원본 항목'),
      ($2,$4,'supplemental','보조 원본 항목')`, [
      primary.itemId,
      supplemental.itemId,
      primary.sourceId,
      supplemental.sourceId
    ]);
    await tx.query(`INSERT INTO source_snapshots
      (id,source_item_id,version_no,content_hash,title,body)
      VALUES
      ($1,$3,1,'primary-v1','주 원본','공통 사실. 주 원본 사실.'),
      ($2,$4,1,'supplemental-v1','보조 원본','공통 사실. 보조 원본 고유 사실.')`, [
      primary.snapshotId,
      supplemental.snapshotId,
      primary.itemId,
      supplemental.itemId
    ]);
    await tx.query(`UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1`, [
      primary.itemId,
      primary.snapshotId
    ]);
    await tx.query(`UPDATE source_items SET latest_snapshot_id=$2 WHERE id=$1`, [
      supplemental.itemId,
      supplemental.snapshotId
    ]);
    await tx.query(`INSERT INTO source_segments
      (id,snapshot_id,position_label,ordinal,segment_type,text)
      VALUES
      ($1,$3,'본문 1',1,'paragraph','공통 사실. 주 원본 사실.'),
      ($2,$4,'본문 1',1,'paragraph','공통 사실. 보조 원본 고유 사실.')`, [
      primary.segmentId,
      supplemental.segmentId,
      primary.snapshotId,
      supplemental.snapshotId
    ]);
    await tx.query(`INSERT INTO content_atoms
      (id,snapshot_id,segment_id,position_label,atom_type,text,fingerprint)
      VALUES
      ($1,$5,$6,'본문 1 · 문장 1','claim','공통 사실.','shared-fingerprint'),
      ($2,$5,$6,'본문 1 · 문장 2','claim','주 원본 사실.','primary-only'),
      ($3,$7,$8,'본문 1 · 문장 1','claim','공통 사실.','shared-fingerprint'),
      ($4,$7,$8,'본문 1 · 문장 2','claim','보조 원본 고유 사실.','supplemental-only')`, [
      primary.atoms[0],
      primary.atoms[1],
      supplemental.atoms[0],
      supplemental.atoms[1],
      primary.snapshotId,
      primary.segmentId,
      supplemental.snapshotId,
      supplemental.segmentId
    ]);
    await tx.query(`INSERT INTO source_snapshot_assessments
      (snapshot_id,readiness,rights_status,usable_atom_ids,omissions,signals,
       acknowledgement_required)
      VALUES
      ($1,'complete','owned',$3::jsonb,'[]'::jsonb,'[]'::jsonb,false),
      ($2,'partial','owned',$4::jsonb,'["SOURCE_DESCRIPTION_APPEARS_PARTIAL"]'::jsonb,
       '[]'::jsonb,false)`, [
      primary.snapshotId,
      supplemental.snapshotId,
      JSON.stringify(primary.atoms),
      JSON.stringify(supplemental.atoms)
    ]);
    await tx.query(`INSERT INTO model_provider_configs
      (id,workspace_id,name,provider_type,base_url,model,secret_ciphertext,enabled,created_by)
      VALUES ($1,$2,'다중 원본 Provider','solar','https://api.example.test/v1',
       'solar-open2','encrypted-test-value',true,$3)`, [
      providerId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO creator_identity_versions
      (id,workspace_id,version_no,created_by)
      VALUES ($1,$2,1,$3)`, [
      identityVersionId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO runs
      (id,workspace_id,run_type,status,created_by,started_at,completed_at)
      VALUES ($1,$2,'planner_suggestion','succeeded',$3,now(),now())`, [
      suggestionExecutionId,
      workspaceId,
      user.id
    ]);
    await tx.query(`INSERT INTO planner_suggestion_runs
      (id,run_id,workspace_id,source_item_id,source_snapshot_id,provider_id,
       creator_identity_version_id,
       idempotency_key_hash,input_fingerprint,frozen_profiles,frozen_primary,
       frozen_corpus,created_by,completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'suggestion-key','suggestion-input',
       '[]'::jsonb,'{}'::jsonb,'[]'::jsonb,$8,now())`, [
      suggestionRunId,
      suggestionExecutionId,
      workspaceId,
      primary.itemId,
      primary.snapshotId,
      providerId,
      identityVersionId,
      user.id
    ]);
    await tx.query(`INSERT INTO planner_suggestion_sources
      (id,suggestion_run_id,source_item_id,snapshot_id,source_key,ordinal,readiness,
       acknowledgement_required,disposition)
      VALUES ($1,$2,$3,$4,'source_2',2,'partial',true,'included')`, [
      suggestionSourceId,
      suggestionRunId,
      supplemental.itemId,
      supplemental.snapshotId
    ]);
    await tx.query(`INSERT INTO planner_suggestion_source_refs
      (suggestion_source_id,snapshot_id,content_atom_id)
      VALUES ($1,$2,$3),($1,$2,$4)`, [
      suggestionSourceId,
      supplemental.snapshotId,
      supplemental.atoms[0],
      supplemental.atoms[1]
    ]);
    await tx.query(`INSERT INTO planner_suggestion_profiles
      (id,suggestion_run_id,platform_profile_version_id,ordinal,settings,
       field_reasons,field_origins,recommendation_reason,source_ranges,
       missing_context,expected_editing_effort,effort_reason)
      VALUES ($1,$2,'naver_blog:v2',1,$3::jsonb,'{}'::jsonb,'{}'::jsonb,
       '두 원본의 사실을 구조화함','[]'::jsonb,'[]'::jsonb,'low','직접 근거가 있음')`, [
      suggestionProfileId,
      suggestionRunId,
      JSON.stringify({ purpose: '두 원본으로 정확한 안내' })
    ]);
  });

  const input = {
    workspaceId,
    userId: user.id,
    plannerSuggestionRunId: suggestionRunId,
    creatorIdentityVersionId: identityVersionId,
    providerId,
    evaluatorProviderId: providerId,
    sourceSelections: [
      {
        sourceItemId: supplemental.itemId,
        expectedSnapshotId: supplemental.snapshotId,
        suggestionSourceId,
        isPrimary: false
      },
      {
        sourceItemId: primary.itemId,
        expectedSnapshotId: primary.snapshotId,
        isPrimary: true
      }
    ],
    outputs: [{
      platformProfileVersionId: 'naver_blog:v2',
      type: 'naver_blog',
      settings: { purpose: '두 원본으로 정확한 안내' }
    }]
  };
  await assert.rejects(
    createPlan(db, {
      ...input,
      creatorIdentityVersionId: null,
      supplementalReadinessAcknowledged: true
    }),
    (error) => error.code === 'PLANNER_SUGGESTION_CONTEXT_CHANGED'
  );
  await assert.rejects(
    createPlan(db, input),
    (error) => error.code === 'SUPPLEMENTAL_SOURCE_ACKNOWLEDGEMENT_REQUIRED'
  );

  const plan = await createPlan(db, {
    ...input,
    supplementalReadinessAcknowledged: true
  });
  assert.equal(plan.sourceReadiness, 'partial');
  assert.deepEqual(plan.sourceSnapshots, [
    { sourceKey: 'source_1', snapshotId: primary.snapshotId, isPrimary: true },
    { sourceKey: 'source_2', snapshotId: supplemental.snapshotId, isPrimary: false }
  ]);

  const planSources = await db.query(`SELECT source_item_id,snapshot_id,source_key,ordinal,
      is_primary,readiness_acknowledged
    FROM plan_source_snapshots WHERE plan_id=$1 ORDER BY ordinal`, [plan.planId]);
  assert.deepEqual(planSources.map((source) => ({
    item: source.source_item_id,
    snapshot: source.snapshot_id,
    key: source.source_key,
    ordinal: Number(source.ordinal),
    primary: Boolean(source.is_primary),
    acknowledged: Boolean(source.readiness_acknowledged)
  })), [
    {
      item: primary.itemId,
      snapshot: primary.snapshotId,
      key: 'source_1',
      ordinal: 1,
      primary: true,
      acknowledged: false
    },
    {
      item: supplemental.itemId,
      snapshot: supplemental.snapshotId,
      key: 'source_2',
      ordinal: 2,
      primary: false,
      acknowledged: true
    }
  ]);
  const seeds = await db.query(`SELECT content_atom_id
    FROM plan_source_seed_atoms WHERE plan_id=$1 ORDER BY content_atom_id`, [plan.planId]);
  assert.deepEqual(seeds.map((seed) => seed.content_atom_id), [supplemental.atoms[1]]);
  const runSources = await db.query(`SELECT source_key,snapshot_id,readiness_acknowledged
    FROM run_source_snapshots WHERE run_id=$1 ORDER BY ordinal`, [plan.runId]);
  assert.deepEqual(runSources.map((source) => ({
    key: source.source_key,
    snapshot: source.snapshot_id,
    acknowledged: Boolean(source.readiness_acknowledged)
  })), [
    { key: 'source_1', snapshot: primary.snapshotId, acknowledged: false },
    { key: 'source_2', snapshot: supplemental.snapshotId, acknowledged: true }
  ]);
  const runSeeds = await db.query(`SELECT content_atom_id
    FROM run_source_seed_atoms WHERE run_id=$1 ORDER BY content_atom_id`, [plan.runId]);
  assert.deepEqual(runSeeds.map((seed) => seed.content_atom_id), [supplemental.atoms[1]]);
  const output = (await db.query(`SELECT settings_origin,planner_suggestion_profile_id
    FROM plan_outputs WHERE plan_id=$1`, [plan.planId]))[0];
  assert.equal(output.settings_origin, 'automatic_suggestion');
  assert.equal(output.planner_suggestion_profile_id, suggestionProfileId);
  assert.equal((await db.query(`SELECT disposition FROM planner_suggestion_sources
    WHERE id=$1`, [suggestionSourceId]))[0].disposition, 'included');
});
