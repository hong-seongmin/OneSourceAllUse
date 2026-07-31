#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';
import axe from 'axe-core';
import { speechUnits } from '../apps/shared/platform-adapters.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET_CREATED_AT = '2026-07-30T03:13:10.177Z';
const TARGET_ERROR_CODE = 'QUALITY_REPAIR_CONSTRAINT_VIOLATION';
const TARGET_ERROR_MESSAGE = '문자열 수정 후보가 발화 단위 계약을 충족하지 못했습니다.';
const TERMINAL_RUN_STATES = new Set(['succeeded', 'held', 'failed']);
const execute = process.argv.includes('--execute');
const writeEvidence = process.argv.includes('--write-evidence');
const baseUrlArgument = process.argv.find((argument) => argument.startsWith('--base-url='));
const targetArgument = process.argv.find((argument) => argument.startsWith('--target-created-at='));
const baseUrl = (baseUrlArgument?.slice('--base-url='.length)
  || process.env.OSAU_CANARY_BASE_URL
  || 'http://127.0.0.1:3000').replace(/\/+$/u, '');
const targetCreatedAt = targetArgument?.slice('--target-created-at='.length) || TARGET_CREATED_AT;

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function shortFingerprint(value) {
  return fingerprint(value).slice(0, 16);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function axeViolations(page) {
  await page.evaluate(axe.source);
  return page.evaluate(async () => (await axe.run(document, {
    rules: { 'color-contrast': { enabled: true } }
  })).violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length
  })));
}

async function one(client, sql, values = []) {
  const result = await client.query(sql, values);
  return result.rows[0] || null;
}

async function targetState(client) {
  const target = await one(client, `
    SELECT run.id AS run_id,run.plan_id,run.workspace_id,run.created_at,
      run.run_type,run.status AS run_status,run.error_message AS run_error_message,
      output.id AS output_id,output.status AS output_status,output.quality_status,
      output.artifact_id,definition.channel,execution.id AS execution_id,
      execution.error_code,execution.error_message
    FROM generation_executions execution
    JOIN runs run ON run.id=execution.run_id
    JOIN plan_outputs output ON output.id=execution.plan_output_id
    JOIN channel_definition_versions definition
      ON definition.id=execution.channel_definition_version_id
    WHERE run.created_at >= $1::timestamptz
      AND run.created_at < $1::timestamptz + interval '1 second'
      AND definition.channel='tiktok_video'
      AND execution.error_code=$2
    ORDER BY execution.created_at DESC
    LIMIT 1
  `, [targetCreatedAt, TARGET_ERROR_CODE]);
  assert.ok(target, `TikTok target failure was not found at ${targetCreatedAt}`);
  return target;
}

async function immutableFailureSnapshot(client, target) {
  const run = await one(client, `SELECT id,run_type,status,error_message,
      started_at,completed_at,created_at
    FROM runs WHERE id=$1`, [target.run_id]);
  const execution = await one(client, `SELECT id,run_id,status,stage,error_code,error_message,
      accepted_attempt_no,artifact_version_id,created_at,completed_at
    FROM generation_executions WHERE id=$1`, [target.execution_id]);
  const attempts = (await client.query(`SELECT id,execution_id,attempt_no,attempt_kind,status,
      error_code,error_message,schema_result,created_at,completed_at
    FROM generation_attempts WHERE execution_id=$1 ORDER BY attempt_no`, [
    target.execution_id
  ])).rows;
  const outbox = await one(client, `SELECT id,event_type,status,attempts,last_error,
      created_at,completed_at
    FROM outbox_events WHERE payload->>'runId'=$1
    ORDER BY created_at DESC LIMIT 1`, [target.run_id]);
  return {
    run: jsonSafe(run),
    execution: jsonSafe(execution),
    attempts: jsonSafe(attempts),
    outbox: jsonSafe(outbox)
  };
}

async function latestRetryRun(client, target, excludedRunIds) {
  const result = await client.query(`SELECT id,run_type,status,error_message,
      started_at,completed_at,created_at
    FROM runs
    WHERE plan_id=$1 AND run_type='artifact_generation_retry'
    ORDER BY created_at DESC`, [target.plan_id]);
  return result.rows.find((row) => !excludedRunIds.has(row.id)) || null;
}

async function waitForRetryRun(client, target, excludedRunIds, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await latestRetryRun(client, target, excludedRunIds);
    if (run) return run;
    await wait(250);
  }
  assert.fail('The browser request succeeded but no persistent retry run was created.');
}

async function waitForTerminalRun(client, runId, timeoutMs = 360_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await one(client, `SELECT id,run_type,status,error_message,
        started_at,completed_at,created_at
      FROM runs WHERE id=$1`, [runId]);
    if (run && TERMINAL_RUN_STATES.has(run.status)) return run;
    await wait(2_000);
  }
  assert.fail(`Retry run did not reach a terminal state within ${timeoutMs}ms.`);
}

async function inspectSuccessfulRetry(client, target, retryRun) {
  const output = await one(client, `SELECT output.id,output.status AS output_status,
      output.quality_status,output.artifact_id,artifact.state AS artifact_state,
      artifact.current_version_id,version.content,version.generation_attempt_id
    FROM plan_outputs output
    LEFT JOIN artifacts artifact ON artifact.id=output.artifact_id
    LEFT JOIN artifact_versions version ON version.id=artifact.current_version_id
    WHERE output.id=$1`, [target.output_id]);
  assert.equal(output.output_status, 'succeeded');
  assert.equal(output.artifact_state, 'review_required');
  assert.ok(output.artifact_id);
  assert.ok(output.current_version_id);
  assert.equal(output.content?.type, 'tiktok_video_timeline_preview');
  assert.deepEqual(output.content.scenes.map((scene) => scene.durationSeconds), [3, 14, 13]);
  assert.equal(output.content.totalSeconds, 30);

  const sceneDensity = output.content.scenes.map((scene, index) => ({
    scene: index + 1,
    durationSeconds: scene.durationSeconds,
    speechUnits: speechUnits(scene.narration),
    maximumSpeechUnits: scene.durationSeconds * 6
  }));
  assert.ok(sceneDensity.every((scene) => (
    scene.speechUnits > 0 && scene.speechUnits <= scene.maximumSpeechUnits
  )));

  const execution = await one(client, `SELECT id,status,stage,error_code,error_message,
      accepted_attempt_no,artifact_version_id,evaluator_assurance,pipeline_version,
      prompt_bundle_version,evaluator_version,readiness_state
    FROM generation_executions WHERE run_id=$1 AND plan_output_id=$2`, [
    retryRun.id,
    target.output_id
  ]);
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.artifact_version_id, output.current_version_id);
  assert.equal(execution.evaluator_assurance, 'LOW_ASSURANCE');
  if (execution.readiness_state === 'partial') {
    assert.equal(output.quality_status, 'warning');
  } else {
    assert.equal(execution.readiness_state, 'complete');
    assert.equal(output.quality_status, 'passed');
  }

  const attempts = (await client.query(`SELECT attempt_no,attempt_kind,status,
      error_code,schema_result,deterministic_result,semantic_result
    FROM generation_attempts WHERE execution_id=$1 ORDER BY attempt_no`, [
    execution.id
  ])).rows;
  assert.ok(attempts.length >= 1 && attempts.length <= 4);
  const acceptedAttempts = attempts.filter((attempt) => attempt.status === 'accepted');
  assert.equal(acceptedAttempts.length, 1);
  assert.equal(Number(acceptedAttempts[0].attempt_no), Number(execution.accepted_attempt_no));

  const certifiedDiagnostics = attempts.flatMap((attempt) => (
    Array.isArray(attempt.schema_result?.repairDiagnostics)
      ? attempt.schema_result.repairDiagnostics
      : []
  )).filter((diagnostic) => diagnostic.contractVersion === 'server-certified-narration.v1');
  for (const diagnostic of certifiedDiagnostics) {
    assert.ok(diagnostic.slots.length > 0);
    assert.ok(diagnostic.slots.every((slot) => (
      ['provider_selected', 'server_certified_fallback'].includes(slot.origin)
        && slot.speechUnits > 0
        && slot.speechUnits <= slot.maximumSpeechUnits
    )));
  }

  const narrationBlocks = (await client.query(`SELECT block.id,block.ordinal,block.content,
      block.auto_check,count(ref.content_atom_id)::int AS ref_count
    FROM artifact_blocks block
    LEFT JOIN block_source_refs ref ON ref.artifact_block_id=block.id
    WHERE block.artifact_version_id=$1 AND block.block_type='narration'
    GROUP BY block.id,block.ordinal,block.content,block.auto_check
    ORDER BY block.ordinal`, [output.current_version_id])).rows;
  assert.equal(narrationBlocks.length, 3);
  assert.ok(narrationBlocks.every((block, index) => (
    Number(block.ref_count) >= 1
      && speechUnits(block.content) === sceneDensity[index].speechUnits
      && block.auto_check?.automaticOnly === true
      && block.auto_check?.humanVerified === false
  )));

  const evaluation = await one(client, `SELECT assurance,status,summary
    FROM quality_evaluation_runs
    WHERE execution_id=$1 AND status='passed'
    ORDER BY completed_at DESC LIMIT 1`, [execution.id]);
  assert.equal(evaluation.assurance, 'LOW_ASSURANCE');
  assert.equal(evaluation.summary?.automaticOnly, true);
  assert.equal(evaluation.summary?.humanVerified, false);

  const humanState = await one(client, `SELECT
      (SELECT count(*)::int FROM verifications verification
        JOIN artifact_blocks block ON block.id=verification.artifact_block_id
        WHERE block.artifact_version_id=$1) AS verification_count,
      (SELECT count(*)::int FROM approvals
        WHERE artifact_version_id=$1) AS approval_count`, [output.current_version_id]);
  assert.equal(humanState.verification_count, 0);
  assert.equal(humanState.approval_count, 0);

  const persistence = await one(client, `SELECT
      (SELECT count(*)::int FROM run_source_snapshots WHERE run_id=$1) AS source_snapshot_count,
      (SELECT count(*)::int FROM outbox_events
        WHERE payload->>'runId'=$1 AND status='succeeded') AS succeeded_outbox_count,
      (SELECT count(*)::int FROM audit_events
        WHERE action='plan_output.retry_requested'
          AND entity_id=$2 AND detail->>'runId'=$1) AS retry_audit_count,
      (SELECT count(*)::int FROM domain_events
        WHERE event_type='plan_output.retry_requested'
          AND aggregate_id=$2 AND payload->>'runId'=$1) AS retry_domain_event_count,
      (SELECT count(*)::int FROM audit_events
        WHERE action='artifact.generated' AND entity_id=$3) AS generated_audit_count,
      (SELECT count(*)::int FROM domain_events
        WHERE event_type='artifact.generated' AND aggregate_id=$3) AS generated_domain_event_count`,
  [retryRun.id, target.output_id, output.artifact_id]);
  assert.ok(persistence.source_snapshot_count >= 1);
  assert.equal(persistence.succeeded_outbox_count, 1);
  assert.equal(persistence.retry_audit_count, 1);
  assert.equal(persistence.retry_domain_event_count, 1);
  assert.ok(persistence.generated_audit_count >= 1);
  assert.ok(persistence.generated_domain_event_count >= 1);

  return {
    artifactFingerprint: shortFingerprint({
      artifactId: output.artifact_id,
      versionId: output.current_version_id
    }),
    artifactState: output.artifact_state,
    outputStatus: output.output_status,
    qualityStatus: output.quality_status,
    previewType: output.content.type,
    totalSeconds: output.content.totalSeconds,
    sceneDensity,
    generation: {
      status: execution.status,
      acceptedAttemptNo: Number(execution.accepted_attempt_no),
      attemptKinds: attempts.map((attempt) => ({
        attemptNo: Number(attempt.attempt_no),
        kind: attempt.attempt_kind,
        status: attempt.status,
        errorCode: attempt.error_code
      })),
      certifiedRepairExercised: certifiedDiagnostics.length > 0,
      certifiedRepairSlots: certifiedDiagnostics.reduce(
        (count, diagnostic) => count + diagnostic.slots.length,
        0
      ),
      pipelineVersion: execution.pipeline_version,
      promptBundleVersion: execution.prompt_bundle_version,
      evaluatorVersion: execution.evaluator_version,
      sourceReadiness: execution.readiness_state
    },
    assurance: {
      evaluator: evaluation.assurance,
      automaticOnly: evaluation.summary.automaticOnly,
      humanVerified: evaluation.summary.humanVerified,
      verificationCount: humanState.verification_count,
      approvalCount: humanState.approval_count
    },
    persistence
  };
}

async function run() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required.');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let browser;
  try {
    const target = await targetState(client);
    assert.equal(target.channel, 'tiktok_video');
    assert.equal(target.run_type, 'artifact_generation');
    assert.equal(target.run_status, 'failed');
    assert.equal(target.error_code, TARGET_ERROR_CODE);
    assert.equal(target.error_message, TARGET_ERROR_MESSAGE);
    assert.ok(
      ['failed', 'succeeded'].includes(target.output_status),
      `Unexpected current plan output state: ${target.output_status}`
    );

    const provider = await one(client, `SELECT id,name,model
      FROM model_provider_configs
      WHERE workspace_id=$1 AND enabled=true AND provider_type<>'fixture'
        AND secret_ciphertext IS NOT NULL AND model='solar-open2'
      ORDER BY is_default DESC,updated_at DESC LIMIT 1`, [target.workspace_id]);
    assert.ok(provider, 'A ready non-fixture solar-open2 Provider was not found.');

    const baseline = await immutableFailureSnapshot(client, target);
    assert.equal(baseline.attempts.length, 1);
    const baselineFingerprint = fingerprint(baseline);
    const existingRuns = new Set((await client.query(
      'SELECT id FROM runs WHERE plan_id=$1',
      [target.plan_id]
    )).rows.map((row) => row.id));

    const report = {
      contract: 'production-tiktok-retry-canary.v1',
      executedAt: new Date().toISOString(),
      baseUrl,
      target: {
        createdAt: new Date(target.created_at).toISOString(),
        channel: target.channel,
        runStatus: target.run_status,
        currentOutputStatus: target.output_status,
        errorCode: target.error_code,
        errorMessage: target.error_message,
        immutableStateFingerprint: baselineFingerprint
      },
      provider: {
        type: 'non-fixture',
        name: provider.name,
        model: provider.model,
        evaluatorMode: 'same-provider-low-assurance'
      },
      execute
    };

    if (!execute) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/app/runs`, { waitUntil: 'networkidle' });
    assert.equal(response?.status(), 200);
    assert.ok(
      await page.getByText(TARGET_ERROR_MESSAGE, { exact: true }).count() >= 1,
      'The persisted failure message is not visible in the recovery UI.'
    );
    assert.ok(await page.getByText(
      '아래 실패 결과물에서 실제 생성·평가 Provider를 선택해 새 실행으로 재시도',
      { exact: true }
    ).count() >= 1, 'The persistent retry guidance is not visible.');
    const runsAccessibilityBefore = await axeViolations(page);
    assert.deepEqual(runsAccessibilityBefore, []);
    let retryRun;
    let retryRequestStatus;
    let retrySubmittedThisInvocation = false;
    if (target.output_status === 'failed') {
      const failedOutputRow = page.getByRole('row').filter({ hasText: 'TikTok Video' }).last();
      assert.equal(await failedOutputRow.getByLabel('재시도 생성 Provider').count(), 1);
      await failedOutputRow.getByLabel('재시도 생성 Provider').selectOption(provider.id);
      await failedOutputRow.getByLabel('재시도 평가 Provider').selectOption(provider.id);
      const retryResponsePromise = page.waitForResponse((candidate) => (
        /\/api\/plan-outputs\/[^/]+\/retry$/u.test(candidate.url())
          && candidate.request().method() === 'POST'
      ));
      await failedOutputRow.getByRole('button', { name: '실패한 결과물 다시 생성' }).click();
      const retryResponse = await retryResponsePromise;
      retryRequestStatus = retryResponse.status();
      assert.equal(retryRequestStatus, 200);
      retrySubmittedThisInvocation = true;
      await page.waitForURL(`${baseUrl}/app/runs`);
      retryRun = await waitForRetryRun(client, target, existingRuns);
    } else {
      retryRequestStatus = 'completed-before-resume';
      retryRun = await latestRetryRun(client, target, new Set([target.run_id]));
      assert.ok(retryRun, 'A succeeded output exists without a persistent retry run.');
    }
    assert.notEqual(retryRun.id, target.run_id);
    const terminalRetryRun = await waitForTerminalRun(client, retryRun.id);
    assert.equal(
      terminalRetryRun.status,
      'succeeded',
      terminalRetryRun.error_message || `retry ended as ${terminalRetryRun.status}`
    );

    const immutableAfter = await immutableFailureSnapshot(client, target);
    assert.equal(
      fingerprint(immutableAfter),
      baselineFingerprint,
      'The retry mutated the original failed run boundary.'
    );
    const success = await inspectSuccessfulRetry(client, target, terminalRetryRun);

    await page.reload({ waitUntil: 'networkidle' });
    const succeededOutputRow = page.getByRole('row').filter({ hasText: 'TikTok Video' }).last();
    assert.equal(await succeededOutputRow.getByRole('link', {
      name: 'Review Workbench 열기'
    }).count(), 1);
    await succeededOutputRow.getByRole('link', { name: 'Review Workbench 열기' }).click();
    await page.getByRole('heading', { name: 'Review Workbench' }).waitFor();
    await page.getByText('TikTok For You·댓글 대화 초안 · 9:16', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '현재 버전 승인' }).isDisabled(), true);
    assert.match(
      await page.locator('#approval-blockers').innerText(),
      /현재 원본 스냅샷과 직접 비교하지 않은 사실 블록/u
    );
    assert.match(
      (await page.locator('.automatic-summary,.review-boundary').allTextContents()).join(' '),
      /자동.*사람|사람.*자동/u
    );
    const body = await page.locator('body').innerText();
    assert.doesNotMatch(body, new RegExp(target.output_id, 'u'));
    assert.doesNotMatch(body, new RegExp(terminalRetryRun.id, 'u'));
    const reviewAccessibility = await axeViolations(page);
    assert.deepEqual(reviewAccessibility, []);

    report.retry = {
      runFingerprint: shortFingerprint(terminalRetryRun.id),
      status: terminalRetryRun.status,
      originalFailureImmutable: true,
      originalStateFingerprintAfter: fingerprint(immutableAfter),
      browser: {
        retryRequestStatus,
        retrySubmittedThisInvocation,
        runsAccessibilityViolations: runsAccessibilityBefore,
        reviewWorkbenchReached: true,
        approvalCorrectlyBlockedPendingHumanVerification: true,
        internalIdsHidden: true,
        reviewAccessibilityViolations: reviewAccessibility
      },
      ...success
    };

    if (writeEvidence) {
      const stamp = report.executedAt.replaceAll(/[:.]/gu, '-');
      const evidencePath = join(
        ROOT,
        'evidence',
        'quality',
        `production-tiktok-retry-${stamp}.json`
      );
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      report.evidencePath = evidencePath;
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await client.end();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    status: 'failed',
    code: error.code || error.name,
    message: error.message,
    stack: error.stack
  }, null, 2));
  process.exitCode = 1;
});
