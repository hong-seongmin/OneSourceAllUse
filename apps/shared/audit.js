import { id, stableKey } from './ids.js';

export async function audit(tx, { workspaceId, actorId = null, action, entityType, entityId, detail = {} }) {
  await tx.query('INSERT INTO audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [
    id(), workspaceId, actorId, action, entityType, entityId, JSON.stringify(detail)
  ]);
}

export async function recordDomainEvent(tx, { workspaceId, actorId = null, eventType, aggregateType, aggregateId, payload = {} }) {
  await tx.query('INSERT INTO domain_events (id, workspace_id, actor_id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [
    id(), workspaceId, actorId, eventType, aggregateType, aggregateId, JSON.stringify(payload)
  ]);
}

export async function enqueue(tx, { workspaceId, eventType, payload, dedupeKey = null, availableAt = null }) {
  const key = dedupeKey || stableKey(`${eventType}:${JSON.stringify(payload)}`);
  const rows = await tx.query(`INSERT INTO outbox_events (id, workspace_id, event_type, payload, status, available_at, dedupe_key)
    VALUES ($1,$2,$3,$4::jsonb,'pending',COALESCE($5::timestamptz, now()),$6)
    ON CONFLICT (dedupe_key) DO UPDATE SET status = CASE WHEN outbox_events.status = 'failed' THEN 'pending' ELSE outbox_events.status END,
      available_at = LEAST(outbox_events.available_at, EXCLUDED.available_at)
    RETURNING id`, [id(), workspaceId, eventType, JSON.stringify(payload), availableAt, key]);
  return rows[0].id;
}
