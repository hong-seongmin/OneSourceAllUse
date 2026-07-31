import { audit, recordDomainEvent } from './audit.js';
import { id, parseJson, sha256 } from './ids.js';
import { issue } from './errors.js';
import { assertCredentialedHttps, boundedText, safeFetch } from './security.js';
import { platformMarkdown } from './platform-adapters.js';
import { currentVersionDriftFromRefs } from './freshness.js';
import { loadPlatformProfile } from './channel-registry.js';
import { approvalBlockers } from './review.js';
import {
  loadArtifactVersionSourceSnapshots,
  lockSourceItems
} from './source-provenance.js';

async function approvedVersion(db, workspaceId, artifactId, { lockArtifact = false } = {}) {
  const row = (await db.query(`SELECT a.id AS artifact_id, a.channel, a.state, a.source_item_id, a.current_version_id,
      av.content, av.channel_definition_version_id
    FROM artifacts a JOIN artifact_versions av ON av.id=a.current_version_id
    JOIN approvals ap ON ap.artifact_version_id=av.id AND ap.revoked_at IS NULL
    WHERE a.id=$1 AND a.workspace_id=$2
    ${lockArtifact ? 'FOR UPDATE OF a' : ''}`, [artifactId, workspaceId]))[0];
  if (!row) throw issue('APPROVAL_REQUIRED', '내보내기 전에 현재 버전을 명시적으로 승인해야 합니다.', 409);
  return { ...row, content: parseJson(row.content) };
}

async function assertCurrentSourceFresh(db, { workspaceId, artifactId }) {
  const drift = await currentVersionDriftFromRefs(db, { workspaceId, artifactId });
  if (drift.length) {
    throw issue(
      'SOURCE_UPDATE_PENDING',
      '연결된 원본 변경 영향 처리가 끝나지 않아 내보낼 수 없습니다.',
      409,
      { affectedBlockCount: drift.length }
    );
  }
}

async function assertCurrentApprovalSafety(db, { workspaceId, artifactId, artifact }) {
  const blockers = await approvalBlockers(db, { workspaceId, artifactId });
  if (blockers.length) {
    const blocker = blockers[0];
    throw issue(blocker.code, blocker.message, 409, { blockers });
  }
  if (!['approved', 'exported'].includes(artifact.state)) {
    throw issue('APPROVAL_REQUIRED', '내보내기 전에 현재 버전을 명시적으로 승인해야 합니다.', 409);
  }
}

async function lockArtifactVersionSources(db, artifact) {
  const sources = await loadArtifactVersionSourceSnapshots(db, artifact.current_version_id);
  const locked = await lockSourceItems(db, sources.map((source) => source.source_item_id));
  if (!sources.length || locked.length !== sources.length) {
    throw issue('SOURCE_ITEM_NOT_FOUND', '결과물 버전에 고정된 원본 전체를 찾을 수 없습니다.', 409);
  }
  return sources;
}

function wordpressDraftExternalId(post) {
  const numericId = typeof post?.id === 'number' ? post.id
    : typeof post?.id === 'string' && /^\d+$/u.test(post.id) ? Number(post.id)
      : Number.NaN;
  if (post?.status !== 'draft' || !Number.isSafeInteger(numericId) || numericId <= 0) {
    throw issue(
      'WORDPRESS_DRAFT_CONTRACT_FAILED',
      'WordPress가 유효한 draft 상태의 게시물 식별자를 반환하지 않았습니다.',
      502
    );
  }
  return String(numericId);
}

export function artifactMarkdown(channel, content, profile = null) {
  if (profile?.adapterKey && profile.adapterKey !== 'legacy') {
    if (profile.channel !== channel) throw issue('INVALID_PLATFORM_PROFILE', '결과물 채널과 Platform Profile이 일치하지 않습니다.', 500);
    return platformMarkdown(profile, content);
  }
  if (['naver_blog', 'wordpress_article', 'newsletter', 'instagram_carousel', 'youtube_shorts', 'instagram_reels', 'tiktok_video'].includes(channel)) {
    return platformMarkdown(channel, content);
  }
  if (channel === 'naver_blog') {
    return [`# ${content.title}`, '', content.intro, '', ...content.sections.flatMap((section) => [`## ${section.heading}`, '', section.body, '']), content.cta || '', content.tags?.length ? `태그: ${content.tags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ')}` : ''].filter(Boolean).join('\n');
  }
  if (channel === 'wordpress_article') return [`# ${content.title}`, '', `> ${content.excerpt}`, '', content.intro, '', ...content.sections.flatMap((section) => [`## ${section.heading}`, '', section.body, '']), content.cta || ''].filter(Boolean).join('\n');
  if (channel === 'newsletter') return [`# ${content.subject}`, '', `프리헤더: ${content.preheader}`, '', content.opening, '', ...content.modules.flatMap((module) => [`## ${module.heading}`, '', module.body, '']), content.cta || ''].filter(Boolean).join('\n');
  if (channel === 'instagram_carousel') return [`# Instagram Carousel`, '', `## 커버`, content.coverHook, '', ...content.slides.flatMap((slide, index) => [`## 슬라이드 ${index + 1}: ${slide.headline}`, slide.body, `- 시각 지시: ${slide.visualDirection}`, '']), content.caption ? `## 캡션\n${content.caption}` : '', content.hashtags?.length ? content.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ') : ''].filter(Boolean).join('\n');
  return [`# Short Video Script`, '', `## 훅`, content.hook, '', ...content.scenes.flatMap((scene, index) => [`## 장면 ${index + 1} · ${scene.durationSeconds}초`, `- 화면: ${scene.visual}`, `- 자막: ${scene.onScreenText || '없음'}`, `- 내레이션: ${scene.narration}`, '']), '## 마무리', content.ending, content.caption ? `\n## 게시 설명\n${content.caption}` : ''].join('\n');
}

function html(value) {
  return String(value ?? '').replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]).replace(/\n/gu, '<br>');
}

export function artifactWordPressHtml(channel, content) {
  if (!['naver_blog', 'wordpress_article'].includes(channel)) {
    throw issue('WORDPRESS_ARTICLE_REQUIRED', 'WordPress draft는 Naver Blog 또는 WordPress Article 결과물만 전송할 수 있습니다.', 422);
  }
  return [
    content.excerpt ? `<p><em>${html(content.excerpt)}</em></p>` : '',
    `<p>${html(content.intro)}</p>`,
    ...(content.sections || []).flatMap((section) => {
      const level = channel === 'wordpress_article' && section.headingLevel === 3 ? 3 : 2;
      return [`<h${level}>${html(section.heading)}</h${level}>`, `<p>${html(section.body)}</p>`];
    }),
    ...(content.faq || []).flatMap((row) => [`<h2>${html(row.question)}</h2>`, `<p>${html(row.answer)}</p>`]),
    content.cta ? `<p>${html(content.cta)}</p>` : ''
  ].filter(Boolean).join('\n');
}

export async function exportMarkdown(db, { workspaceId, userId, artifactId }) {
  return db.transaction(async (tx) => {
    const artifact = await approvedVersion(tx, workspaceId, artifactId, { lockArtifact: true });
    await lockArtifactVersionSources(tx, artifact);
    await assertCurrentSourceFresh(tx, { workspaceId, artifactId });
    await assertCurrentApprovalSafety(tx, { workspaceId, artifactId, artifact });
    const profile = await loadPlatformProfile(tx, artifact.channel_definition_version_id);
    const markdown = artifactMarkdown(artifact.channel, artifact.content, profile);
    await tx.query(`INSERT INTO exports (id, artifact_version_id, target, idempotency_key, status, external_id, created_by)
      VALUES ($1,$2,'markdown',$3,'succeeded',$4,$5)
      ON CONFLICT (artifact_version_id, target) DO UPDATE SET status='succeeded', updated_at=now()`, [id(), artifact.current_version_id, sha256(`markdown:${artifact.current_version_id}`), `download:${artifact.current_version_id}`, userId]);
    await audit(tx, { workspaceId, actorId: userId, action: 'artifact.markdown_exported', entityType: 'artifact', entityId: artifactId });
    return markdown;
  });
}

export async function exportWordPressDraft(db, {
  workspaceId,
  userId,
  artifactId,
  wordpressBaseUrl,
  username,
  applicationPassword,
  environment = 'production',
  testMode = false,
  network = {}
}) {
  if (!wordpressBaseUrl || !username || !applicationPassword) throw issue('WORDPRESS_CONFIG_REQUIRED', 'WordPress 주소, 사용자명, Application Password를 모두 입력하세요.');
  const root = wordpressBaseUrl.replace(/\/$/, '');
  assertCredentialedHttps(root, {
    environment,
    testMode,
    allowInsecureCredentialTransport: network.allowInsecureCredentialTransport
  });
  const fetchConfig = {
    ...network,
    maxBytes: 1_000_000,
    timeoutMs: Number(network.timeoutMs) || 12_000
  };
  const outcome = await db.transaction(async (tx) => {
    const artifact = await approvedVersion(tx, workspaceId, artifactId, { lockArtifact: true });
    await lockArtifactVersionSources(tx, artifact);
    await assertCurrentSourceFresh(tx, { workspaceId, artifactId });
    await assertCurrentApprovalSafety(tx, { workspaceId, artifactId, artifact });
    if (!['naver_blog', 'wordpress_article'].includes(artifact.channel)) throw issue('WORDPRESS_ARTICLE_REQUIRED', 'WordPress draft는 아티클 결과물만 전송할 수 있습니다.', 422);
    const idempotencyKey = sha256(`wordpress_draft:${artifact.current_version_id}`);
    const wordpressHtml = artifactWordPressHtml(artifact.channel, artifact.content);
    const slug = `osau-${artifact.current_version_id}`.toLowerCase();
    const headers = { authorization: `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString('base64')}`, accept: 'application/json', 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey };
    // The unique row and FOR UPDATE lock serialize lookup→create across web
    // processes. A concurrent caller waits, then reuses the committed draft
    // instead of racing a second remote create.
    await tx.query(`INSERT INTO exports (id,artifact_version_id,target,idempotency_key,status,created_by)
      VALUES ($1,$2,'wordpress_draft',$3,'pending',$4)
      ON CONFLICT (artifact_version_id,target) DO NOTHING`, [
      id(),
      artifact.current_version_id,
      idempotencyKey,
      userId
    ]);
    const exportRow = (await tx.query(`SELECT * FROM exports
      WHERE artifact_version_id=$1 AND target='wordpress_draft'
      FOR UPDATE`, [artifact.current_version_id]))[0];
    if (exportRow.status === 'succeeded') {
      return { externalId: exportRow.external_id, reused: true };
    }
    const stillApproved = (await tx.query(`SELECT 1 AS ok
      FROM artifacts current_artifact
      JOIN approvals approval
        ON approval.artifact_version_id=current_artifact.current_version_id
       AND approval.revoked_at IS NULL
      WHERE current_artifact.id=$1
        AND current_artifact.workspace_id=$2
        AND current_artifact.current_version_id=$3`, [
      artifactId,
      workspaceId,
      artifact.current_version_id
    ]))[0];
    if (!stillApproved) throw issue('APPROVAL_REQUIRED', '내보내기 전에 현재 버전을 명시적으로 승인해야 합니다.', 409);
    await tx.query(`UPDATE exports SET status='pending',error_message=NULL,updated_at=now()
      WHERE artifact_version_id=$1 AND target='wordpress_draft'`, [artifact.current_version_id]);
    await audit(tx, { workspaceId, actorId: userId, action: 'wordpress_draft.requested', entityType: 'artifact', entityId: artifactId, detail: { idempotencyKey } });
    try {
      const lookup = await safeFetch(`${root}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=draft`, { headers: { authorization: headers.authorization, accept: headers.accept } }, fetchConfig);
      if (!lookup.ok) throw issue('WORDPRESS_LOOKUP_FAILED', `WordPress 조회가 HTTP ${lookup.status}로 실패했습니다.`, 502);
      const matches = JSON.parse(await boundedText(lookup, 1_000_000));
      let post = Array.isArray(matches) ? matches[0] : null;
      if (!post) {
        const title = artifact.content.title || artifact.content.subject || artifact.content.coverHook || 'OSAU Draft';
        const create = await safeFetch(`${root}/wp-json/wp/v2/posts`, { method: 'POST', headers, body: JSON.stringify({ status: 'draft', slug, title, content: wordpressHtml }) }, fetchConfig);
        if (!create.ok) throw issue('WORDPRESS_DRAFT_FAILED', `WordPress 초안 생성이 HTTP ${create.status}로 실패했습니다.`, 502);
        post = JSON.parse(await boundedText(create, 1_000_000));
      }
      const externalId = wordpressDraftExternalId(post);
      await tx.query("UPDATE exports SET status='succeeded', external_id=$2, error_message=NULL, updated_at=now() WHERE artifact_version_id=$1 AND target='wordpress_draft'", [artifact.current_version_id, externalId]);
      await tx.query("UPDATE artifacts SET state='exported', updated_at=now() WHERE id=$1", [artifactId]);
      await recordDomainEvent(tx, { workspaceId, actorId: userId, eventType: 'wordpress_draft.exported', aggregateType: 'artifact', aggregateId: artifactId, payload: { externalId, idempotencyKey } });
      return { externalId, reused: false };
    } catch (error) {
      await tx.query("UPDATE exports SET status='failed', error_message=$2, updated_at=now() WHERE artifact_version_id=$1 AND target='wordpress_draft'", [artifact.current_version_id, error.message]);
      return { error };
    }
  });
  if (outcome.error) throw outcome.error;
  return outcome;
}
