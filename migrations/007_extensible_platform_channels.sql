-- Platform channels are defined by immutable channel_definition_versions rows.
-- Keep the database boundary safe without enumerating every current channel in
-- a CHECK constraint, so a new versioned profile can use an existing audited
-- adapter without rewriting the core artifact tables.
ALTER TABLE plan_outputs
  DROP CONSTRAINT IF EXISTS plan_outputs_output_type_check;
ALTER TABLE plan_outputs
  ADD CONSTRAINT plan_outputs_output_type_check
  CHECK (output_type ~ '^[a-z][a-z0-9_]{1,63}$');

ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_channel_check;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_channel_check
  CHECK (channel ~ '^[a-z][a-z0-9_]{1,63}$');
