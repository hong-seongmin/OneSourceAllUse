import { XMLParser } from 'fast-xml-parser';
import { audit, enqueue, recordDomainEvent } from './audit.js';
import { cleanText, id, parseJson, sha256, stableKey } from './ids.js';
import { issue } from './errors.js';
import { boundedText, safeFetch } from './security.js';
import { assessSourceReadiness, normalizeRightsStatus } from './source-readiness.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: true,
  stopNodes: ['*.description', '*.content:encoded', '*.content', '*.summary']
});
const asList = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const field = (value) => typeof value === 'object' ? value?.['#text'] || value?.['@_href'] || '' : value || '';

const ENTITY_VALUES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
};

function decodeEntities(value) {
  let text = String(value ?? '');
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (entity, key) => {
      if (key[0] !== '#') return ENTITY_VALUES[key.toLowerCase()] ?? ' ';
      const hexadecimal = key[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : ' ';
    });
  }
  return text;
}

function countCodePoints(value) {
  return [...String(value ?? '')].length;
}

function truncateCodePoints(value, limit) {
  return [...value].slice(0, limit).join('');
}

function excerptSignals(text, { bodyKind, sourceUrl } = {}) {
  if (!['description', 'summary'].includes(bodyKind)) return [];
  const signals = [];
  if (/(?:\.\.\.|…|⋯)\s*(?:더\s*보기|계속\s*읽기|read\s*more)?\s*$/iu.test(text)) signals.push('TERMINAL_ELLIPSIS');
  if (/(?:더\s*보기|계속\s*읽기|원문\s*보기|read\s*(?:more|on)|continue\s*reading)\s*$/iu.test(text)) signals.push('READ_MORE_MARKER');
  if (/(?:^|\.)blog\.naver\.com(?::\d+)?(?:\/|$)/iu.test(String(sourceUrl ?? '').replace(/^https?:\/\//iu, ''))) signals.push('NAVER_DESCRIPTION_ONLY');
  return signals;
}

export function buildIngestionMetadata({
  originalBody = '',
  storedBody = '',
  bodyKind = 'unknown',
  truncated = false,
  sanitizationSignals = [],
  sourceUrl = ''
} = {}) {
  const detectedExcerptSignals = excerptSignals(storedBody, { bodyKind, sourceUrl });
  return {
    bodyKind,
    originalLength: countCodePoints(originalBody),
    storedLength: countCodePoints(storedBody),
    truncated: Boolean(truncated),
    appearsExcerpt: detectedExcerptSignals.length > 0,
    excerptSignals: detectedExcerptSignals,
    sanitizationSignals: [...new Set(sanitizationSignals)]
  };
}

export function sanitizeRssContent(rawContent, {
  bodyKind = 'unknown',
  maxLength = 100_000,
  sourceUrl = ''
} = {}) {
  const originalBody = String(rawContent ?? '');
  const signals = [];
  let text = decodeEntities(originalBody).normalize('NFC');
  text = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[|\]\]>/giu, ' ');

  const activeBlock = /<(script|style|form|object|iframe|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = text.replace(activeBlock, () => {
      signals.push('ACTIVE_CONTENT_REMOVED');
      return '\n';
    });
    if (next === text) break;
    text = next;
  }
  text = text.replace(/<(?:script|style|form|object|iframe|svg)\b[^>]*>[\s\S]*$/giu, (match) => {
    const openingEnd = match.indexOf('>');
    if (/\/\s*>$/u.test(match.slice(0, openingEnd + 1))) {
      signals.push('ACTIVE_CONTENT_REMOVED');
      return match.slice(openingEnd + 1);
    }
    signals.push('MALFORMED_ACTIVE_CONTENT_REMOVED');
    return '\n';
  });
  text = text.replace(/<(?:script|style|form|object|iframe|svg)\b[^>]*\/?>/giu, () => {
    signals.push('ACTIVE_CONTENT_REMOVED');
    return '\n';
  });
  text = text.replace(/<img\b[^>]*>/giu, () => {
    signals.push('IMAGE_REMOVED');
    return ' ';
  });
  text = text.replace(/<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|ul|ol|blockquote|pre|table|tr|hr)\b[^>]*>/giu, '\n');
  text = text.replace(/<br\b[^>]*\/?>/giu, '\n');
  text = text.replace(/<[^>]+>/gu, ' ');
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>{}\[\]"']+/giu, () => {
    signals.push('URL_FRAGMENT_REMOVED');
    return ' ';
  });
  text = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .replace(/[\t\f\v]+/gu, ' ')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \u3000]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  const preTruncationLength = countCodePoints(text);
  const truncated = preTruncationLength > maxLength;
  if (truncated) text = truncateCodePoints(text, maxLength).trimEnd();
  const paragraphs = text.split(/\n\s*\n|\r?\n/gu).map((part) => part.trim()).filter(Boolean);
  const storedBody = paragraphs.join('\n\n');
  return {
    text: storedBody,
    paragraphs,
    metadata: buildIngestionMetadata({
      originalBody,
      storedBody,
      bodyKind,
      truncated,
      sanitizationSignals: signals,
      sourceUrl
    })
  };
}

export const sanitizeRssBody = sanitizeRssContent;

function parsedEntry({ key, title, url, bodyValue, bodyKind, publishedAt, raw }) {
  const safeTitle = sanitizeRssContent(title, { bodyKind: 'title', maxLength: 500 }).text;
  const safeUrl = cleanText(url, 2_000);
  const sanitized = sanitizeRssContent(bodyValue, { bodyKind, sourceUrl: safeUrl });
  return {
    key,
    title: safeTitle,
    url: safeUrl,
    body: sanitized.text,
    ingestionMeta: sanitized.metadata,
    publishedAt,
    raw
  };
}

export function parseFeed(xml) {
  let document;
  try { document = parser.parse(xml); } catch { throw issue('RSS_PARSE_FAILED', 'RSS 또는 Atom 문서를 해석할 수 없습니다.'); }
  const rssItems = asList(document?.rss?.channel?.item).map((item) => {
    const hasFullContent = field(item['content:encoded']) !== '';
    return parsedEntry({
      key: field(item.guid) || field(item.link) || `${field(item.title)}:${field(item.pubDate)}`,
      title: field(item.title),
      url: field(item.link),
      bodyValue: hasFullContent ? field(item['content:encoded']) : field(item.description),
      bodyKind: hasFullContent ? 'content_encoded' : 'description',
      publishedAt: field(item.pubDate) || null,
      raw: item
    });
  });
  const atomItems = asList(document?.feed?.entry).map((entry) => {
    const hasFullContent = field(entry.content) !== '';
    return parsedEntry({
      key: field(entry.id) || field(asList(entry.link)[0]) || `${field(entry.title)}:${field(entry.updated)}`,
      title: field(entry.title),
      url: field(asList(entry.link).find((link) => link?.['@_rel'] !== 'self') || asList(entry.link)[0]),
      bodyValue: hasFullContent ? field(entry.content) : field(entry.summary),
      bodyKind: hasFullContent ? 'content' : 'summary',
      publishedAt: field(entry.published) || field(entry.updated) || null,
      raw: entry
    });
  });
  const items = [...rssItems, ...atomItems].filter((item) => item.key && item.title);
  if (!items.length) throw issue('RSS_EMPTY_OR_PARTIAL', '처리 가능한 식별자와 제목을 가진 RSS 항목이 없습니다. 원본 RSS 주소를 확인하세요.');
  return items;
}

export function segmentAndAtomize(title, body, bodySegmentType = 'paragraph') {
  const paragraphs = cleanText(body, 100_000).split(/\n\s*\n|\r?\n/).map((part) => cleanText(part, 12_000)).filter(Boolean);
  const rawSegments = [{ type: 'title', text: title }, ...paragraphs.map((text) => ({
    type: bodySegmentType === 'transcript' ? 'transcript' : /^#{1,6}\s/.test(text) ? 'heading' : 'paragraph',
    text: text.replace(/^#{1,6}\s*/, '')
  }))];
  const segments = rawSegments.map((segment, index) => ({ ...segment, ordinal: index + 1, positionLabel: segment.type === 'title' ? '제목' : `본문 ${index}` }));
  const atoms = [];
  for (const segment of segments) {
    const sentences = segment.text.match(/[^.!?。！？]+[.!?。！？]?/g) || [segment.text];
    sentences.map((sentence) => cleanText(sentence, 2_000)).filter(Boolean).forEach((text, index) => {
      const atomType = /\d/.test(text) ? 'number' : /["“”]/.test(text) ? 'quote' : segment.type === 'title' ? 'context' : 'claim';
      atoms.push({ segmentOrdinal: segment.ordinal, positionLabel: `${segment.positionLabel} · 문장 ${index + 1}`, text, atomType, fingerprint: sha256(text.toLowerCase().replace(/\s+/g, ' ')) });
    });
  }
  return { segments, atoms };
}

export async function registerRssSource(db, { workspaceId, userId, name, feedUrl, rightsStatus = 'unknown' }) {
  if (!name || !feedUrl) throw issue('SOURCE_INPUT_REQUIRED', '원본 이름과 RSS 주소를 모두 입력하세요.');
  const sourceId = id();
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO sources (id, workspace_id, name, connector_type, feed_url, created_by, rights_status) VALUES ($1,$2,$3,$4,$5,$6,$7)', [sourceId, workspaceId, cleanText(name, 120), 'rss', feedUrl, userId, normalizeRightsStatus(rightsStatus)]);
    await tx.query("INSERT INTO source_sync_states (source_id, status) VALUES ($1, 'idle')", [sourceId]);
    await audit(tx, { workspaceId, actorId: userId, action: 'source.registered', entityType: 'source', entityId: sourceId, detail: { connector: 'rss' } });
    await recordDomainEvent(tx, { workspaceId, actorId: userId, eventType: 'source.registered', aggregateType: 'source', aggregateId: sourceId });
  });
  return sourceId;
}

export async function requestSourceSync(db, { workspaceId, sourceId, userId }) {
  return db.transaction(async (tx) => {
    const source = (await tx.query('SELECT id FROM sources WHERE id = $1 AND workspace_id = $2 AND enabled = true', [sourceId, workspaceId]))[0];
    if (!source) throw issue('SOURCE_NOT_FOUND', '동기화할 원본을 찾을 수 없습니다.', 404);
    const active = (await tx.query(`SELECT id FROM outbox_events
      WHERE workspace_id=$1 AND event_type='sync_rss'
        AND payload->>'sourceId'=$2
        AND status IN ('pending','processing')
      ORDER BY created_at DESC
      LIMIT 1`, [workspaceId, sourceId]))[0];
    await tx.query("UPDATE source_sync_states SET status = 'queued', last_error = NULL, updated_at = now() WHERE source_id = $1", [sourceId]);
    const eventId = active?.id || await enqueue(tx, {
      workspaceId,
      eventType: 'sync_rss',
      payload: { sourceId, requestedBy: userId },
      // Keep completed outbox history immutable while allowing a later explicit
      // synchronization. Concurrent requests reuse the active row above.
      dedupeKey: `sync-rss:${sourceId}:${id()}`
    });
    await audit(tx, { workspaceId, actorId: userId, action: 'source.sync_requested', entityType: 'source', entityId: sourceId });
    return { eventId, reusedActiveEvent: Boolean(active) };
  });
}

export async function retryFailedSourceImpact(db, { workspaceId, sourceId, userId }) {
  return db.transaction(async (tx) => {
    const source = (await tx.query(`SELECT id FROM sources
      WHERE id=$1 AND workspace_id=$2 AND enabled=true
      FOR UPDATE`, [sourceId, workspaceId]))[0];
    if (!source) throw issue('SOURCE_NOT_FOUND', '영향 처리를 복구할 원본을 찾을 수 없습니다.', 404);

    const failures = await tx.query(`SELECT failed.id,failed.payload,failed.created_at
      FROM outbox_events failed
      JOIN source_items item ON item.id=failed.payload->>'sourceItemId'
      WHERE failed.workspace_id=$1
        AND item.source_id=$2
        AND failed.event_type='apply_source_update'
        AND failed.status='failed'
        AND NOT EXISTS (
          SELECT 1 FROM outbox_events recovered
          WHERE recovered.workspace_id=failed.workspace_id
            AND recovered.event_type='apply_source_update'
            AND recovered.status='succeeded'
            AND recovered.payload->>'sourceItemId'=failed.payload->>'sourceItemId'
            AND recovered.payload->>'oldSnapshotId'=failed.payload->>'oldSnapshotId'
            AND recovered.payload->>'newSnapshotId'=failed.payload->>'newSnapshotId'
        )
        AND NOT EXISTS (
          SELECT 1 FROM outbox_events active
          WHERE active.workspace_id=failed.workspace_id
            AND active.event_type='apply_source_update'
            AND active.status IN ('pending','processing')
            AND active.payload->>'sourceItemId'=failed.payload->>'sourceItemId'
            AND active.payload->>'oldSnapshotId'=failed.payload->>'oldSnapshotId'
            AND active.payload->>'newSnapshotId'=failed.payload->>'newSnapshotId'
        )
      ORDER BY failed.created_at DESC
      FOR UPDATE OF failed`, [workspaceId, sourceId]);

    const transitions = new Map();
    for (const failure of failures) {
      const payload = parseJson(failure.payload, {});
      const transitionKey = [
        payload.sourceItemId,
        payload.oldSnapshotId,
        payload.newSnapshotId
      ].join(':');
      if (!transitions.has(transitionKey)) transitions.set(transitionKey, { failureId: failure.id, payload });
    }

    const eventIds = [];
    for (const transition of transitions.values()) {
      const eventId = await enqueue(tx, {
        workspaceId,
        eventType: 'apply_source_update',
        payload: transition.payload,
        // Preserve every terminal failure as immutable history. A recovery is
        // a new operational event for the exact same snapshot transition.
        dedupeKey: `source-impact-retry:${transition.failureId}:${id()}`
      });
      eventIds.push(eventId);
    }

    if (eventIds.length) {
      await audit(tx, {
        workspaceId,
        actorId: userId,
        action: 'source.impact_retry_requested',
        entityType: 'source',
        entityId: sourceId,
        detail: { queuedTransitions: eventIds.length }
      });
      await recordDomainEvent(tx, {
        workspaceId,
        actorId: userId,
        eventType: 'source.impact_retry_requested',
        aggregateType: 'source',
        aggregateId: sourceId,
        payload: { queuedTransitions: eventIds.length }
      });
    }
    return { queuedTransitions: eventIds.length, eventIds };
  });
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export async function syncRssSource(db, sourceId, config = {}) {
  const source = (await db.query('SELECT * FROM sources WHERE id = $1 AND connector_type = $2 AND enabled = true', [sourceId, 'rss']))[0];
  if (!source) throw issue('SOURCE_NOT_FOUND', 'RSS 원본을 찾을 수 없습니다.', 404);
  await db.query("UPDATE source_sync_states SET status = 'running', updated_at = now() WHERE source_id = $1", [sourceId]);
  try {
    const response = await safeFetch(source.feed_url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' } }, {
      ...(config.network || {}),
      maxBytes: 2_000_000,
      timeoutMs: Number(config.network?.timeoutMs) || 12_000
    });
    if (!response.ok) throw issue('RSS_FETCH_FAILED', `RSS 서버가 HTTP ${response.status}로 응답했습니다.`, 502);
    const entries = parseFeed(await boundedText(response));
    const changedItemIds = [];
    for (const entry of entries) {
      const changed = await persistEntry(db, source, entry);
      if (changed) changedItemIds.push(changed);
    }
    await db.query("UPDATE source_sync_states SET status = 'succeeded', last_synced_at = now(), last_error = NULL, retry_count = 0, updated_at = now() WHERE source_id = $1", [sourceId]);
    return { sourceId, itemsSeen: entries.length, changedItemIds };
  } catch (error) {
    await db.query("UPDATE source_sync_states SET status = 'failed', last_error = $2, retry_count = retry_count + 1, updated_at = now() WHERE source_id = $1", [sourceId, cleanText(error.message, 500)]);
    throw error;
  }
}

export async function persistEntry(db, source, entry) {
  const contentHash = sha256(`${entry.title}\n${entry.body}`);
  return db.transaction(async (tx) => {
    let item = (await tx.query(`SELECT * FROM source_items
      WHERE source_id = $1 AND external_key = $2
      FOR UPDATE`, [source.id, stableKey(entry.key)]))[0];
    if (!item) {
      item = { id: id() };
      await tx.query('INSERT INTO source_items (id, source_id, external_key, title, canonical_url, published_at) VALUES ($1,$2,$3,$4,$5,$6)', [
        item.id, source.id, stableKey(entry.key), entry.title, entry.url || null, validDate(entry.publishedAt)
      ]);
    }
    const oldSnapshotId = item.latest_snapshot_id;
    const existing = (await tx.query('SELECT id FROM source_snapshots WHERE source_item_id = $1 AND content_hash = $2', [item.id, contentHash]))[0];
    if (existing) return null;
    const next = (await tx.query('SELECT COALESCE(max(version_no), 0) + 1 AS next FROM source_snapshots WHERE source_item_id = $1', [item.id]))[0].next;
    const snapshotId = id();
    const { segments, atoms } = segmentAndAtomize(entry.title, entry.body, entry.segmentType);
    await tx.query('INSERT INTO source_snapshots (id, source_item_id, version_no, content_hash, title, body, raw_payload, ingestion_meta) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [
      snapshotId, item.id, next, contentHash, entry.title, entry.body, JSON.stringify(entry.raw), JSON.stringify(entry.ingestionMeta || {})
    ]);
    const segmentIds = new Map();
    for (const segment of segments) {
      const segmentId = id();
      segmentIds.set(segment.ordinal, segmentId);
      await tx.query('INSERT INTO source_segments (id, snapshot_id, position_label, ordinal, segment_type, text) VALUES ($1,$2,$3,$4,$5,$6)', [segmentId, snapshotId, segment.positionLabel, segment.ordinal, segment.type, segment.text]);
    }
    const persistedAtoms = [];
    for (const atom of atoms) {
      const atomId = id();
      await tx.query('INSERT INTO content_atoms (id, snapshot_id, segment_id, position_label, atom_type, text, fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        atomId, snapshotId, segmentIds.get(atom.segmentOrdinal), atom.positionLabel, atom.atomType, atom.text, atom.fingerprint
      ]);
      persistedAtoms.push({
        ...atom,
        id: atomId,
        segmentType: segments.find((segment) => segment.ordinal === atom.segmentOrdinal)?.type
      });
    }
    const assessment = assessSourceReadiness({
      body: entry.body,
      atoms: persistedAtoms,
      ingestionMeta: entry.ingestionMeta,
      rightsStatus: source.rights_status
    });
    await tx.query(`INSERT INTO source_snapshot_assessments
      (snapshot_id, readiness, rights_status, usable_atom_ids, omissions, signals, acknowledgement_required)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)`, [
      snapshotId,
      assessment.readiness,
      assessment.rightsStatus,
      JSON.stringify(assessment.usableAtomIds),
      JSON.stringify(assessment.omissions),
      JSON.stringify(assessment.signals),
      assessment.acknowledgementRequired
    ]);
    await tx.query('UPDATE source_items SET title = $2, canonical_url = $3, published_at = $4, latest_snapshot_id = $5, updated_at = now() WHERE id = $1', [item.id, entry.title, entry.url || null, validDate(entry.publishedAt), snapshotId]);
    await recordDomainEvent(tx, { workspaceId: source.workspace_id, eventType: oldSnapshotId ? 'source.snapshot_updated' : 'source.snapshot_created', aggregateType: 'source_item', aggregateId: item.id, payload: { snapshotId } });
    if (oldSnapshotId) await enqueue(tx, { workspaceId: source.workspace_id, eventType: 'apply_source_update', payload: { sourceItemId: item.id, oldSnapshotId, newSnapshotId: snapshotId }, dedupeKey: `source-update:${item.id}:${snapshotId}` });
    return item.id;
  });
}
