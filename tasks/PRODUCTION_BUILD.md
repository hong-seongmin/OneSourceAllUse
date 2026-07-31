# OSAU Production Build

Build a real single-workspace, self-hosted Production Alpha from this clean repository.

## Required user journey

1. Administrator can sign in.
2. Operator can register Naver/general RSS and synchronize it asynchronously.
3. Source items, immutable snapshots, segments, and atoms persist in PostgreSQL.
4. Operator can configure Creator Identity, Creator Voice, and Audience Persona.
5. Operator can configure and test an OpenAI-compatible model endpoint, including a Solar preset.
6. Planner creates only selected outputs: Naver Blog Draft and/or ShortVideoScript.
7. Review Workbench supports bidirectional source links and four evidence states.
8. Source updates calculate the exact complete affected-block set from persisted references.
9. Relevant prior human verification becomes re-verification required while history remains preserved.
10. Operator can choose partial refresh, full regeneration, or keep current result.
11. Approved artifacts can be exported as Markdown and sent as an idempotent WordPress draft.
12. Runs, steps, failures, retries, approvals, exports, and audit history persist.
13. Container restart preserves data and pending/finished work.
14. Loading, empty, partial, failure, recovery, and permission states are usable.

## Required architecture

- Web application plus background worker.
- PostgreSQL system of record.
- Transactional jobs/outbox or an equivalently safe persisted queue.
- Provider interfaces for models, connectors, and export targets.
- Production runtime cannot import harness fixtures or known-bad files.
- Korean-first UI and `DESIGN.md` compliance.

## Required technical gates

- Unit and domain invariant tests.
- Dynamic known-bad discovery with exact expected issue codes.
- PostgreSQL integration tests.
- Playwright E2E for the complete journey, keyboard, mobile, and recovery.
- Accessibility checks.
- SSRF, secret redaction, auth/session, approval-boundary, and fixture-isolation checks.
- Docker build, health/readiness, migration, and restart-persistence smoke test.

## External credentials

When real model or WordPress credentials are unavailable, implement the complete production boundary and use local protocol-compatible canaries. Report external live validation separately; do not replace production code with fixtures.
