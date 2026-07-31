ALTER TABLE source_snapshot_assessments
  ADD COLUMN detector_version TEXT NOT NULL DEFAULT 'readiness.v1';

CREATE TABLE source_snapshot_assessment_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  previous_readiness TEXT,
  readiness TEXT NOT NULL
    CHECK (readiness IN ('complete', 'partial', 'incompatible', 'insufficient', 'quarantined')),
  previous_omissions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(previous_omissions) = 'array'),
  omissions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(omissions) = 'array'),
  previous_signals JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(previous_signals) = 'array'),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(signals) = 'array'),
  detector_version TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('ingestion', 'manual_reassessment')),
  requested_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX source_snapshot_assessment_events_snapshot_idx
  ON source_snapshot_assessment_events(snapshot_id, created_at DESC);
