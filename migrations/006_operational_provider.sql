ALTER TABLE model_provider_configs
  ADD COLUMN last_test_status TEXT NOT NULL DEFAULT 'untested';
ALTER TABLE model_provider_configs
  ADD COLUMN last_tested_at TIMESTAMPTZ;
ALTER TABLE model_provider_configs
  ADD COLUMN last_test_model TEXT;
ALTER TABLE model_provider_configs
  ADD COLUMN last_test_error TEXT;
ALTER TABLE model_provider_configs
  ADD CONSTRAINT model_provider_last_test_status_check
  CHECK (last_test_status IN ('untested', 'succeeded', 'failed'));
