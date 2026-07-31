ALTER TABLE sources
  ADD COLUMN rights_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (rights_status IN ('owned', 'licensed', 'unknown', 'restricted'));

ALTER TABLE source_snapshots
  ADD COLUMN ingestion_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS source_snapshot_assessments (
  snapshot_id TEXT PRIMARY KEY REFERENCES source_snapshots(id) ON DELETE CASCADE,
  readiness TEXT NOT NULL
    CHECK (readiness IN ('complete', 'partial', 'incompatible', 'insufficient', 'quarantined')),
  rights_status TEXT NOT NULL
    CHECK (rights_status IN ('owned', 'licensed', 'unknown', 'restricted')),
  usable_atom_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(usable_atom_ids) = 'array'),
  omissions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(omissions) = 'array'),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(signals) = 'array'),
  acknowledgement_required BOOLEAN NOT NULL DEFAULT false,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO source_snapshot_assessments (
  snapshot_id,
  readiness,
  rights_status,
  usable_atom_ids,
  omissions,
  signals,
  acknowledgement_required
)
SELECT
  snapshot.id,
  CASE
    WHEN count(atom.id) FILTER (WHERE atom.atom_type <> 'context') = 0 THEN 'insufficient'
    ELSE 'partial'
  END,
  source.rights_status,
  COALESCE(
    jsonb_agg(to_jsonb(atom.id) ORDER BY atom.position_label)
      FILTER (WHERE atom.id IS NOT NULL AND atom.atom_type <> 'context'),
    '[]'::jsonb
  ),
  CASE
    WHEN count(atom.id) FILTER (WHERE atom.atom_type <> 'context') = 0
      THEN '["NO_USABLE_EVIDENCE"]'::jsonb
    ELSE '["LEGACY_READINESS_UNKNOWN"]'::jsonb
  END,
  '["ASSESSMENT_BACKFILLED"]'::jsonb,
  true
FROM source_snapshots snapshot
JOIN source_items item ON item.id = snapshot.source_item_id
JOIN sources source ON source.id = item.source_id
LEFT JOIN content_atoms atom ON atom.snapshot_id = snapshot.id
GROUP BY snapshot.id, source.rights_status
ON CONFLICT (snapshot_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS source_snapshot_assessments_readiness_idx
  ON source_snapshot_assessments(readiness, assessed_at DESC);
