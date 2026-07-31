ALTER TABLE channel_definition_versions
  ADD COLUMN IF NOT EXISTS adapter_key TEXT;
ALTER TABLE channel_definition_versions
  ADD COLUMN IF NOT EXISTS profile_config JSONB;
ALTER TABLE channel_definition_versions
  ADD COLUMN IF NOT EXISTS selectable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channel_definition_versions
  ADD COLUMN IF NOT EXISTS default_active BOOLEAN NOT NULL DEFAULT false;

DROP RULE IF EXISTS channel_definition_versions_no_update ON channel_definition_versions;
DROP RULE IF EXISTS channel_definition_versions_no_delete ON channel_definition_versions;

UPDATE channel_definition_versions
SET adapter_key = 'legacy',
    profile_config = jsonb_build_object(
      'format_version', 1,
      'profile_id', id,
      'settings_schema', jsonb_build_object(
        'type', 'object',
        'additionalProperties', true,
        'required', jsonb_build_array('purpose'),
        'properties', jsonb_build_object('purpose', jsonb_build_object('type', 'string', 'minLength', 1, 'maxLength', 300))
      ),
      'output_schema', jsonb_build_object(
        'type', 'object',
        'additionalProperties', true,
        'required', jsonb_build_array()
      ),
      'prompt_policy', jsonb_build_object(
        'task', 'legacy_compatibility',
        'instructions', jsonb_build_array(
          'Preserve the original v1 channel meaning.',
          'Ground every factual block in exact source positions.',
          'Never treat automatic support as human verification.'
        )
      ),
      'rubric', jsonb_build_array(
        jsonb_build_object('key', 'grounding', 'label', '원본 근거', 'criterion', '사실 블록이 정확한 원본 위치를 참조한다.')
      ),
      'preview_modes', jsonb_build_array('structured'),
      'render_metadata', jsonb_build_object('primary_mode', 'structured', 'schema_key', schema_key),
      'repair_policy', jsonb_build_object('mode', 'bounded_retry', 'max_attempts', 1, 'retryable_issues', jsonb_build_array('schema_invalid')),
      'official_sources', jsonb_build_array(
        jsonb_build_object(
          'url',
          CASE channel
            WHEN 'naver_blog' THEN 'https://searchadvisor.naver.com/guide'
            WHEN 'wordpress_article' THEN 'https://developer.wordpress.org/rest-api/reference/posts/'
            WHEN 'newsletter' THEN 'https://www.rfc-editor.org/rfc/rfc5322'
            WHEN 'instagram_carousel' THEN 'https://developers.facebook.com/docs/instagram-platform/content-publishing'
            ELSE 'https://developers.google.com/youtube/v3/docs/videos'
          END,
          'checked_on', '2026-07-29'
        )
      )
    )
WHERE version_no = 1
  AND adapter_key IS NULL;

UPDATE channel_definition_versions
SET selectable = false,
    default_active = false
WHERE adapter_key = 'legacy';

INSERT INTO channel_definition_versions
  (id, channel, version_no, display_name, description, schema_key, adapter_key, profile_config, selectable, default_active)
VALUES
  (
    'naver_blog:v2',
    'naver_blog',
    2,
    'Naver Blog Draft',
    '검색 의도와 모바일 읽기 흐름을 갖춘 네이버 블로그 초안',
    'naver_blog_v2',
    'article',
    '{
      "format_version": 1,
      "profile_id": "naver_blog:v2",
      "settings_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["purpose"],
        "properties": {
          "purpose": {"type": "string", "minLength": 1, "maxLength": 300},
          "keyword": {"type": "string", "maxLength": 200, "default": ""},
          "readingTone": {"type": "string", "maxLength": 100, "default": "정보형"},
          "includeFaq": {"type": "boolean", "default": false}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "intro", "introSourcePositions", "sections"],
        "properties": {
          "title": {"type": "string", "minLength": 1, "maxLength": 200},
          "intro": {"type": "string", "minLength": 1, "maxLength": 1000},
          "introSourcePositions": {"type": "array", "minItems": 1, "items": {"type": "string"}},
          "sections": {"type": "array", "minItems": 2, "maxItems": 8, "items": {"type": "object", "required": ["heading", "body", "sourcePositions"]}},
          "cta": {"type": "string", "maxLength": 1000},
          "tags": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
          "identityClaims": {"type": "array", "items": {"type": "string"}}
        }
      },
      "prompt_policy": {
        "task": "reader_oriented_search_article",
        "instructions": [
          "Use a Korean reader-oriented article structure rather than a video script.",
          "Use exact source position labels for every factual introduction and section.",
          "Use Creator Identity claims only when they exactly match locked evidence."
        ]
      },
      "rubric": [
        {"key": "grounding", "label": "원본 근거", "criterion": "모든 사실 단락이 정확한 원본 위치에 연결된다."},
        {"key": "search_intent", "label": "검색 의도", "criterion": "제목과 구조가 설정된 검색 의도에 직접 답한다."},
        {"key": "readability", "label": "읽기 흐름", "criterion": "모바일에서 훑어볼 수 있는 제목과 단락 흐름을 갖춘다."}
      ],
      "preview_modes": ["article", "outline", "source_links"],
      "render_metadata": {"primary_mode": "article", "block_strategy": "heading_sections", "export_format": "markdown"},
      "repair_policy": {"mode": "bounded_retry", "max_attempts": 2, "retryable_issues": ["schema_invalid", "missing_source_positions"]},
      "official_sources": [{"url": "https://searchadvisor.naver.com/guide", "checked_on": "2026-07-29"}]
    }'::jsonb,
    true,
    true
  ),
  (
    'wordpress_article:v2',
    'wordpress_article',
    2,
    'WordPress Article',
    '승인 후 WordPress draft 전송을 위한 편집 아티클',
    'wordpress_article_v2',
    'article',
    '{
      "format_version": 1,
      "profile_id": "wordpress_article:v2",
      "settings_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["purpose"],
        "properties": {
          "purpose": {"type": "string", "minLength": 1, "maxLength": 300},
          "angle": {"type": "string", "maxLength": 200, "default": "실행 가이드"},
          "includeFaq": {"type": "boolean", "default": false}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "excerpt", "intro", "introSourcePositions", "sections"],
        "properties": {
          "title": {"type": "string", "minLength": 1, "maxLength": 200},
          "excerpt": {"type": "string", "minLength": 1, "maxLength": 500},
          "intro": {"type": "string", "minLength": 1, "maxLength": 1000},
          "introSourcePositions": {"type": "array", "minItems": 1, "items": {"type": "string"}},
          "sections": {"type": "array", "minItems": 2, "maxItems": 10, "items": {"type": "object", "required": ["heading", "body", "sourcePositions"]}},
          "cta": {"type": "string", "maxLength": 1000},
          "identityClaims": {"type": "array", "items": {"type": "string"}}
        }
      },
      "prompt_policy": {
        "task": "editorial_web_article",
        "instructions": [
          "Create an editorial web article with an excerpt and practical introduction.",
          "Ground factual sections in exact source position labels.",
          "Do not include publishing credentials or WordPress API instructions."
        ]
      },
      "rubric": [
        {"key": "grounding", "label": "원본 근거", "criterion": "사실 단락이 정확한 원본 위치에 연결된다."},
        {"key": "editorial_structure", "label": "편집 구조", "criterion": "요약, 도입, 본문이 중복 없이 독자의 결정을 돕는다."},
        {"key": "draft_boundary", "label": "초안 경계", "criterion": "외부 발행이 아닌 승인 가능한 초안으로 완결된다."}
      ],
      "preview_modes": ["article", "outline", "wordpress_draft"],
      "render_metadata": {"primary_mode": "article", "block_strategy": "heading_sections", "export_format": "wordpress_draft"},
      "repair_policy": {"mode": "bounded_retry", "max_attempts": 2, "retryable_issues": ["schema_invalid", "missing_source_positions"]},
      "official_sources": [{"url": "https://developer.wordpress.org/rest-api/reference/posts/", "checked_on": "2026-07-29"}]
    }'::jsonb,
    true,
    true
  ),
  (
    'newsletter:v2',
    'newsletter',
    2,
    'Newsletter',
    '제목·프리헤더·모듈로 구성된 이메일 뉴스레터',
    'newsletter_v2',
    'email',
    '{
      "format_version": 1,
      "profile_id": "newsletter:v2",
      "settings_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["purpose"],
        "properties": {
          "purpose": {"type": "string", "minLength": 1, "maxLength": 300},
          "cadence": {"type": "string", "maxLength": 50, "default": "주간"},
          "includePreamble": {"type": "boolean", "default": true}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["subject", "preheader", "opening", "openingSourcePositions", "modules"],
        "properties": {
          "subject": {"type": "string", "minLength": 1, "maxLength": 120},
          "preheader": {"type": "string", "minLength": 1, "maxLength": 200},
          "opening": {"type": "string", "minLength": 1, "maxLength": 1000},
          "openingSourcePositions": {"type": "array", "minItems": 1, "items": {"type": "string"}},
          "modules": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "object", "required": ["heading", "body", "sourcePositions"]}},
          "cta": {"type": "string", "maxLength": 1000},
          "identityClaims": {"type": "array", "items": {"type": "string"}}
        }
      },
      "prompt_policy": {
        "task": "inbox_newsletter",
        "instructions": [
          "Write an inbox-ready subject, preheader, opening, and concise modules.",
          "Ground factual modules in exact source position labels.",
          "Keep the result distinct from an article or video script."
        ]
      },
      "rubric": [
        {"key": "grounding", "label": "원본 근거", "criterion": "사실 모듈이 정확한 원본 위치에 연결된다."},
        {"key": "inbox_context", "label": "수신함 맥락", "criterion": "제목과 프리헤더가 함께 핵심 가치를 전달한다."},
        {"key": "scanability", "label": "훑어보기", "criterion": "각 모듈이 짧고 독립적으로 이해된다."}
      ],
      "preview_modes": ["email", "plain_text", "source_links"],
      "render_metadata": {"primary_mode": "email", "block_strategy": "message_modules", "export_format": "email_draft"},
      "repair_policy": {"mode": "bounded_retry", "max_attempts": 2, "retryable_issues": ["schema_invalid", "missing_source_positions"]},
      "official_sources": [{"url": "https://www.rfc-editor.org/rfc/rfc5322", "checked_on": "2026-07-29"}]
    }'::jsonb,
    true,
    true
  ),
  (
    'instagram_carousel:v2',
    'instagram_carousel',
    2,
    'Instagram Carousel',
    '슬라이드별 메시지와 시각 지시를 갖춘 인스타그램 캐러셀',
    'instagram_carousel_v2',
    'card_sequence',
    '{
      "format_version": 1,
      "profile_id": "instagram_carousel:v2",
      "settings_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["purpose"],
        "properties": {
          "purpose": {"type": "string", "minLength": 1, "maxLength": 300},
          "slideCount": {"type": "integer", "minimum": 3, "maximum": 10, "default": 6},
          "visualDirection": {"type": "string", "maxLength": 200, "default": "간결한 정보 카드"}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["coverHook", "coverSourcePositions", "slides"],
        "properties": {
          "coverHook": {"type": "string", "minLength": 1, "maxLength": 300},
          "coverSourcePositions": {"type": "array", "minItems": 1, "items": {"type": "string"}},
          "slides": {"type": "array", "minItems": 3, "maxItems": 10, "items": {"type": "object", "required": ["headline", "body", "visualDirection", "sourcePositions"]}},
          "caption": {"type": "string", "maxLength": 2200},
          "hashtags": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
          "identityClaims": {"type": "array", "items": {"type": "string"}}
        }
      },
      "prompt_policy": {
        "task": "swipeable_card_sequence",
        "instructions": [
          "Create a cover hook followed by a coherent swipe sequence.",
          "Give each slide a concrete visual direction and exact factual source positions.",
          "Do not merely split an article by length."
        ]
      },
      "rubric": [
        {"key": "grounding", "label": "원본 근거", "criterion": "사실 슬라이드가 정확한 원본 위치에 연결된다."},
        {"key": "sequence", "label": "슬라이드 흐름", "criterion": "표지부터 결론까지 한 장씩 논리가 진전된다."},
        {"key": "visual_direction", "label": "시각 지시", "criterion": "각 슬라이드에 구현 가능한 시각 지시가 있다."}
      ],
      "preview_modes": ["carousel", "slide_list", "source_links"],
      "render_metadata": {"primary_mode": "carousel", "block_strategy": "ordered_cards", "aspect_ratio": "4:5"},
      "repair_policy": {"mode": "bounded_retry", "max_attempts": 2, "retryable_issues": ["schema_invalid", "missing_source_positions", "missing_visual_direction"]},
      "official_sources": [{"url": "https://developers.facebook.com/docs/instagram-platform/content-publishing", "checked_on": "2026-07-29"}]
    }'::jsonb,
    true,
    true
  ),
  (
    'youtube_shorts:v1',
    'youtube_shorts',
    1,
    'YouTube Shorts',
    '화면·자막·내레이션·시간 구간을 갖춘 YouTube Shorts 제작안',
    'timed_vertical_video_v1',
    'timed_vertical_video',
    '{
      "format_version": 1,
      "profile_id": "youtube_shorts:v1",
      "settings_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["purpose"],
        "properties": {
          "purpose": {"type": "string", "minLength": 1, "maxLength": 300},
          "targetSeconds": {"type": "integer", "minimum": 15, "maximum": 180, "default": 45},
          "visualStyle": {"type": "string", "maxLength": 100, "default": "정보 카드"},
          "includeCaptions": {"type": "boolean", "default": true}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["hook", "hookSourcePositions", "scenes", "ending"],
        "properties": {
          "hook": {"type": "string", "minLength": 1, "maxLength": 1000},
          "hookSourcePositions": {"type": "array", "minItems": 1, "items": {"type": "string"}},
          "scenes": {"type": "array", "minItems": 1, "maxItems": 30, "items": {"type": "object", "required": ["durationSeconds", "visual", "onScreenText", "narration", "sourcePositions"]}},
          "ending": {"type": "string", "minLength": 1, "maxLength": 1000},
          "caption": {"type": "string", "maxLength": 2200},
          "identityClaims": {"type": "array", "items": {"type": "string"}}
        }
      },
      "prompt_policy": {
        "task": "youtube_shorts_production_script",
        "instructions": [
          "Create a timed vertical-video sequence with spoken narration, on-screen text, and visual direction.",
          "Ground every factual hook and scene in exact source position labels.",
          "Make the opening understandable without fabricating creator experience."
        ]
      },
      "rubric": [
        {"key": "grounding", "label": "원본 근거", "criterion": "사실 장면이 정확한 원본 위치에 연결된다."},
        {"key": "timing", "label": "시간 구성", "criterion": "장면 시간이 목표 길이에 맞고 과밀하지 않다."},
        {"key": "audiovisual", "label": "화면과 음성", "criterion": "자막, 내레이션, 화면 지시가 역할을 나눠 수행한다."}
      ],
      "preview_modes": ["vertical_video", "timeline", "source_links"],
      "render_metadata": {"primary_mode": "vertical_video", "block_strategy": "timed_scenes", "aspect_ratio": "9:16", "platform": "youtube_shorts"},
      "repair_policy": {"mode": "bounded_retry", "max_attempts": 2, "retryable_issues": ["schema_invalid", "missing_source_positions", "duration_out_of_range"]},
      "official_sources": [{"url": "https://developers.google.com/youtube/v3/docs/videos", "checked_on": "2026-07-29"}]
    }'::jsonb,
    true,
    true
  ),
  (
    'instagram_reels:v1',
    'instagram_reels',
    1,
    'Instagram Reels',
    '화면·자막·내레이션·시간 구간을 갖춘 Instagram Reels 제작안',
    'timed_vertical_video_v1',
    'timed_vertical_video',
    '{
      "format_version": 1,
      "profile_id": "instagram_reels:v1",
      "settings_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["purpose"],
        "properties": {
          "purpose": {"type": "string", "minLength": 1, "maxLength": 300},
          "targetSeconds": {"type": "integer", "minimum": 15, "maximum": 90, "default": 30},
          "visualStyle": {"type": "string", "maxLength": 100, "default": "정보 카드"},
          "includeCaptions": {"type": "boolean", "default": true}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["hook", "hookSourcePositions", "scenes", "ending"],
        "properties": {
          "hook": {"type": "string", "minLength": 1, "maxLength": 1000},
          "hookSourcePositions": {"type": "array", "minItems": 1, "items": {"type": "string"}},
          "scenes": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object", "required": ["durationSeconds", "visual", "onScreenText", "narration", "sourcePositions"]}},
          "ending": {"type": "string", "minLength": 1, "maxLength": 1000},
          "caption": {"type": "string", "maxLength": 2200},
          "identityClaims": {"type": "array", "items": {"type": "string"}}
        }
      },
      "prompt_policy": {
        "task": "instagram_reels_production_script",
        "instructions": [
          "Create a concise vertical-video sequence with a strong visual opening.",
          "Ground every factual hook and scene in exact source position labels.",
          "Keep caption copy separate from spoken narration."
        ]
      },
      "rubric": [
        {"key": "grounding", "label": "원본 근거", "criterion": "사실 장면이 정확한 원본 위치에 연결된다."},
        {"key": "opening", "label": "첫 장면", "criterion": "첫 장면이 소리 없이도 핵심 맥락을 전달한다."},
        {"key": "audiovisual", "label": "화면과 음성", "criterion": "자막, 내레이션, 화면 지시가 역할을 나눠 수행한다."}
      ],
      "preview_modes": ["vertical_video", "timeline", "caption"],
      "render_metadata": {"primary_mode": "vertical_video", "block_strategy": "timed_scenes", "aspect_ratio": "9:16", "platform": "instagram_reels"},
      "repair_policy": {"mode": "bounded_retry", "max_attempts": 2, "retryable_issues": ["schema_invalid", "missing_source_positions", "duration_out_of_range"]},
      "official_sources": [{"url": "https://developers.facebook.com/docs/instagram-platform/content-publishing", "checked_on": "2026-07-29"}]
    }'::jsonb,
    true,
    true
  ),
  (
    'tiktok_video:v1',
    'tiktok_video',
    1,
    'TikTok Video',
    '화면·자막·내레이션·시간 구간을 갖춘 TikTok 영상 제작안',
    'timed_vertical_video_v1',
    'timed_vertical_video',
    '{
      "format_version": 1,
      "profile_id": "tiktok_video:v1",
      "settings_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["purpose"],
        "properties": {
          "purpose": {"type": "string", "minLength": 1, "maxLength": 300},
          "targetSeconds": {"type": "integer", "minimum": 15, "maximum": 180, "default": 30},
          "visualStyle": {"type": "string", "maxLength": 100, "default": "정보 카드"},
          "includeCaptions": {"type": "boolean", "default": true}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["hook", "hookSourcePositions", "scenes", "ending"],
        "properties": {
          "hook": {"type": "string", "minLength": 1, "maxLength": 1000},
          "hookSourcePositions": {"type": "array", "minItems": 1, "items": {"type": "string"}},
          "scenes": {"type": "array", "minItems": 1, "maxItems": 30, "items": {"type": "object", "required": ["durationSeconds", "visual", "onScreenText", "narration", "sourcePositions"]}},
          "ending": {"type": "string", "minLength": 1, "maxLength": 1000},
          "caption": {"type": "string", "maxLength": 2200},
          "identityClaims": {"type": "array", "items": {"type": "string"}}
        }
      },
      "prompt_policy": {
        "task": "tiktok_vertical_video_script",
        "instructions": [
          "Create a direct vertical-video sequence with an immediately legible premise.",
          "Ground every factual hook and scene in exact source position labels.",
          "Do not imply automatic publishing or creator credentials."
        ]
      },
      "rubric": [
        {"key": "grounding", "label": "원본 근거", "criterion": "사실 장면이 정확한 원본 위치에 연결된다."},
        {"key": "premise", "label": "즉시성", "criterion": "첫 장면에서 영상의 전제와 이익이 명확하다."},
        {"key": "audiovisual", "label": "화면과 음성", "criterion": "자막, 내레이션, 화면 지시가 역할을 나눠 수행한다."}
      ],
      "preview_modes": ["vertical_video", "timeline", "caption"],
      "render_metadata": {"primary_mode": "vertical_video", "block_strategy": "timed_scenes", "aspect_ratio": "9:16", "platform": "tiktok"},
      "repair_policy": {"mode": "bounded_retry", "max_attempts": 2, "retryable_issues": ["schema_invalid", "missing_source_positions", "duration_out_of_range"]},
      "official_sources": [{"url": "https://developers.tiktok.com/products/content-posting-api", "checked_on": "2026-07-29"}]
    }'::jsonb,
    true,
    true
  )
ON CONFLICT (id) DO NOTHING;

-- The executable adapters consume visible-text objects. Keep that persisted
-- candidate contract beside the profile so prompts, validation and audits all
-- refer to the same immutable shape instead of the legacy string/position pair.
UPDATE channel_definition_versions
SET profile_config = jsonb_set(
  jsonb_set(
    profile_config,
    '{candidate_contract_version}',
    '"visible-text.v1"'::jsonb,
    true
  ),
  '{output_schema}',
  CASE id
    WHEN 'naver_blog:v2' THEN '{
      "type":"object","additionalProperties":false,
      "required":["title","intro","sections","faq","cta","tags"],
      "properties":{
        "title":{"$ref":"#/$defs/factualText"},
        "intro":{"$ref":"#/$defs/factualText"},
        "sections":{"type":"array","minItems":2,"maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["heading","body"],"properties":{"heading":{"$ref":"#/$defs/factualText"},"body":{"$ref":"#/$defs/factualText"}}}},
        "faq":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["question","answer"],"properties":{"question":{"$ref":"#/$defs/factualText"},"answer":{"$ref":"#/$defs/factualText"}}}},
        "cta":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/editorialText"}]},
        "tags":{"type":"array","maxItems":20,"items":{"$ref":"#/$defs/factualText"}}
      },
      "$defs":{
        "factualText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"factual"},"atomRefs":{"type":"array","minItems":1,"items":{"type":"string"}}}},
        "editorialText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"editorial"},"atomRefs":{"type":"array","maxItems":0}}}
      }
    }'::jsonb
    WHEN 'wordpress_article:v2' THEN '{
      "type":"object","additionalProperties":false,
      "required":["title","excerpt","intro","sections","faq","cta","imageAltGuidance"],
      "properties":{
        "title":{"$ref":"#/$defs/factualText"},
        "excerpt":{"$ref":"#/$defs/factualText"},
        "intro":{"$ref":"#/$defs/factualText"},
        "sections":{"type":"array","minItems":2,"maxItems":10,"items":{"type":"object","additionalProperties":false,"required":["heading","body","headingLevel"],"properties":{"heading":{"$ref":"#/$defs/factualText"},"body":{"$ref":"#/$defs/factualText"},"headingLevel":{"type":"integer","enum":[2,3]}}}},
        "faq":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["question","answer"],"properties":{"question":{"$ref":"#/$defs/factualText"},"answer":{"$ref":"#/$defs/factualText"}}}},
        "cta":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/editorialText"}]},
        "imageAltGuidance":{"$ref":"#/$defs/productionText"}
      },
      "$defs":{
        "factualText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"factual"},"atomRefs":{"type":"array","minItems":1,"items":{"type":"string"}}}},
        "editorialText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"editorial"},"atomRefs":{"type":"array","maxItems":0}}},
        "productionText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"production"},"atomRefs":{"type":"array","maxItems":0}}}
      }
    }'::jsonb
    WHEN 'newsletter:v2' THEN '{
      "type":"object","additionalProperties":false,
      "required":["subject","preheader","opening","modules","cta"],
      "properties":{
        "subject":{"$ref":"#/$defs/factualText"},
        "preheader":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/factualText"}]},
        "opening":{"$ref":"#/$defs/factualText"},
        "modules":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["heading","body"],"properties":{"heading":{"$ref":"#/$defs/factualText"},"body":{"$ref":"#/$defs/factualText"}}}},
        "cta":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/editorialText"}]}
      },
      "$defs":{
        "factualText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"factual"},"atomRefs":{"type":"array","minItems":1,"items":{"type":"string"}}}},
        "editorialText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"editorial"},"atomRefs":{"type":"array","maxItems":0}}}
      }
    }'::jsonb
    WHEN 'instagram_carousel:v2' THEN '{
      "type":"object","additionalProperties":false,
      "required":["cover","slides","caption","hashtags"],
      "properties":{
        "cover":{"$ref":"#/$defs/factualText"},
        "slides":{"type":"array","minItems":3,"maxItems":10,"items":{"type":"object","additionalProperties":false,"required":["headline","body","visualDirection","altText"],"properties":{"headline":{"$ref":"#/$defs/factualText"},"body":{"$ref":"#/$defs/factualText"},"visualDirection":{"$ref":"#/$defs/productionText"},"altText":{"$ref":"#/$defs/productionText"}}}},
        "caption":{"$ref":"#/$defs/factualText"},
        "hashtags":{"type":"array","maxItems":20,"items":{"$ref":"#/$defs/factualText"}}
      },
      "$defs":{
        "factualText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"factual"},"atomRefs":{"type":"array","minItems":1,"items":{"type":"string"}}}},
        "productionText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"production"},"atomRefs":{"type":"array","maxItems":0}}}
      }
    }'::jsonb
    ELSE '{
      "type":"object","additionalProperties":false,
      "required":["title","hook","scenes","ending","caption","coverText"],
      "properties":{
        "title":{"$ref":"#/$defs/factualText"},
        "hook":{"$ref":"#/$defs/factualText"},
        "scenes":{"type":"array","minItems":3,"maxItems":12,"items":{"type":"object","additionalProperties":false,"required":["durationSeconds","narration","onScreenText","visualDirection","safeZoneNote"],"properties":{"durationSeconds":{"type":"number","exclusiveMinimum":0,"maximum":20},"narration":{"$ref":"#/$defs/factualText"},"onScreenText":{"$ref":"#/$defs/factualText"},"visualDirection":{"$ref":"#/$defs/productionText"},"safeZoneNote":{"$ref":"#/$defs/productionText"}}}},
        "ending":{"$ref":"#/$defs/factualText"},
        "caption":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/factualText"}]},
        "coverText":{"$ref":"#/$defs/factualText"}
      },
      "$defs":{
        "factualText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"factual"},"atomRefs":{"type":"array","minItems":1,"items":{"type":"string"}}}},
        "productionText":{"type":"object","additionalProperties":false,"required":["text","kind","atomRefs"],"properties":{"text":{"type":"string","minLength":1},"kind":{"const":"production"},"atomRefs":{"type":"array","maxItems":0}}}
      }
    }'::jsonb
  END,
  true
)
WHERE id IN (
  'naver_blog:v2',
  'wordpress_article:v2',
  'newsletter:v2',
  'instagram_carousel:v2',
  'youtube_shorts:v1',
  'instagram_reels:v1',
  'tiktok_video:v1'
);

ALTER TABLE channel_definition_versions
  ALTER COLUMN adapter_key SET NOT NULL;
ALTER TABLE channel_definition_versions
  ALTER COLUMN profile_config SET NOT NULL;
ALTER TABLE channel_definition_versions
  DROP CONSTRAINT IF EXISTS channel_definition_versions_adapter_key_check;
ALTER TABLE channel_definition_versions
  ADD CONSTRAINT channel_definition_versions_adapter_key_check
  CHECK (adapter_key IN ('legacy', 'article', 'email', 'card_sequence', 'timed_vertical_video'));
ALTER TABLE channel_definition_versions
  DROP CONSTRAINT IF EXISTS channel_definition_versions_profile_config_check;
ALTER TABLE channel_definition_versions
  ADD CONSTRAINT channel_definition_versions_profile_config_check
  CHECK (jsonb_typeof(profile_config) = 'object');

ALTER TABLE workspace_channel_catalog
  ADD COLUMN IF NOT EXISTS channel TEXT;
UPDATE workspace_channel_catalog AS catalog
SET channel = definition.channel
FROM channel_definition_versions AS definition
WHERE catalog.channel_definition_version_id = definition.id
  AND catalog.channel IS NULL;
ALTER TABLE workspace_channel_catalog
  ALTER COLUMN channel SET NOT NULL;

UPDATE workspace_channel_catalog
SET channel_definition_version_id = channel || ':v2',
    updated_at = now()
WHERE channel IN ('naver_blog', 'wordpress_article', 'newsletter', 'instagram_carousel')
  AND channel_definition_version_id = channel || ':v1';

ALTER TABLE workspace_channel_catalog
  DROP CONSTRAINT IF EXISTS workspace_channel_catalog_pkey;
ALTER TABLE workspace_channel_catalog
  ADD CONSTRAINT workspace_channel_catalog_pkey PRIMARY KEY (workspace_id, channel);

INSERT INTO workspace_channel_catalog
  (workspace_id, channel, channel_definition_version_id, active, default_settings, updated_at)
SELECT
  legacy.workspace_id,
  target.channel,
  target.id,
  legacy.active,
  legacy.default_settings,
  legacy.updated_at
FROM workspace_channel_catalog AS legacy
CROSS JOIN channel_definition_versions AS target
WHERE legacy.channel = 'short_video'
  AND target.channel IN ('youtube_shorts', 'instagram_reels', 'tiktok_video')
  AND target.selectable = true
ON CONFLICT (workspace_id, channel) DO NOTHING;

UPDATE workspace_channel_catalog
SET active = false,
    updated_at = now()
WHERE channel = 'short_video';

ALTER TABLE plan_outputs
  DROP CONSTRAINT IF EXISTS plan_outputs_output_type_check;
ALTER TABLE plan_outputs
  ADD CONSTRAINT plan_outputs_output_type_check
  CHECK (output_type IN (
    'naver_blog',
    'wordpress_article',
    'newsletter',
    'instagram_carousel',
    'youtube_shorts',
    'instagram_reels',
    'tiktok_video',
    'short_video'
  ));

ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_channel_check;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_channel_check
  CHECK (channel IN (
    'naver_blog',
    'wordpress_article',
    'newsletter',
    'instagram_carousel',
    'youtube_shorts',
    'instagram_reels',
    'tiktok_video',
    'short_video'
  ));

ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS channel_definition_version_id TEXT REFERENCES channel_definition_versions(id);
UPDATE artifact_versions AS version
SET channel_definition_version_id = artifact.channel || ':v1'
FROM artifacts AS artifact
WHERE version.artifact_id = artifact.id
  AND version.channel_definition_version_id IS NULL;
ALTER TABLE artifact_versions
  ALTER COLUMN channel_definition_version_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_channel_catalog_active_idx
  ON workspace_channel_catalog(workspace_id, active);
CREATE INDEX IF NOT EXISTS artifact_versions_channel_definition_idx
  ON artifact_versions(channel_definition_version_id);

CREATE OR REPLACE RULE channel_definition_versions_no_update AS
  ON UPDATE TO channel_definition_versions DO INSTEAD NOTHING;
CREATE OR REPLACE RULE channel_definition_versions_no_delete AS
  ON DELETE TO channel_definition_versions DO INSTEAD NOTHING;
