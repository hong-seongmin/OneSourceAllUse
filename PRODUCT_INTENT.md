# OSAU Product Intent

## Product promise

Connect content once. Reuse it across channels without losing source truth, creator identity, or review control.

## Product truths

1. Never present model-claimed evidence as human-verified evidence.
2. Provenance and verification are separate data with separate UI semantics.
3. A source update must invalidate every affected block, including previously human-verified blocks.
4. Channel adaptation changes purpose, structure, and interaction—not merely length or wording.
5. Creator identity facts are evidence; creator voice is style. Never fabricate identity facts or lived experience.
6. Users choose outputs before generation; unselected outputs must not exist.
7. Failures preserve source data, user edits, event history, and retry boundaries.
8. External publishing obeys an explicit approval boundary and is never enabled by default.
9. Production runtime must not depend on fixture providers or reference-demo imports.
10. Automated tests establish minimum safety and contract compliance, not real-world usefulness.

## Initial production boundary

- Single administrator
- Single workspace
- Self-hosted Docker deployment
- PostgreSQL as system of record
- Naver/general RSS ingestion
- Transcript upload and YouTube metadata ingestion
- OpenAI-compatible model endpoint with Solar preset
- Naver Blog Draft and ShortVideoScript artifacts
- Grounded Review Workbench
- Source-change impact and partial refresh
- Markdown export and WordPress draft export

## Explicitly out of scope for initial Production Alpha

- Unofficial browser automation for Naver, Instagram, TikTok, or any platform
- Bulk rewriting of third-party content without explicit rights metadata
- Default unattended publishing
- Multi-tenant billing
- Full social scheduler
- Video timeline editor
- General-purpose workflow canvas
- Live trend scraping agent
