ALTER TABLE refresh_decisions
  ADD COLUMN base_version_id TEXT REFERENCES artifact_versions(id);

UPDATE refresh_decisions decision
SET base_version_id = COALESCE(
  (
    SELECT version.id
    FROM artifact_versions version
    WHERE version.artifact_id = decision.artifact_id
      AND version.created_at <= decision.acknowledged_at
    ORDER BY version.created_at DESC, version.version_no DESC
    LIMIT 1
  ),
  artifact.current_version_id
)
FROM artifacts artifact
WHERE artifact.id = decision.artifact_id
  AND decision.base_version_id IS NULL;

ALTER TABLE refresh_decisions
  ALTER COLUMN base_version_id SET NOT NULL;

CREATE INDEX refresh_decisions_base_version_idx
  ON refresh_decisions(base_version_id, acknowledged_at DESC);
