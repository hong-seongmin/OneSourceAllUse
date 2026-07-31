import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteDatabase, migrate } from '../apps/shared/db.js';
import {
  SELECTABLE_PLATFORM_PROFILE_IDS,
  loadPlatformProfile,
  normalizeProfileSettings,
  platformProfileContracts,
  validatePlatformProfile
} from '../apps/shared/channel-registry.js';
import {
  activeChannelCatalog,
  channelName,
  ensureWorkspaceChannelCatalog,
  setChannelActive,
  workspaceChannelCatalog
} from '../apps/shared/channels.js';
import {
  channelPlannerFieldset,
  planOutputsFromRequest
} from '../apps/web/server.js';
import { artifactMarkdown } from '../apps/shared/export.js';
import { resolvePlatformAdapter } from '../apps/shared/platform-adapters.js';

async function migrationSql(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

async function executeSqlFile(db, name) {
  const sql = await migrationSql(name);
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
    await db.query(statement);
  }
}

async function database(t) {
  const pglite = new PGlite();
  const db = createPgliteDatabase(pglite);
  t.after(() => db.close());
  return db;
}

test('migration preserves legacy data, backfills immutable versions, and is idempotent', async (t) => {
  const db = await database(t);
  await executeSqlFile(db, '001_initial.sql');
  await executeSqlFile(db, '002_provider_and_channel_catalog.sql');

  await db.query("INSERT INTO workspaces (id, name) VALUES ('workspace-before-v3', '기존 작업공간')");
  await db.query(`INSERT INTO users (id, workspace_id, email, password_hash, role)
    VALUES ('user-before-v3', 'workspace-before-v3', 'before@example.com', 'hash', 'administrator')`);
  await db.query(`INSERT INTO workspace_channel_catalog
      (workspace_id, channel_definition_version_id, active, default_settings)
    SELECT 'workspace-before-v3', id, true, jsonb_build_object('keptFrom', id)
    FROM channel_definition_versions`);
  await db.query(`UPDATE workspace_channel_catalog SET active=false
    WHERE workspace_id='workspace-before-v3' AND channel_definition_version_id='newsletter:v1'`);
  await db.query(`UPDATE workspace_channel_catalog SET active=false
    WHERE workspace_id='workspace-before-v3' AND channel_definition_version_id='short_video:v1'`);

  await db.query(`INSERT INTO sources (id, workspace_id, name, connector_type, created_by)
    VALUES ('source-before-v3', 'workspace-before-v3', '원본', 'rss', 'user-before-v3')`);
  await db.query(`INSERT INTO source_items (id, source_id, external_key, title)
    VALUES ('item-before-v3', 'source-before-v3', 'external', '기존 원본')`);
  await db.query(`INSERT INTO source_snapshots (id, source_item_id, version_no, content_hash, title, body)
    VALUES ('snapshot-before-v3', 'item-before-v3', 1, 'hash-before-v3', '기존 원본', '본문')`);
  await db.query(`INSERT INTO artifacts (id, workspace_id, source_item_id, channel, state, created_by)
    VALUES ('artifact-before-v3', 'workspace-before-v3', 'item-before-v3', 'naver_blog', 'draft', 'user-before-v3')`);
  await db.query(`INSERT INTO artifact_versions (id, artifact_id, version_no, source_snapshot_id, content)
    VALUES ('artifact-version-before-v3', 'artifact-before-v3', 1, 'snapshot-before-v3', '{"title":"수정하지 않을 내용"}'::jsonb)`);

  await executeSqlFile(db, '003_platform_profile_versions.sql');
  await executeSqlFile(db, '003_platform_profile_versions.sql');

  const counts = (await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE selectable)::int AS selectable
    FROM channel_definition_versions`))[0];
  assert.deepEqual(counts, { total: 12, selectable: 7 });

  const oldProfiles = await db.query(`SELECT id, adapter_key, selectable, default_active
    FROM channel_definition_versions WHERE id LIKE '%:v1' AND channel IN
      ('naver_blog', 'wordpress_article', 'newsletter', 'instagram_carousel', 'short_video')
    ORDER BY id`);
  assert.equal(oldProfiles.length, 5);
  assert.ok(oldProfiles.every((row) => row.adapter_key === 'legacy' && row.selectable === false && row.default_active === false));

  const preserved = await db.query(`SELECT channel, channel_definition_version_id, active,
      default_settings->>'keptFrom' AS kept_from
    FROM workspace_channel_catalog WHERE workspace_id='workspace-before-v3' ORDER BY channel`);
  assert.equal(preserved.length, 8);
  for (const channel of ['naver_blog', 'wordpress_article', 'newsletter', 'instagram_carousel']) {
    const row = preserved.find((entry) => entry.channel === channel);
    assert.equal(row.channel_definition_version_id, `${channel}:v2`);
    assert.equal(row.kept_from, `${channel}:v1`);
  }
  assert.equal(preserved.find((row) => row.channel === 'newsletter').active, false);
  for (const channel of ['youtube_shorts', 'instagram_reels', 'tiktok_video']) {
    const row = preserved.find((entry) => entry.channel === channel);
    assert.equal(row.active, false, `${channel} inherits the old short-video active state`);
    assert.equal(row.kept_from, 'short_video:v1');
  }
  assert.equal(preserved.find((row) => row.channel === 'short_video').active, false);

  const historicalVersion = (await db.query(`SELECT channel_definition_version_id, content
    FROM artifact_versions WHERE id='artifact-version-before-v3'`))[0];
  assert.equal(historicalVersion.channel_definition_version_id, 'naver_blog:v1');
  assert.deepEqual(historicalVersion.content, { title: '수정하지 않을 내용' });

  await db.query("UPDATE channel_definition_versions SET description='변조' WHERE id='naver_blog:v2'");
  await db.query("DELETE FROM channel_definition_versions WHERE id='naver_blog:v2'");
  const immutable = (await db.query("SELECT description FROM channel_definition_versions WHERE id='naver_blog:v2'"))[0];
  assert.equal(immutable.description, '검색 의도와 모바일 읽기 흐름을 갖춘 네이버 블로그 초안');

  await assert.rejects(
    db.query(`INSERT INTO workspace_channel_catalog
      (workspace_id, channel, channel_definition_version_id)
      VALUES ('workspace-before-v3', 'naver_blog', 'naver_blog:v1')`),
    /duplicate key|unique constraint/i
  );
});

test('new workspaces get seven active selectable profiles while legacy stays hidden', async (t) => {
  const db = await database(t);
  await migrate(db, process.cwd());
  await migrate(db, process.cwd());
  await db.query("INSERT INTO workspaces (id, name) VALUES ('workspace-new', '새 작업공간')");

  await ensureWorkspaceChannelCatalog(db, 'workspace-new');
  await ensureWorkspaceChannelCatalog(db, 'workspace-new');
  const catalog = await workspaceChannelCatalog(db, 'workspace-new');
  const active = await activeChannelCatalog(db, 'workspace-new');

  assert.deepEqual(catalog.map((row) => row.id).sort(), [...SELECTABLE_PLATFORM_PROFILE_IDS].sort());
  assert.equal(active.length, 7);
  assert.ok(active.every((row) => row.active && row.selectable));
  assert.equal(catalog.some((row) => row.channel === 'short_video'), false);
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM workspace_channel_catalog
    WHERE workspace_id='workspace-new'`))[0].count, 7);

  assert.equal(channelName('youtube_shorts'), 'YouTube Shorts');
  assert.equal(channelName('instagram_reels'), 'Instagram Reels');
  assert.equal(channelName('tiktok_video'), 'TikTok Video');
  assert.equal(channelName('short_video'), 'Short Video Script');
});

test('catalog activation is dynamic and never auto-upgrades an existing channel profile', async (t) => {
  const db = await database(t);
  await migrate(db, process.cwd());
  await db.query("INSERT INTO workspaces (id, name) VALUES ('workspace-pin', '버전 고정')");
  await ensureWorkspaceChannelCatalog(db, 'workspace-pin');

  const v2 = (await db.query("SELECT * FROM channel_definition_versions WHERE id='naver_blog:v2'"))[0];
  await db.query(`INSERT INTO channel_definition_versions
      (id, channel, version_no, display_name, description, schema_key, adapter_key, profile_config, selectable, default_active)
    VALUES ('naver_blog:v99', 'naver_blog', 99, $1, $2, $3, 'article', $4::jsonb, true, true)`, [
    v2.display_name,
    v2.description,
    v2.schema_key,
    JSON.stringify({ ...v2.profile_config, profile_id: 'naver_blog:v99' })
  ]);

  await ensureWorkspaceChannelCatalog(db, 'workspace-pin');
  const pinned = await db.query(`SELECT channel_definition_version_id FROM workspace_channel_catalog
    WHERE workspace_id='workspace-pin' AND channel='naver_blog'`);
  assert.deepEqual(pinned, [{ channel_definition_version_id: 'naver_blog:v2' }]);

  const disabled = await setChannelActive(db, { workspaceId: 'workspace-pin', channel: 'naver_blog', active: false });
  assert.deepEqual(disabled, {
    channel: 'naver_blog',
    active: false,
    channelDefinitionVersionId: 'naver_blog:v2'
  });
  assert.equal((await activeChannelCatalog(db, 'workspace-pin')).some((row) => row.channel === 'naver_blog'), false);
  await assert.rejects(
    setChannelActive(db, { workspaceId: 'workspace-pin', channel: 'short_video', active: true }),
    (error) => error.code === 'UNSUPPORTED_OUTPUT'
  );
});

test('registry validates declarative profiles and exposes normalization, prompt, and render contracts', async (t) => {
  const db = await database(t);
  await migrate(db, process.cwd());

  for (const profileId of SELECTABLE_PLATFORM_PROFILE_IDS) {
    const profile = await loadPlatformProfile(db, profileId);
    const contracts = platformProfileContracts(profile);
    assert.equal(contracts.profileId, profileId);
    assert.equal(contracts.adapterKey, profile.adapterKey);
    assert.equal(contracts.candidateContractVersion, 'visible-text.v1');
    assert.ok(contracts.outputSchema.$defs?.factualText);
    assert.ok(contracts.promptPolicy.instructions.length > 0);
    assert.ok(contracts.rubric.length > 0);
    assert.ok(contracts.previewModes.includes(contracts.renderMetadata.primary_mode));
    assert.ok(contracts.metadata.officialSources.every((source) => source.url.startsWith('https://') && /^\d{4}-\d{2}-\d{2}$/.test(source.checked_on)));
    assert.equal(normalizeProfileSettings(profile, { purpose: '  원본을 채널에 맞게 설명  ' }).purpose, '원본을 채널에 맞게 설명');
  }

  const naver = (await db.query("SELECT * FROM channel_definition_versions WHERE id='naver_blog:v2'"))[0];
  assert.throws(
    () => validatePlatformProfile({ ...naver, adapter_key: 'eval_javascript' }),
    (error) => error.code === 'UNKNOWN_PROFILE_ADAPTER'
  );
  assert.throws(
    () => validatePlatformProfile({ ...naver, id: '../naver:v999', profile_config: { ...naver.profile_config, profile_id: '../naver:v999' } }),
    (error) => error.code === 'INVALID_PLATFORM_PROFILE'
  );
  assert.throws(
    () => validatePlatformProfile({
      ...naver,
      profile_config: {
        ...naver.profile_config,
        official_sources: [{ url: 'javascript:alert(1)', checked_on: '2026-07-29' }]
      }
    }),
    (error) => error.code === 'INVALID_PLATFORM_PROFILE'
  );
  assert.throws(
    () => normalizeProfileSettings(validatePlatformProfile(naver), { purpose: '유효', executable: '() => process.exit()' }),
    (error) => error.code === 'PROFILE_SETTINGS_INVALID'
  );
});

test('a new profile using an audited adapter appears in the catalog and planner without channel-specific code', async (t) => {
  const db = await database(t);
  await migrate(db, process.cwd());
  const naver = (await db.query("SELECT * FROM channel_definition_versions WHERE id='naver_blog:v2'"))[0];
  const customRow = {
    ...naver,
    id: 'owned_guide:v1',
    channel: 'owned_guide',
    version_no: 1,
    display_name: 'Owned Guide',
    description: '보유 원본을 단계형 가이드로 재구성하는 초안',
    schema_key: 'owned_guide_v1',
    profile_config: {
      ...naver.profile_config,
      profile_id: 'owned_guide:v1',
      settings_schema: {
        ...naver.profile_config.settings_schema,
        properties: {
          ...naver.profile_config.settings_schema.properties,
          purpose: {
            ...naver.profile_config.settings_schema.properties.purpose,
            title: '가이드 목적',
            description: '이 Profile이 원본으로 해결할 독자 문제'
          }
        }
      },
      prompt_policy: {
        ...naver.profile_config.prompt_policy,
        task: 'owned_step_guide',
        instructions: [
          'Create a source-grounded step guide.',
          'Keep every factual surface linked to selected source handles.'
        ]
      }
    }
  };
  const validated = validatePlatformProfile(customRow);
  assert.equal(validated.adapterKey, 'article');
  assert.equal(validated.channel, 'owned_guide');
  const adapter = resolvePlatformAdapter(validated);
  const prompt = JSON.parse(adapter.buildDraftPrompt({
    settings: adapter.normalizeSettings({ purpose: '단계별 운영 기준 안내' }),
    commonContext: {
      audience: null,
      creatorVoiceGuidance: '',
      lockedCreatorIdentityFacts: [],
      commonCta: ''
    },
    evidencePlan: {
      supportedPurpose: '단계별 운영 기준 안내',
      missingInformation: [],
      contentBudget: { maximumClaims: 1 },
      selectedSourceHandles: ['본문 1 · 문장 1'],
      selectedAtoms: [{ position_label: '본문 1 · 문장 1', atom_type: 'claim', text: '원본 사실' }]
    }
  }));
  assert.equal(prompt.profile.channel, 'owned_guide');
  assert.equal(prompt.profile.adapter, 'article');
  assert.ok(prompt.adaptation.includes('profile_defined_reader_purpose'));
  assert.equal(prompt.adaptation.includes('search_intent_title'), false);

  await db.query(`INSERT INTO channel_definition_versions
      (id,channel,version_no,display_name,description,schema_key,adapter_key,profile_config,selectable,default_active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true,true)`, [
    customRow.id,
    customRow.channel,
    customRow.version_no,
    customRow.display_name,
    customRow.description,
    customRow.schema_key,
    customRow.adapter_key,
    JSON.stringify(customRow.profile_config)
  ]);
  await db.query("INSERT INTO workspaces (id,name) VALUES ('workspace-extensible','확장 작업공간')");
  const catalog = await activeChannelCatalog(db, 'workspace-extensible');
  const custom = catalog.find((row) => row.id === customRow.id);
  assert.ok(custom, 'new selectable profile is discovered from the database');

  const markup = channelPlannerFieldset(custom);
  assert.match(markup, /Owned Guide/u);
  assert.match(markup, /가이드 목적/u);
  assert.match(markup, /이 Profile이 원본으로 해결할 독자 문제/u);
  assert.match(markup, /channel_owned_guide_purpose/u);
  assert.match(markup, /검사 기준/u);

  const selected = planOutputsFromRequest({
    channel_owned_guide_selected: 'owned_guide:v1',
    channel_owned_guide_purpose: '단계별 운영 기준 안내',
    channel_owned_guide_keyword: '원본 운영',
    channel_naver_blog_purpose: '선택하지 않은 설정'
  }, catalog);
  assert.deepEqual(selected, [{
    type: 'owned_guide',
    platformProfileVersionId: 'owned_guide:v1',
    settings: {
      purpose: '단계별 운영 기준 안내',
      keyword: '원본 운영',
      includeFaq: false
    }
  }]);
  assert.equal(selected.some((output) => output.type === 'naver_blog'), false);
  assert.match(artifactMarkdown('owned_guide', {
    title: '단계형 가이드',
    intro: '원본 사실을 설명합니다.',
    sections: [{ heading: '첫 단계', body: '원본을 고정합니다.' }],
    faq: [],
    cta: '',
    tags: []
  }, validated), /^# 단계형 가이드[\s\S]*## 첫 단계/u);

  await assert.doesNotReject(db.query(`INSERT INTO users
      (id,workspace_id,email,password_hash,role)
    VALUES ('user-extensible','workspace-extensible','extensible@example.test','hash','administrator')`));
  await assert.doesNotReject(db.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,created_by)
    VALUES ('source-extensible','workspace-extensible','원본','rss','user-extensible')`));
  await assert.doesNotReject(db.query(`INSERT INTO source_items
      (id,source_id,external_key,title)
    VALUES ('item-extensible','source-extensible','one','원본')`));
  await assert.doesNotReject(db.query(`INSERT INTO artifacts
      (id,workspace_id,source_item_id,channel,state,created_by)
    VALUES ('artifact-extensible','workspace-extensible','item-extensible','owned_guide','draft','user-extensible')`));
});
