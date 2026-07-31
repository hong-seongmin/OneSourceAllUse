ALTER TABLE source_snapshots
  ADD CONSTRAINT source_snapshots_id_source_item_unique
  UNIQUE (id, source_item_id);

ALTER TABLE content_atoms
  ADD CONSTRAINT content_atoms_id_snapshot_unique
  UNIQUE (id, snapshot_id);

CREATE TABLE planner_suggestion_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  source_snapshot_id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES model_provider_configs(id),
  creator_identity_version_id TEXT REFERENCES creator_identity_versions(id),
  creator_voice_version_id TEXT REFERENCES creator_voice_versions(id),
  audience_persona_version_id TEXT REFERENCES audience_persona_versions(id),
  retry_of_suggestion_run_id TEXT REFERENCES planner_suggestion_runs(id),
  idempotency_key_hash TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  prompt_version TEXT NOT NULL DEFAULT 'planner-suggestion.v1',
  frozen_profiles JSONB NOT NULL CHECK (jsonb_typeof(frozen_profiles) = 'array'),
  frozen_primary JSONB NOT NULL CHECK (jsonb_typeof(frozen_primary) = 'object'),
  frozen_corpus JSONB NOT NULL CHECK (jsonb_typeof(frozen_corpus) = 'array'),
  corpus_count INTEGER NOT NULL DEFAULT 0 CHECK (corpus_count >= 0),
  normalized_result JSONB CHECK (normalized_result IS NULL OR jsonb_typeof(normalized_result) = 'object'),
  provider_model TEXT,
  provider_request_hash TEXT,
  provider_usage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_usage) = 'object'),
  provider_finish_reason TEXT,
  error_code TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key_hash),
  FOREIGN KEY (source_snapshot_id, source_item_id)
    REFERENCES source_snapshots(id, source_item_id)
);

CREATE INDEX planner_suggestion_runs_workspace_created_idx
  ON planner_suggestion_runs(workspace_id, created_at DESC);

CREATE INDEX planner_suggestion_runs_retry_idx
  ON planner_suggestion_runs(retry_of_suggestion_run_id);

ALTER TABLE plans
  ADD COLUMN planner_suggestion_run_id TEXT
  REFERENCES planner_suggestion_runs(id);

CREATE INDEX plans_planner_suggestion_run_idx
  ON plans(planner_suggestion_run_id);

CREATE TABLE planner_suggestion_batches (
  id TEXT PRIMARY KEY,
  suggestion_run_id TEXT NOT NULL REFERENCES planner_suggestion_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  input_fingerprint TEXT NOT NULL,
  normalized_result JSONB CHECK (normalized_result IS NULL OR jsonb_typeof(normalized_result) = 'object'),
  provider_model TEXT,
  provider_request_hash TEXT,
  provider_usage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_usage) = 'object'),
  provider_finish_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (suggestion_run_id, ordinal),
  UNIQUE (id, suggestion_run_id)
);

CREATE INDEX planner_suggestion_batches_status_idx
  ON planner_suggestion_batches(suggestion_run_id, status, ordinal);

CREATE TABLE planner_suggestion_sources (
  id TEXT PRIMARY KEY,
  suggestion_run_id TEXT NOT NULL REFERENCES planner_suggestion_runs(id) ON DELETE CASCADE,
  batch_id TEXT,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  snapshot_id TEXT NOT NULL,
  source_key TEXT NOT NULL CHECK (source_key ~ '^source_[1-9][0-9]*$'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 2),
  readiness TEXT NOT NULL CHECK (readiness IN ('complete', 'partial')),
  acknowledgement_required BOOLEAN NOT NULL DEFAULT false,
  disposition TEXT NOT NULL DEFAULT 'pending'
    CHECK (disposition IN ('pending', 'included', 'excluded')),
  relevance_score DOUBLE PRECISION,
  recommendation_reason TEXT,
  source_ranges JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_ranges) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (suggestion_run_id, source_key),
  UNIQUE (suggestion_run_id, ordinal),
  UNIQUE (suggestion_run_id, source_item_id),
  UNIQUE (suggestion_run_id, snapshot_id),
  UNIQUE (id, snapshot_id),
  FOREIGN KEY (batch_id, suggestion_run_id)
    REFERENCES planner_suggestion_batches(id, suggestion_run_id)
    ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, source_item_id)
    REFERENCES source_snapshots(id, source_item_id)
);

CREATE INDEX planner_suggestion_sources_batch_idx
  ON planner_suggestion_sources(batch_id, ordinal);

CREATE INDEX planner_suggestion_sources_snapshot_idx
  ON planner_suggestion_sources(snapshot_id);

CREATE TABLE planner_suggestion_source_refs (
  suggestion_source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  content_atom_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_source_id, content_atom_id),
  FOREIGN KEY (suggestion_source_id, snapshot_id)
    REFERENCES planner_suggestion_sources(id, snapshot_id)
    ON DELETE CASCADE,
  FOREIGN KEY (content_atom_id, snapshot_id)
    REFERENCES content_atoms(id, snapshot_id)
);

CREATE INDEX planner_suggestion_source_refs_atom_idx
  ON planner_suggestion_source_refs(content_atom_id);

CREATE TABLE planner_suggestion_profiles (
  id TEXT PRIMARY KEY,
  suggestion_run_id TEXT NOT NULL REFERENCES planner_suggestion_runs(id) ON DELETE CASCADE,
  platform_profile_version_id TEXT NOT NULL REFERENCES channel_definition_versions(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  settings JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  field_reasons JSONB NOT NULL CHECK (jsonb_typeof(field_reasons) = 'object'),
  field_origins JSONB NOT NULL CHECK (jsonb_typeof(field_origins) = 'object'),
  recommendation_reason TEXT NOT NULL,
  source_ranges JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_ranges) = 'array'),
  missing_context JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_context) = 'array'),
  expected_editing_effort TEXT NOT NULL
    CHECK (expected_editing_effort IN ('low', 'medium', 'high')),
  effort_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (suggestion_run_id, platform_profile_version_id),
  UNIQUE (suggestion_run_id, ordinal)
);

CREATE INDEX planner_suggestion_profiles_profile_idx
  ON planner_suggestion_profiles(platform_profile_version_id);

ALTER TABLE plan_outputs
  ADD COLUMN settings_origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (settings_origin IN ('manual', 'automatic_suggestion', 'automatic_suggestion_edited'));

ALTER TABLE plan_outputs
  ADD COLUMN planner_suggestion_profile_id TEXT
  REFERENCES planner_suggestion_profiles(id);

CREATE INDEX plan_outputs_planner_suggestion_profile_idx
  ON plan_outputs(planner_suggestion_profile_id);

CREATE TABLE planner_suggestion_profile_source_refs (
  suggestion_profile_id TEXT NOT NULL REFERENCES planner_suggestion_profiles(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  content_atom_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_profile_id, content_atom_id),
  FOREIGN KEY (content_atom_id, snapshot_id)
    REFERENCES content_atoms(id, snapshot_id)
);

CREATE INDEX planner_suggestion_profile_source_refs_atom_idx
  ON planner_suggestion_profile_source_refs(content_atom_id);

CREATE TABLE plan_source_snapshots (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  snapshot_id TEXT NOT NULL,
  source_key TEXT NOT NULL CHECK (source_key ~ '^source_[1-9][0-9]*$'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  suggestion_source_id TEXT REFERENCES planner_suggestion_sources(id),
  readiness_acknowledged BOOLEAN NOT NULL DEFAULT false,
  readiness_acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, source_key),
  UNIQUE (plan_id, ordinal),
  UNIQUE (plan_id, source_item_id),
  UNIQUE (plan_id, snapshot_id),
  UNIQUE (plan_id, source_item_id, snapshot_id),
  FOREIGN KEY (snapshot_id, source_item_id)
    REFERENCES source_snapshots(id, source_item_id)
);

CREATE UNIQUE INDEX plan_source_snapshots_one_primary_idx
  ON plan_source_snapshots(plan_id)
  WHERE is_primary;

CREATE INDEX plan_source_snapshots_snapshot_idx
  ON plan_source_snapshots(snapshot_id);

CREATE INDEX plan_source_snapshots_suggestion_idx
  ON plan_source_snapshots(suggestion_source_id);

INSERT INTO plan_source_snapshots
  (plan_id, source_item_id, snapshot_id, source_key, ordinal, is_primary,
   readiness_acknowledged, readiness_acknowledged_at)
SELECT plan.id, plan.source_item_id, plan.snapshot_id, 'source_1', 1, true,
  plan.source_readiness_acknowledged, plan.source_readiness_acknowledged_at
FROM plans plan
ON CONFLICT (plan_id, source_key) DO NOTHING;

CREATE TABLE plan_source_seed_atoms (
  plan_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  content_atom_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, content_atom_id),
  FOREIGN KEY (plan_id, source_item_id, snapshot_id)
    REFERENCES plan_source_snapshots(plan_id, source_item_id, snapshot_id)
    ON DELETE CASCADE,
  FOREIGN KEY (content_atom_id, snapshot_id)
    REFERENCES content_atoms(id, snapshot_id)
);

CREATE INDEX plan_source_seed_atoms_source_idx
  ON plan_source_seed_atoms(plan_id, source_item_id);

CREATE TABLE run_source_snapshots (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  snapshot_id TEXT NOT NULL,
  source_key TEXT NOT NULL CHECK (source_key ~ '^source_[1-9][0-9]*$'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  readiness_acknowledged BOOLEAN NOT NULL DEFAULT false,
  readiness_acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source_key),
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, source_item_id),
  UNIQUE (run_id, snapshot_id),
  UNIQUE (run_id, source_item_id, snapshot_id),
  FOREIGN KEY (snapshot_id, source_item_id)
    REFERENCES source_snapshots(id, source_item_id)
);

CREATE UNIQUE INDEX run_source_snapshots_one_primary_idx
  ON run_source_snapshots(run_id)
  WHERE is_primary;

CREATE INDEX run_source_snapshots_snapshot_idx
  ON run_source_snapshots(snapshot_id);

INSERT INTO run_source_snapshots
  (run_id, source_item_id, snapshot_id, source_key, ordinal, is_primary,
   readiness_acknowledged, readiness_acknowledged_at)
SELECT run.id, plan_source.source_item_id, plan_source.snapshot_id,
  plan_source.source_key, plan_source.ordinal, plan_source.is_primary,
  plan_source.readiness_acknowledged, plan_source.readiness_acknowledged_at
FROM runs run
JOIN plan_source_snapshots plan_source ON plan_source.plan_id=run.plan_id
ON CONFLICT (run_id, source_key) DO NOTHING;

CREATE TABLE run_source_seed_atoms (
  run_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  content_atom_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, content_atom_id),
  FOREIGN KEY (run_id, source_item_id, snapshot_id)
    REFERENCES run_source_snapshots(run_id, source_item_id, snapshot_id)
    ON DELETE CASCADE,
  FOREIGN KEY (content_atom_id, snapshot_id)
    REFERENCES content_atoms(id, snapshot_id)
);

CREATE INDEX run_source_seed_atoms_source_idx
  ON run_source_seed_atoms(run_id, source_item_id);

INSERT INTO run_source_seed_atoms
  (run_id, source_item_id, snapshot_id, content_atom_id)
SELECT run.id, seed.source_item_id, seed.snapshot_id, seed.content_atom_id
FROM runs run
JOIN plan_source_seed_atoms seed ON seed.plan_id=run.plan_id
JOIN run_source_snapshots run_source
  ON run_source.run_id=run.id
  AND run_source.source_item_id=seed.source_item_id
  AND run_source.snapshot_id=seed.snapshot_id
ON CONFLICT (run_id, content_atom_id) DO NOTHING;

CREATE TABLE artifact_version_source_snapshots (
  artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  snapshot_id TEXT NOT NULL,
  source_key TEXT NOT NULL CHECK (source_key ~ '^source_[1-9][0-9]*$'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  readiness_acknowledged BOOLEAN NOT NULL DEFAULT false,
  readiness_acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_version_id, source_key),
  UNIQUE (artifact_version_id, ordinal),
  UNIQUE (artifact_version_id, source_item_id),
  UNIQUE (artifact_version_id, snapshot_id),
  FOREIGN KEY (snapshot_id, source_item_id)
    REFERENCES source_snapshots(id, source_item_id)
);

CREATE UNIQUE INDEX artifact_version_source_snapshots_one_primary_idx
  ON artifact_version_source_snapshots(artifact_version_id)
  WHERE is_primary;

CREATE INDEX artifact_version_source_snapshots_snapshot_idx
  ON artifact_version_source_snapshots(snapshot_id);

INSERT INTO artifact_version_source_snapshots
  (artifact_version_id, source_item_id, snapshot_id, source_key, ordinal, is_primary,
   readiness_acknowledged, readiness_acknowledged_at)
SELECT version.id, snapshot.source_item_id, version.source_snapshot_id, 'source_1', 1, true,
  COALESCE(plan_source.readiness_acknowledged, false),
  plan_source.readiness_acknowledged_at
FROM artifact_versions version
JOIN source_snapshots snapshot ON snapshot.id=version.source_snapshot_id
LEFT JOIN runs run ON run.id=version.created_by_run_id
LEFT JOIN plan_source_snapshots plan_source
  ON plan_source.plan_id=run.plan_id
  AND plan_source.source_item_id=snapshot.source_item_id
  AND plan_source.snapshot_id=version.source_snapshot_id
ON CONFLICT (artifact_version_id, source_key) DO NOTHING;

CREATE TABLE verification_source_refs (
  verification_id TEXT NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  content_atom_id TEXT NOT NULL REFERENCES content_atoms(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (verification_id, content_atom_id)
);

CREATE INDEX verification_source_refs_atom_idx
  ON verification_source_refs(content_atom_id);

INSERT INTO verification_source_refs (verification_id, content_atom_id)
SELECT verification.id, block_ref.content_atom_id
FROM verifications verification
JOIN block_source_refs block_ref
  ON block_ref.artifact_block_id=verification.artifact_block_id
ON CONFLICT (verification_id, content_atom_id) DO NOTHING;
