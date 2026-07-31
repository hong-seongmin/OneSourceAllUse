import { audit, enqueue, recordDomainEvent } from './audit.js';
import { cleanText, id } from './ids.js';
import { issue } from './errors.js';
import { persistEntry, sanitizeRssContent } from './rss.js';
import { boundedText, safeFetch } from './security.js';
import { normalizeRightsStatus } from './source-readiness.js';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be'
]);

export function parseYouTubeVideo(value) {
  const input = cleanText(value, 2_000);
  if (!input) throw issue('YOUTUBE_URL_REQUIRED', 'YouTube 영상 주소를 입력하세요.', 422);
  if (YOUTUBE_ID.test(input)) {
    return {
      videoId: input,
      canonicalUrl: `https://www.youtube.com/watch?v=${input}`
    };
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw issue('YOUTUBE_URL_INVALID', '공식 YouTube 영상 주소 또는 11자리 영상 ID를 입력하세요.', 422);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(hostname) || url.username || url.password) {
    throw issue('YOUTUBE_URL_INVALID', 'HTTPS YouTube 영상 주소만 사용할 수 있습니다.', 422);
  }
  let videoId = '';
  if (hostname === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  } else if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v') || '';
  } else {
    const [kind, candidate] = url.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'live'].includes(kind)) videoId = candidate || '';
  }
  if (!YOUTUBE_ID.test(videoId)) {
    throw issue('YOUTUBE_URL_INVALID', '영상 ID를 확인할 수 있는 YouTube watch, shorts, live 또는 youtu.be 주소를 입력하세요.', 422);
  }
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
  };
}

async function registerConnectorSource(tx, {
  workspaceId,
  userId,
  name,
  connectorType,
  sourceUrl = null,
  rightsStatus,
  eventType,
  payload
}) {
  const sourceId = id();
  await tx.query(`INSERT INTO sources
      (id,workspace_id,name,connector_type,feed_url,created_by,rights_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    sourceId,
    workspaceId,
    cleanText(name, 120),
    connectorType,
    sourceUrl,
    userId,
    normalizeRightsStatus(rightsStatus)
  ]);
  await tx.query("INSERT INTO source_sync_states (source_id,status) VALUES ($1,'queued')", [sourceId]);
  const eventId = await enqueue(tx, {
    workspaceId,
    eventType,
    payload: { ...payload, sourceId, requestedBy: userId },
    dedupeKey: `${eventType}:${sourceId}`
  });
  await audit(tx, {
    workspaceId,
    actorId: userId,
    action: 'source.registered',
    entityType: 'source',
    entityId: sourceId,
    detail: { connector: connectorType }
  });
  await recordDomainEvent(tx, {
    workspaceId,
    actorId: userId,
    eventType: 'source.registered',
    aggregateType: 'source',
    aggregateId: sourceId,
    payload: { connector: connectorType }
  });
  return { sourceId, eventId };
}

export async function registerTranscriptUpload(db, {
  workspaceId,
  userId,
  name,
  title,
  body,
  filename = '',
  canonicalUrl = '',
  rightsStatus = 'unknown'
}) {
  const normalizedTitle = cleanText(title || name || filename, 500);
  const rawBody = String(body ?? '');
  if (!normalizedTitle || !rawBody.trim()) {
    throw issue('TRANSCRIPT_INPUT_REQUIRED', '전사 제목과 전사 내용을 모두 입력하세요.', 422);
  }
  if ([...rawBody].length > 500_000) {
    throw issue('TRANSCRIPT_TOO_LARGE', '전사 파일은 텍스트 500,000자 이하여야 합니다.', 413);
  }
  let safeCanonicalUrl = null;
  if (canonicalUrl) {
    try {
      const parsed = new URL(canonicalUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsafe');
      safeCanonicalUrl = parsed.href;
    } catch {
      throw issue('TRANSCRIPT_CANONICAL_URL_INVALID', '원본 주소는 인증정보가 없는 HTTP 또는 HTTPS 주소여야 합니다.', 422);
    }
  }
  const uploadId = id();
  return db.transaction((tx) => registerConnectorSource(tx, {
    workspaceId,
    userId,
    name: name || `전사 · ${normalizedTitle}`,
    connectorType: 'transcript_upload',
    sourceUrl: safeCanonicalUrl,
    rightsStatus,
    eventType: 'ingest_transcript',
    payload: {
      uploadId,
      title: normalizedTitle,
      body: rawBody,
      filename: cleanText(filename, 300),
      canonicalUrl: safeCanonicalUrl
    }
  }));
}

export async function registerYouTubeMetadata(db, {
  workspaceId,
  userId,
  name = '',
  videoUrl,
  rightsStatus = 'unknown'
}) {
  const video = parseYouTubeVideo(videoUrl);
  return db.transaction((tx) => registerConnectorSource(tx, {
    workspaceId,
    userId,
    name: name || `YouTube · ${video.videoId}`,
    connectorType: 'youtube_metadata',
    sourceUrl: video.canonicalUrl,
    rightsStatus,
    eventType: 'ingest_youtube_metadata',
    payload: video
  }));
}

async function connectorSource(db, sourceId, connectorType) {
  const source = (await db.query(`SELECT * FROM sources
    WHERE id=$1 AND connector_type=$2 AND enabled=true`, [sourceId, connectorType]))[0];
  if (!source) throw issue('SOURCE_NOT_FOUND', '수집할 원본 연결을 찾을 수 없습니다.', 404);
  return source;
}

async function withSyncState(db, source, operation) {
  await db.query("UPDATE source_sync_states SET status='running',last_error=NULL,updated_at=now() WHERE source_id=$1", [source.id]);
  try {
    const result = await operation();
    await db.query(`UPDATE source_sync_states
      SET status='succeeded',last_synced_at=now(),last_error=NULL,retry_count=0,updated_at=now()
      WHERE source_id=$1`, [source.id]);
    return result;
  } catch (error) {
    await db.query(`UPDATE source_sync_states
      SET status='failed',last_error=$2,retry_count=retry_count+1,updated_at=now()
      WHERE source_id=$1`, [source.id, cleanText(error.message, 500)]);
    throw error;
  }
}

export async function ingestTranscript(db, payload) {
  const source = await connectorSource(db, payload.sourceId, 'transcript_upload');
  return withSyncState(db, source, async () => {
    const sanitized = sanitizeRssContent(payload.body, {
      bodyKind: 'transcript_upload',
      maxLength: 100_000,
      sourceUrl: payload.canonicalUrl || ''
    });
    const itemId = await persistEntry(db, source, {
      key: payload.uploadId,
      title: sanitizeRssContent(payload.title, { bodyKind: 'title', maxLength: 500 }).text,
      url: payload.canonicalUrl || null,
      body: sanitized.text,
      publishedAt: null,
      segmentType: 'transcript',
      ingestionMeta: {
        ...sanitized.metadata,
        connector: 'transcript_upload',
        filename: cleanText(payload.filename, 300)
      },
      raw: {
        connector: 'transcript_upload',
        filename: cleanText(payload.filename, 300),
        originalBody: String(payload.body ?? '')
      }
    });
    return { sourceId: source.id, changedItemIds: itemId ? [itemId] : [] };
  });
}

function youtubeOembedEndpoint(config, canonicalUrl) {
  const base = config.environment === 'test' && config.youtubeOembedBaseUrl
    ? config.youtubeOembedBaseUrl
    : 'https://www.youtube.com/oembed';
  const endpoint = new URL(base);
  endpoint.searchParams.set('url', canonicalUrl);
  endpoint.searchParams.set('format', 'json');
  return endpoint.href;
}

export async function ingestYouTubeMetadata(db, payload, config = {}) {
  const source = await connectorSource(db, payload.sourceId, 'youtube_metadata');
  const video = parseYouTubeVideo(payload.videoId || payload.canonicalUrl || source.feed_url);
  return withSyncState(db, source, async () => {
    const response = await safeFetch(
      youtubeOembedEndpoint(config, video.canonicalUrl),
      { headers: { accept: 'application/json' } },
      { ...(config.network || {}), timeoutMs: 15_000, maxBytes: 250_000 }
    );
    if (!response.ok) {
      throw issue('YOUTUBE_METADATA_FETCH_FAILED', `YouTube 공식 metadata endpoint가 HTTP ${response.status}로 응답했습니다.`, 502, {
        retryable: response.status === 408 || response.status === 429 || response.status >= 500
      });
    }
    let metadata;
    try {
      metadata = JSON.parse(await boundedText(response, 250_000, 15_000));
    } catch (error) {
      if (error?.code) throw error;
      throw issue('YOUTUBE_METADATA_INVALID', 'YouTube 공식 metadata 응답을 해석할 수 없습니다.', 502);
    }
    const title = sanitizeRssContent(metadata?.title, { bodyKind: 'title', maxLength: 500 }).text;
    const author = sanitizeRssContent(metadata?.author_name, { bodyKind: 'metadata', maxLength: 500 }).text;
    if (!title || !author || metadata?.provider_name !== 'YouTube') {
      throw issue('YOUTUBE_METADATA_INVALID', 'YouTube 공식 metadata 응답에 제목, 채널 또는 Provider 정보가 없습니다.', 502);
    }
    const body = [`영상 제목: ${title}`, `채널: ${author}`].join('\n\n');
    const itemId = await persistEntry(db, source, {
      key: video.videoId,
      title,
      url: video.canonicalUrl,
      body,
      publishedAt: null,
      ingestionMeta: {
        connector: 'youtube_metadata',
        bodyKind: 'official_oembed_metadata',
        metadataOnly: true,
        truncated: false,
        appearsExcerpt: false,
        omissions: ['YOUTUBE_TRANSCRIPT_MISSING'],
        sanitizationSignals: [],
        excerptSignals: []
      },
      raw: {
        connector: 'youtube_metadata',
        videoId: video.videoId,
        officialOembed: metadata
      }
    });
    return { sourceId: source.id, changedItemIds: itemId ? [itemId] : [] };
  });
}

export async function requestConnectorSync(db, { workspaceId, sourceId, userId }) {
  return db.transaction(async (tx) => {
    const source = (await tx.query(`SELECT id,connector_type,feed_url FROM sources
      WHERE id=$1 AND workspace_id=$2 AND enabled=true FOR UPDATE`, [sourceId, workspaceId]))[0];
    if (!source) throw issue('SOURCE_NOT_FOUND', '동기화할 원본을 찾을 수 없습니다.', 404);
    if (source.connector_type === 'transcript_upload') {
      throw issue('TRANSCRIPT_RESYNC_UNAVAILABLE', '업로드한 전사는 불변 스냅샷으로 보관됩니다. 변경된 전사는 새 원본으로 업로드하세요.', 409);
    }
    const eventType = source.connector_type === 'rss' ? 'sync_rss' : 'ingest_youtube_metadata';
    const active = (await tx.query(`SELECT id FROM outbox_events
      WHERE workspace_id=$1 AND event_type=$2
        AND payload->>'sourceId'=$3
        AND status IN ('pending','processing')
      ORDER BY created_at DESC LIMIT 1`, [workspaceId, eventType, sourceId]))[0];
    await tx.query("UPDATE source_sync_states SET status='queued',last_error=NULL,updated_at=now() WHERE source_id=$1", [sourceId]);
    const payload = source.connector_type === 'youtube_metadata'
      ? { sourceId, ...parseYouTubeVideo(source.feed_url), requestedBy: userId }
      : { sourceId, requestedBy: userId };
    const eventId = active?.id || await enqueue(tx, {
      workspaceId,
      eventType,
      payload,
      dedupeKey: `${eventType}:${sourceId}:${id()}`
    });
    await audit(tx, {
      workspaceId,
      actorId: userId,
      action: 'source.sync_requested',
      entityType: 'source',
      entityId: sourceId,
      detail: { connector: source.connector_type }
    });
    return { eventId, reusedActiveEvent: Boolean(active) };
  });
}
