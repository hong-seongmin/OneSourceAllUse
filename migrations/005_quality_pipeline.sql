ALTER TABLE model_provider_configs
  ADD COLUMN capabilities JSONB NOT NULL DEFAULT '{"structuredOutput":"json_object"}'::jsonb;
ALTER TABLE model_provider_configs
  ADD CONSTRAINT model_provider_capabilities_object
  CHECK (jsonb_typeof(capabilities) = 'object');

ALTER TABLE plans
  ADD COLUMN brief JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE plans
  ADD COLUMN source_readiness_acknowledged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE plans
  ADD COLUMN source_readiness_acknowledged_at TIMESTAMPTZ;
ALTER TABLE plans
  ADD CONSTRAINT plans_brief_object CHECK (jsonb_typeof(brief) = 'object');

ALTER TABLE plan_outputs
  ADD COLUMN evaluator_provider_id TEXT REFERENCES model_provider_configs(id);
ALTER TABLE plan_outputs
  ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE plan_outputs
  DROP CONSTRAINT plan_outputs_status_check;
ALTER TABLE plan_outputs
  ADD CONSTRAINT plan_outputs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'held', 'failed'));
ALTER TABLE plan_outputs
  ADD CONSTRAINT plan_outputs_quality_status_check
  CHECK (quality_status IN ('pending', 'checking', 'passed', 'warning', 'failed', 'held'));

ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs
  ADD CONSTRAINT runs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'held', 'failed', 'retrying'));

ALTER TABLE run_steps DROP CONSTRAINT run_steps_status_check;
ALTER TABLE run_steps
  ADD CONSTRAINT run_steps_status_check
  CHECK (status IN ('running', 'succeeded', 'held', 'failed'));

CREATE TABLE generation_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  plan_output_id TEXT NOT NULL REFERENCES plan_outputs(id) ON DELETE CASCADE,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  channel_definition_version_id TEXT NOT NULL REFERENCES channel_definition_versions(id),
  generator_provider_id TEXT NOT NULL REFERENCES model_provider_configs(id),
  evaluator_provider_id TEXT NOT NULL REFERENCES model_provider_configs(id),
  generator_model TEXT NOT NULL,
  evaluator_model TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  prompt_bundle_version TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  evaluator_assurance TEXT NOT NULL CHECK (evaluator_assurance IN ('HIGH_ASSURANCE', 'LOW_ASSURANCE')),
  status TEXT NOT NULL CHECK (status IN ('running', 'held', 'succeeded', 'failed')),
  stage TEXT NOT NULL CHECK (stage IN ('source_readiness', 'evidence_plan', 'platform_outline', 'draft', 'deterministic_checks', 'semantic_checks', 'repair', 'final_validation', 'artifact_finalize')),
  readiness_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (readiness_state IN ('pending', 'complete', 'partial', 'incompatible', 'insufficient', 'quarantined')),
  readiness_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_plan_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_evaluation JSONB NOT NULL DEFAULT '{}'::jsonb,
  repair_limit SMALLINT NOT NULL DEFAULT 2 CHECK (repair_limit BETWEEN 0 AND 2),
  accepted_attempt_no SMALLINT,
  artifact_version_id TEXT REFERENCES artifact_versions(id),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(run_id, plan_output_id)
);

CREATE TABLE evidence_plans (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES generation_executions(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'partial', 'blocked')),
  supported_purpose TEXT NOT NULL DEFAULT '',
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_information JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_atom_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (jsonb_typeof(missing_information) = 'array'),
  CHECK (jsonb_typeof(selected_atom_ids) = 'array')
);

CREATE TABLE evidence_plan_blocks (
  id TEXT PRIMARY KEY,
  evidence_plan_id TEXT NOT NULL REFERENCES evidence_plans(id) ON DELETE CASCADE,
  block_key TEXT NOT NULL,
  block_purpose TEXT NOT NULL,
  claim_intent TEXT NOT NULL DEFAULT '',
  content_kind TEXT NOT NULL CHECK (content_kind IN ('factual', 'editorial', 'production')),
  atom_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  omitted_reason TEXT NOT NULL DEFAULT '',
  ordinal INTEGER NOT NULL,
  UNIQUE(evidence_plan_id, block_key),
  CHECK (jsonb_typeof(atom_ids) = 'array')
);

CREATE TABLE generation_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES generation_executions(id) ON DELETE CASCADE,
  attempt_no SMALLINT NOT NULL CHECK (attempt_no BETWEEN 1 AND 4),
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('draft', 'schema_repair', 'content_repair')),
  target_block_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_model TEXT NOT NULL,
  provider_capability TEXT NOT NULL CHECK (provider_capability IN ('json_schema', 'json_object', 'text')),
  request_hash TEXT NOT NULL,
  raw_output TEXT,
  candidate JSONB,
  schema_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  deterministic_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  semantic_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  finish_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('generated', 'schema_failed', 'semantic_failed', 'accepted', 'rejected')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(execution_id, attempt_no),
  CHECK (jsonb_typeof(target_block_keys) = 'array')
);

CREATE TABLE quality_evaluation_runs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES generation_executions(id) ON DELETE CASCADE,
  generation_attempt_id TEXT NOT NULL REFERENCES generation_attempts(id) ON DELETE CASCADE,
  evaluator_provider_id TEXT NOT NULL REFERENCES model_provider_configs(id),
  evaluator_model TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  assurance TEXT NOT NULL CHECK (assurance IN ('HIGH_ASSURANCE', 'LOW_ASSURANCE')),
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'repair_required', 'held', 'failed')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(generation_attempt_id, evaluator_version)
);

CREATE TABLE quality_findings (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES quality_evaluation_runs(id) ON DELETE CASCADE,
  artifact_block_id TEXT REFERENCES artifact_blocks(id) ON DELETE CASCADE,
  block_key TEXT,
  surface_path TEXT,
  code TEXT NOT NULL,
  dimension TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'fail')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'acknowledged')),
  message TEXT NOT NULL,
  recovery TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE repair_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES generation_executions(id) ON DELETE CASCADE,
  source_attempt_id TEXT NOT NULL REFERENCES generation_attempts(id),
  result_attempt_id TEXT REFERENCES generation_attempts(id),
  repair_no SMALLINT NOT NULL CHECK (repair_no BETWEEN 1 AND 2),
  finding_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  changed_block_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'improved', 'unchanged', 'regressed', 'accepted', 'exhausted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(execution_id, repair_no),
  CHECK (jsonb_typeof(finding_ids) = 'array'),
  CHECK (jsonb_typeof(changed_block_keys) = 'array')
);

CREATE TABLE quality_evaluator_cache (
  block_content_hash TEXT NOT NULL,
  atom_fingerprint_set_hash TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(block_content_hash, atom_fingerprint_set_hash, evaluator_version)
);

ALTER TABLE artifact_versions
  ADD COLUMN prompt_bundle_version TEXT;
ALTER TABLE artifact_versions
  ADD COLUMN evaluator_version TEXT;
ALTER TABLE artifact_versions
  ADD COLUMN generation_attempt_id TEXT REFERENCES generation_attempts(id);

ALTER TABLE artifact_blocks
  ADD COLUMN surface_path TEXT;
ALTER TABLE artifact_blocks
  ADD COLUMN content_kind TEXT;
ALTER TABLE artifact_blocks
  ADD COLUMN content_hash TEXT;
ALTER TABLE artifact_blocks
  ADD COLUMN atom_fingerprint_set JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE artifact_blocks
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated';
UPDATE artifact_blocks
  SET surface_path = '$.legacy.' || block_key,
      content_kind = CASE WHEN evidence_state = 'not_required' THEN 'editorial' ELSE 'factual' END,
      content_hash = 'legacy:' || md5(content);
ALTER TABLE artifact_blocks ALTER COLUMN surface_path SET NOT NULL;
ALTER TABLE artifact_blocks ALTER COLUMN content_kind SET NOT NULL;
ALTER TABLE artifact_blocks ALTER COLUMN content_hash SET NOT NULL;
ALTER TABLE artifact_blocks
  ADD CONSTRAINT artifact_blocks_content_kind_check
  CHECK (content_kind IN ('factual', 'editorial', 'production'));
ALTER TABLE artifact_blocks
  ADD CONSTRAINT artifact_blocks_origin_check
  CHECK (origin IN ('generated', 'schema_repair', 'content_repair', 'user_edit', 'source_patch'));

CREATE TABLE artifact_comments (
  id TEXT PRIMARY KEY,
  artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  artifact_block_id TEXT REFERENCES artifact_blocks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT REFERENCES users(id)
);

CREATE INDEX generation_executions_output_idx
  ON generation_executions(plan_output_id, created_at DESC);
CREATE INDEX generation_attempts_execution_idx
  ON generation_attempts(execution_id, attempt_no);
CREATE INDEX quality_findings_open_idx
  ON quality_findings(evaluation_run_id, status, severity);
CREATE INDEX artifact_comments_version_idx
  ON artifact_comments(artifact_version_id, created_at);
