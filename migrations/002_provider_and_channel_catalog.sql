ALTER TABLE model_provider_configs ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX one_default_model_provider_per_workspace
  ON model_provider_configs(workspace_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS channel_definition_versions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel, version_no)
);

CREATE TABLE IF NOT EXISTS workspace_channel_catalog (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_definition_version_id TEXT NOT NULL REFERENCES channel_definition_versions(id),
  active BOOLEAN NOT NULL DEFAULT true,
  default_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, channel_definition_version_id)
);

INSERT INTO channel_definition_versions (id, channel, version_no, display_name, description, schema_key) VALUES
  ('naver_blog:v1', 'naver_blog', 1, 'Naver Blog Draft', '검색 의도와 읽기 흐름을 갖춘 블로그 초안', 'naver_blog'),
  ('wordpress_article:v1', 'wordpress_article', 1, 'WordPress Article', '발행 전 승인과 WordPress draft 전송을 위한 아티클', 'wordpress_article'),
  ('newsletter:v1', 'newsletter', 1, 'Newsletter', '제목·프리헤더·모듈로 구성된 이메일 뉴스레터', 'newsletter'),
  ('instagram_carousel:v1', 'instagram_carousel', 1, 'Instagram Carousel', '슬라이드별 메시지와 시각 지시를 갖춘 캐러셀', 'instagram_carousel'),
  ('short_video:v1', 'short_video', 1, 'Short Video Script', '시간별 화면·자막·내레이션을 갖춘 짧은 영상 스크립트', 'short_video')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_channel_catalog (workspace_id, channel_definition_version_id, active)
  SELECT w.id, d.id, true FROM workspaces w CROSS JOIN channel_definition_versions d
ON CONFLICT (workspace_id, channel_definition_version_id) DO NOTHING;

ALTER TABLE plan_outputs ADD COLUMN channel_definition_version_id TEXT REFERENCES channel_definition_versions(id);
UPDATE plan_outputs SET channel_definition_version_id = output_type || ':v1' WHERE channel_definition_version_id IS NULL;
ALTER TABLE plan_outputs ALTER COLUMN channel_definition_version_id SET NOT NULL;
ALTER TABLE plan_outputs DROP CONSTRAINT plan_outputs_output_type_check;
ALTER TABLE plan_outputs ADD CONSTRAINT plan_outputs_output_type_check
  CHECK (output_type IN ('naver_blog', 'wordpress_article', 'newsletter', 'instagram_carousel', 'short_video'));

ALTER TABLE artifacts DROP CONSTRAINT artifacts_channel_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_channel_check
  CHECK (channel IN ('naver_blog', 'wordpress_article', 'newsletter', 'instagram_carousel', 'short_video'));

CREATE INDEX workspace_channel_catalog_active_idx
  ON workspace_channel_catalog(workspace_id, active);
