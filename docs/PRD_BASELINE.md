# OSAU Production Alpha Baseline

## Product
OSAU is a self-hosted, agent-native content operations system for owned source content. It synchronizes sources, preserves immutable snapshots, extracts source-linked knowledge, plans channel-specific derivatives, supports explicit human review, computes freshness from exact provenance relationships, and exports approved artifacts.

## First operator
A content agency or 2–10 person content team running Naver Blog, YouTube, and WordPress.

## Initial production journey
1. Deploy and sign in as the single administrator.
2. Register a Naver/general RSS source and synchronize it.
3. Inspect a persisted SourceItem and immutable Snapshot.
4. Configure Creator Identity/Voice and an Audience Persona.
5. Analyze with a real OpenAI-compatible/Solar endpoint.
6. Select Naver Blog Draft and/or ShortVideoScript.
7. Generate only selected artifacts and review source relationships.
8. Resolve conflicts and explicitly human-verify factual blocks.
9. Process a source update and all exact affected blocks.
10. Approve and export Markdown or an idempotent WordPress draft.
11. Restart containers without losing content, history, or job state.

## P0 entities
Workspace, User, Session, Source, SourceSyncState, SourceItem, SourceSnapshot, SourceSegment, ContentAtom, CreatorIdentityVersion/Fact, CreatorVoiceVersion, AudiencePersonaVersion, ModelProviderConfig, Plan, PlanOutput, Run, RunStep, Artifact, ArtifactVersion, ArtifactBlock, BlockSourceRef, Verification, Approval, Export, DomainEvent, OutboxEvent.

## Non-negotiable semantics
- Provenance does not mean verification.
- Human verification is tied to a source snapshot and is invalidated by an affecting source change.
- `block_source_refs` is the only impact dependency source.
- Fixture/reference paths are test-only.
- External publishing is not part of Production Alpha; WordPress is draft-only and approval-gated.
- Platform playbooks are versioned guidance, not permanent algorithm claims.
