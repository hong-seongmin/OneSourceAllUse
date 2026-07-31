import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { bootstrapAdministrator } from '../apps/shared/auth.js';
import { activeChannelCatalog } from '../apps/shared/channels.js';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import { id } from '../apps/shared/ids.js';
import { saveModelProvider } from '../apps/shared/intelligence.js';
import {
  analyzePlannerSuggestionBatch,
  finalizePlannerSuggestion,
  getPlannerSuggestion,
  preparePlannerSuggestion,
  requestPlannerSuggestion,
  retryPlannerSuggestion,
  sourceSelectionsFromPlannerSuggestion
} from '../apps/shared/planner-suggestions.js';
import { persistEntry } from '../apps/shared/rss.js';

const secretKey = Buffer.alloc(32, 11).toString('base64');
const config = {
  environment: 'test',
  testMode: true,
  secretKey,
  plannerSuggestionBatchSize: 1,
  plannerSuggestionSourceCharBudget: 4_000,
  plannerSuggestionMaxSupplementalSources: 8
};

async function sourceFixture(db, { workspaceId, userId, name, key, body }) {
  const source = {
    id: id(),
    workspace_id: workspaceId,
    rights_status: 'owned'
  };
  await db.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,created_by,rights_status)
    VALUES ($1,$2,$3,'rss',$4,$5,'owned')`, [
    source.id,
    workspaceId,
    name,
    `https://example.test/${key}.xml`,
    userId
  ]);
  await db.query("INSERT INTO source_sync_states (source_id,status) VALUES ($1,'succeeded')", [source.id]);
  const sourceItemId = await persistEntry(db, source, {
    key,
    title: `${name} 제목`,
    url: `https://example.test/${key}`,
    body,
    publishedAt: '2026-07-29T00:00:00.000Z',
    raw: {},
    ingestionMeta: { captureMode: 'full_text' }
  });
  const item = (await db.query(`SELECT latest_snapshot_id
    FROM source_items WHERE id=$1`, [sourceItemId]))[0];
  await db.query(`UPDATE source_snapshot_assessments
    SET readiness='complete',rights_status='owned',omissions='[]'::jsonb,
      acknowledgement_required=false
    WHERE snapshot_id=$1`, [item.latest_snapshot_id]);
  return {
    sourceItemId,
    snapshotId: item.latest_snapshot_id
  };
}

async function plannerFixture(t) {
  const db = createPgliteDatabase(new PGlite());
  t.after(() => db.close());
  await migrate(db, process.cwd());
  await bootstrapAdministrator(db, {
    email: `planner-${id()}@example.test`,
    password: 'correct-horse-battery-staple'
  });
  const user = (await db.query('SELECT id,workspace_id FROM users'))[0];
  const primary = await sourceFixture(db, {
    workspaceId: user.workspace_id,
    userId: user.id,
    name: '주 원본',
    key: 'primary',
    body: '독자는 정확한 준비 순서를 원합니다. 첫 단계는 요구사항을 확인하는 것입니다. 두 번째 단계는 결과를 검토하는 것입니다.'
  });
  const supplemental = await sourceFixture(db, {
    workspaceId: user.workspace_id,
    userId: user.id,
    name: '보조 원본',
    key: 'supplemental',
    body: '검토 체크리스트에는 근거 위치와 누락 맥락이 포함됩니다. 승인 전에는 자동 검사와 사람 확인을 구분해야 합니다.'
  });
  const providerId = await saveModelProvider(db, {
    workspaceId: user.workspace_id,
    userId: user.id,
    name: 'Planner Fixture',
    providerType: 'fixture',
    baseUrl: 'https://example.test/v1',
    model: 'fixture-planner',
    apiKey: 'test-only',
    environment: 'test',
    testMode: true,
    secretKey
  });
  return {
    db,
    userId: user.id,
    workspaceId: user.workspace_id,
    primary,
    supplemental,
    providerId
  };
}

function settingValue(channel, key, schema) {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer') return schema.minimum ?? 1;
  return key === 'purpose' ? `${channel} 독자의 실행 결정을 돕기` : `${channel} ${key}`;
}

function profileFixtureResponse(catalog, primaryHandle) {
  return {
    profiles: catalog.map((row) => {
      const properties = row.profile.settingsSchema.properties;
      const settings = {};
      const fieldReasons = {};
      const fieldOrigins = {};
      for (const [key, schema] of Object.entries(properties)) {
        settings[key] = settingValue(row.channel, key, schema);
        fieldReasons[key] = schema.default !== undefined
          ? '검증된 Profile 기본값을 적용합니다.'
          : '주 원본의 독자 목적과 직접 연결합니다.';
        fieldOrigins[key] = schema.default !== undefined
          ? { type: 'profile_default', sourcePositions: [] }
          : { type: 'source_evidence', sourcePositions: [primaryHandle] };
      }
      return {
        profileId: row.id,
        settings,
        fieldReasons,
        fieldOrigins,
        recommendationReason: `${row.display_name}의 구조와 목적에 맞춘 설정입니다.`,
        sourcePositions: [primaryHandle],
        missingContext: [],
        expectedEditingEffort: 'low',
        effortReason: '원본 근거와 Profile 기본값이 모두 준비되어 있습니다.'
      };
    })
  };
}

test('planner suggestion persists idempotent requests, exact refs, all active profiles, and canonical plan input', async (t) => {
  const fx = await plannerFixture(t);
  await fx.db.query(`UPDATE source_snapshot_assessments
    SET readiness='partial',acknowledgement_required=false
    WHERE snapshot_id=$1`, [fx.supplemental.snapshotId]);
  const request = {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    sourceItemId: fx.primary.sourceItemId,
    expectedSnapshotId: fx.primary.snapshotId,
    providerId: fx.providerId,
    idempotencyKey: 'planner-request-1'
  };
  const queued = await requestPlannerSuggestion(fx.db, request, config);
  const reused = await requestPlannerSuggestion(fx.db, request, config);
  assert.equal(reused.suggestionRunId, queued.suggestionRunId);
  assert.equal(reused.reused, true);
  const prepareEvents = await fx.db.query(`SELECT payload
    FROM outbox_events WHERE event_type='prepare_planner_suggestion'`);
  assert.equal(prepareEvents.length, 1);
  assert.deepEqual(Object.keys(prepareEvents[0].payload).sort(), ['runId', 'suggestionRunId']);

  const prepared = await preparePlannerSuggestion(fx.db, queued, config);
  assert.equal(prepared.batchCount, 1);
  const batch = (await fx.db.query(`SELECT id
    FROM planner_suggestion_batches WHERE suggestion_run_id=$1`, [queued.suggestionRunId]))[0];
  const candidate = (await fx.db.query(`SELECT id,snapshot_id,source_key
    FROM planner_suggestion_sources WHERE batch_id=$1`, [batch.id]))[0];
  const candidateAtom = (await fx.db.query(`SELECT position_label
    FROM content_atoms WHERE snapshot_id=$1 ORDER BY position_label LIMIT 1`, [candidate.snapshot_id]))[0];
  const candidateHandle = `${candidate.source_key}::${candidateAtom.position_label}`;
  await analyzePlannerSuggestionBatch(fx.db, {
    runId: queued.runId,
    batchId: batch.id
  }, {
    ...config,
    fixtureResponse: {
      sources: [{
        sourceKey: candidate.source_key,
        include: true,
        relevanceScore: 0.91,
        recommendationReason: '검토와 승인 맥락을 보완합니다.',
        sourcePositions: [candidateHandle]
      }]
    }
  });
  const persistedRef = (await fx.db.query(`SELECT ref.snapshot_id,ref.content_atom_id
    FROM planner_suggestion_source_refs ref
    WHERE ref.suggestion_source_id=$1`, [candidate.id]))[0];
  assert.equal(persistedRef.snapshot_id, candidate.snapshot_id);

  const primaryAtom = (await fx.db.query(`SELECT position_label
    FROM content_atoms WHERE snapshot_id=$1 AND atom_type<>'context'
    ORDER BY position_label LIMIT 1`, [fx.primary.snapshotId]))[0];
  const primaryHandle = `source_1::${primaryAtom.position_label}`;
  const catalog = await activeChannelCatalog(fx.db, fx.workspaceId);
  const finalized = await finalizePlannerSuggestion(fx.db, queued, {
    ...config,
    fixtureResponse: profileFixtureResponse(catalog, primaryHandle)
  });
  assert.equal(finalized.profiles.length, catalog.length);
  assert.equal(finalized.humanVerified, false);
  assert.equal(finalized.automaticOnly, true);
  assert.equal(finalized.sourceSelection.included.length, 1);
  assert.equal(finalized.sourceSelection.included[0].acknowledgementRequired, true);
  assert.doesNotMatch(
    finalized.sourceSelection.included[0].sourceRanges[0].startLabel,
    /^source_\d+::/u
  );
  const profileRows = await fx.db.query(`SELECT platform_profile_version_id,settings,
      field_reasons,field_origins
    FROM planner_suggestion_profiles WHERE suggestion_run_id=$1`, [queued.suggestionRunId]);
  assert.equal(profileRows.length, catalog.length);
  for (const row of profileRows) {
    const contract = catalog.find((profile) => profile.id === row.platform_profile_version_id);
    assert.deepEqual(Object.keys(row.settings).sort(), Object.keys(contract.profile.settingsSchema.properties).sort());
    assert.deepEqual(Object.keys(row.field_reasons).sort(), Object.keys(row.settings).sort());
    assert.deepEqual(Object.keys(row.field_origins).sort(), Object.keys(row.settings).sort());
  }

  const status = await getPlannerSuggestion(fx.db, {
    workspaceId: fx.workspaceId,
    suggestionRunId: queued.suggestionRunId
  });
  assert.equal(status.status, 'succeeded');
  assert.equal(status.profiles.length, catalog.length);

  const canonical = await sourceSelectionsFromPlannerSuggestion(fx.db, {
    workspaceId: fx.workspaceId,
    sourceItemId: fx.primary.sourceItemId,
    expectedSnapshotId: fx.primary.snapshotId,
    suggestionRunId: queued.suggestionRunId,
    supplementalSnapshotIds: [fx.supplemental.snapshotId]
  });
  assert.deepEqual(canonical.sourceSelections.map((source) => source.sourceKey), ['source_1', 'source_2']);
  assert.ok(canonical.sourceSeedAtomRefs.length > 0);
  assert.ok(canonical.sourceSeedAtomRefs.every((ref) =>
    ref.snapshotId === fx.supplemental.snapshotId));
  assert.equal(canonical.suggestionProfiles.length, catalog.length);
});

test('planner suggestion rejects an unlisted supplemental snapshot and retries as a new run', async (t) => {
  const fx = await plannerFixture(t);
  const queued = await requestPlannerSuggestion(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    sourceItemId: fx.primary.sourceItemId,
    expectedSnapshotId: fx.primary.snapshotId,
    providerId: fx.providerId,
    idempotencyKey: 'failed-planner-request'
  }, config);
  await fx.db.query(`UPDATE runs SET status='failed',error_message='terminal'
    WHERE id=$1`, [queued.runId]);
  await assert.rejects(() => sourceSelectionsFromPlannerSuggestion(fx.db, {
    workspaceId: fx.workspaceId,
    sourceItemId: fx.primary.sourceItemId,
    expectedSnapshotId: fx.primary.snapshotId,
    suggestionRunId: queued.suggestionRunId,
    supplementalSnapshotIds: [fx.supplemental.snapshotId]
  }), { code: 'PLANNER_SUGGESTION_NOT_READY' });
  const retry = await retryPlannerSuggestion(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    suggestionRunId: queued.suggestionRunId,
    idempotencyKey: 'failed-planner-retry'
  }, config);
  assert.notEqual(retry.runId, queued.runId);
  assert.notEqual(retry.suggestionRunId, queued.suggestionRunId);
  const retryRow = (await fx.db.query(`SELECT retry_of_suggestion_run_id
    FROM planner_suggestion_runs WHERE id=$1`, [retry.suggestionRunId]))[0];
  assert.equal(retryRow.retry_of_suggestion_run_id, queued.suggestionRunId);
  const retryEvent = (await fx.db.query(`SELECT payload
    FROM outbox_events
    WHERE event_type='prepare_planner_suggestion'
      AND payload->>'suggestionRunId'=$1`, [retry.suggestionRunId]))[0];
  assert.deepEqual(Object.keys(retryEvent.payload).sort(), ['runId', 'suggestionRunId']);
});

test('planner suggestion fails closed when a corpus source is disabled between async stages', async (t) => {
  const fx = await plannerFixture(t);
  const queued = await requestPlannerSuggestion(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    sourceItemId: fx.primary.sourceItemId,
    expectedSnapshotId: fx.primary.snapshotId,
    providerId: fx.providerId,
    idempotencyKey: 'disabled-corpus'
  }, config);
  await preparePlannerSuggestion(fx.db, queued, config);
  const batch = (await fx.db.query(`SELECT id
    FROM planner_suggestion_batches WHERE suggestion_run_id=$1`, [queued.suggestionRunId]))[0];
  const candidate = (await fx.db.query(`SELECT candidate.id,candidate.snapshot_id,
      candidate.source_key,item.source_id
    FROM planner_suggestion_sources candidate
    JOIN source_items item ON item.id=candidate.source_item_id
    WHERE candidate.batch_id=$1`, [batch.id]))[0];
  const atom = (await fx.db.query(`SELECT position_label
    FROM content_atoms WHERE snapshot_id=$1 ORDER BY position_label LIMIT 1`, [candidate.snapshot_id]))[0];
  const fixtureResponse = {
    sources: [{
      sourceKey: candidate.source_key,
      include: true,
      relevanceScore: 0.8,
      recommendationReason: '보조 근거가 필요합니다.',
      sourcePositions: [`${candidate.source_key}::${atom.position_label}`]
    }]
  };
  await fx.db.query('UPDATE sources SET enabled=false WHERE id=$1', [candidate.source_id]);
  await assert.rejects(() => analyzePlannerSuggestionBatch(fx.db, {
    runId: queued.runId,
    batchId: batch.id
  }, { ...config, fixtureResponse }), { code: 'PLANNER_SUGGESTION_CORPUS_CHANGED' });

  await fx.db.query('UPDATE sources SET enabled=true WHERE id=$1', [candidate.source_id]);
  await analyzePlannerSuggestionBatch(fx.db, {
    runId: queued.runId,
    batchId: batch.id
  }, { ...config, fixtureResponse });
  await fx.db.query('UPDATE sources SET enabled=false WHERE id=$1', [candidate.source_id]);
  await assert.rejects(() => finalizePlannerSuggestion(fx.db, queued, {
    ...config,
    fixtureResponse: {}
  }), { code: 'PLANNER_SUGGESTION_CORPUS_CHANGED' });
});

test('fixture planner provider fails immediately at the production boundary', async (t) => {
  const fx = await plannerFixture(t);
  await assert.rejects(() => requestPlannerSuggestion(fx.db, {
    workspaceId: fx.workspaceId,
    userId: fx.userId,
    sourceItemId: fx.primary.sourceItemId,
    expectedSnapshotId: fx.primary.snapshotId,
    providerId: fx.providerId,
    idempotencyKey: 'production-fixture'
  }, {
    ...config,
    environment: 'production'
  }), { code: 'FIXTURE_PROVIDER_IN_PRODUCTION' });
});
