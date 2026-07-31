CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('administrator', 'operator', 'reviewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('rss', 'youtube_metadata', 'transcript_upload')),
  feed_url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_sync_states (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('idle', 'queued', 'running', 'succeeded', 'failed')),
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_key TEXT NOT NULL,
  title TEXT NOT NULL,
  canonical_url TEXT,
  published_at TIMESTAMPTZ,
  latest_snapshot_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_id, external_key)
);

CREATE TABLE IF NOT EXISTS source_snapshots (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_item_id, version_no),
  UNIQUE(source_item_id, content_hash)
);
ALTER TABLE source_items
  ADD CONSTRAINT source_items_latest_snapshot_fk
  FOREIGN KEY (latest_snapshot_id) REFERENCES source_snapshots(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS source_segments (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  position_label TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  segment_type TEXT NOT NULL CHECK (segment_type IN ('title', 'heading', 'paragraph', 'transcript')),
  text TEXT NOT NULL,
  UNIQUE(snapshot_id, ordinal)
);

CREATE TABLE IF NOT EXISTS content_atoms (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
  position_label TEXT NOT NULL,
  atom_type TEXT NOT NULL CHECK (atom_type IN ('claim', 'quote', 'number', 'cta', 'context')),
  text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(snapshot_id, fingerprint, position_label)
);

CREATE TABLE IF NOT EXISTS creator_identity_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version_no INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, version_no)
);

CREATE TABLE IF NOT EXISTS creator_identity_facts (
  id TEXT PRIMARY KEY,
  identity_version_id TEXT NOT NULL REFERENCES creator_identity_versions(id) ON DELETE CASCADE,
  claim TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  evidence_note TEXT NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS creator_voice_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version_no INTEGER NOT NULL,
  guidance TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, version_no)
);

CREATE TABLE IF NOT EXISTS audience_persona_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  needs TEXT NOT NULL,
  constraints_text TEXT NOT NULL,
  evidence_note TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, version_no)
);

CREATE TABLE IF NOT EXISTS model_provider_configs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai_compatible', 'solar', 'fixture')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  secret_ciphertext TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  creator_identity_version_id TEXT REFERENCES creator_identity_versions(id),
  creator_voice_version_id TEXT REFERENCES creator_voice_versions(id),
  audience_persona_version_id TEXT REFERENCES audience_persona_versions(id),
  language TEXT NOT NULL DEFAULT 'ko',
  common_cta TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_outputs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  output_type TEXT NOT NULL CHECK (output_type IN ('naver_blog', 'short_video')),
  selected BOOLEAN NOT NULL DEFAULT true,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  error_message TEXT,
  artifact_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, output_type)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  plan_id TEXT REFERENCES plans(id),
  run_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'retrying')),
  error_message TEXT,
  created_by TEXT REFERENCES users(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  channel TEXT NOT NULL CHECK (channel IN ('naver_blog', 'short_video')),
  current_version_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'review_required', 'held', 'approved', 'exported', 'stale')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  content JSONB NOT NULL,
  created_by_run_id TEXT REFERENCES runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(artifact_id, version_no)
);
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES artifact_versions(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE plan_outputs
  ADD CONSTRAINT plan_outputs_artifact_fk
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS artifact_blocks (
  id TEXT PRIMARY KEY,
  artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  block_key TEXT NOT NULL,
  block_type TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('verified', 'review_required', 'conflict', 'not_required')),
  auto_check JSONB NOT NULL DEFAULT '{}'::jsonb,
  stale BOOLEAN NOT NULL DEFAULT false,
  held BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(artifact_version_id, block_key)
);

CREATE TABLE IF NOT EXISTS block_source_refs (
  artifact_block_id TEXT NOT NULL REFERENCES artifact_blocks(id) ON DELETE CASCADE,
  content_atom_id TEXT NOT NULL REFERENCES content_atoms(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_block_id, content_atom_id)
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  artifact_block_id TEXT NOT NULL REFERENCES artifact_blocks(id) ON DELETE CASCADE,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  verified_by TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at TIMESTAMPTZ,
  invalidation_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS active_verification_per_block
  ON verifications(artifact_block_id) WHERE invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS active_approval_per_version
  ON approvals(artifact_version_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
  target TEXT NOT NULL CHECK (target IN ('markdown', 'wordpress_draft')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  external_id TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(artifact_version_id, target),
  UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS refresh_decisions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  decision TEXT NOT NULL CHECK (decision IN ('patch', 'regenerate', 'keep')),
  affected_block_count INTEGER NOT NULL,
  acknowledged_by TEXT NOT NULL REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  dedupe_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_items_source_idx ON source_items(source_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS source_snapshots_item_idx ON source_snapshots(source_item_id, version_no DESC);
CREATE INDEX IF NOT EXISTS content_atoms_snapshot_idx ON content_atoms(snapshot_id);
CREATE INDEX IF NOT EXISTS block_source_refs_atom_idx ON block_source_refs(content_atom_id);
CREATE INDEX IF NOT EXISTS artifact_blocks_version_idx ON artifact_blocks(artifact_version_id, ordinal);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(status, available_at, created_at);
