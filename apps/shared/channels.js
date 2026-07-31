import { issue } from './errors.js';
import { platformProfileContracts, validatePlatformProfile } from './channel-registry.js';

const CHANNEL_NAMES = Object.freeze({
  naver_blog: 'Naver Blog Draft',
  wordpress_article: 'WordPress Article',
  newsletter: 'Newsletter',
  instagram_carousel: 'Instagram Carousel',
  youtube_shorts: 'YouTube Shorts',
  instagram_reels: 'Instagram Reels',
  tiktok_video: 'TikTok Video',
  short_video: 'Short Video Script'
});

export const channelTypes = Object.freeze(Object.keys(CHANNEL_NAMES));

export function channelName(channel) {
  return CHANNEL_NAMES[channel] || channel;
}

export async function ensureWorkspaceChannelCatalog(db, workspaceId) {
  await db.query(`INSERT INTO workspace_channel_catalog
      (workspace_id, channel, channel_definition_version_id, active, default_settings)
    SELECT $1, definition.channel, definition.id, definition.default_active, '{}'::jsonb
    FROM (
      SELECT DISTINCT ON (channel) id, channel, default_active, version_no
      FROM channel_definition_versions
      WHERE selectable=true
      ORDER BY channel, default_active DESC, version_no DESC
    ) AS definition
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_channel_catalog existing
      WHERE existing.workspace_id=$1 AND existing.channel=definition.channel
    )
    ON CONFLICT (workspace_id, channel) DO NOTHING`, [workspaceId]);
}

function profileRows(rows) {
  return rows.map((row) => {
    const profile = validatePlatformProfile(row);
    return { ...row, profile: platformProfileContracts(profile) };
  });
}

async function queryCatalog(db, workspaceId, activeOnly) {
  const rows = await db.query(`SELECT d.id, d.channel, d.version_no, d.display_name, d.description, d.schema_key,
      d.adapter_key, d.profile_config, d.selectable, d.default_active, c.active, c.default_settings
    FROM workspace_channel_catalog c JOIN channel_definition_versions d ON d.id=c.channel_definition_version_id
    WHERE c.workspace_id=$1 AND d.selectable=true ${activeOnly ? 'AND c.active=true' : ''}
    ORDER BY d.channel`, [workspaceId]);
  return profileRows(rows);
}

export async function activeChannelCatalog(db, workspaceId) {
  await ensureWorkspaceChannelCatalog(db, workspaceId);
  return queryCatalog(db, workspaceId, true);
}

export async function workspaceChannelCatalog(db, workspaceId) {
  await ensureWorkspaceChannelCatalog(db, workspaceId);
  return queryCatalog(db, workspaceId, false);
}

export async function setChannelActive(db, { workspaceId, channel, active }) {
  await ensureWorkspaceChannelCatalog(db, workspaceId);
  const updated = await db.query(`UPDATE workspace_channel_catalog AS catalog
    SET active=$3, updated_at=now()
    FROM channel_definition_versions AS definition
    WHERE catalog.workspace_id=$1
      AND catalog.channel=$2
      AND definition.id=catalog.channel_definition_version_id
      AND definition.selectable=true
    RETURNING catalog.channel, catalog.active, catalog.channel_definition_version_id`, [workspaceId, channel, Boolean(active)]);
  if (!updated.length) throw issue('UNSUPPORTED_OUTPUT', '지원하지 않거나 선택할 수 없는 채널입니다.', 422, { channel });
  return {
    channel: updated[0].channel,
    active: updated[0].active,
    channelDefinitionVersionId: updated[0].channel_definition_version_id
  };
}
