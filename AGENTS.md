# OSAU Codex Contract

Before editing, read `PRODUCT_INTENT.md`, `DESIGN.md`, `docs/PRD_BASELINE.md`, `tasks/PRODUCTION_BUILD.md`, and `harness/README_KO.md`.

## Work rules

- The goal is a real, self-hosted Production Alpha, not a demo or screenshot.
- Do not perform Git operations unless the user explicitly asks.
- Do not weaken or rewrite `harness/known-bad`, Product Truth, or release gates to make work pass.
- Use real persistence and real runtime boundaries. Fixture data is test-only and must fail in production mode.
- Model-claimed provenance is not human verification.
- Source changes must invalidate the exact complete set of referencing blocks.
- Unselected outputs must not create artifacts.
- Creator Identity facts require explicit evidence; never fabricate lived experience or credentials.
- External publishing requires approval; WordPress integration creates drafts only.
- No unofficial browser automation for Naver, Instagram, TikTok, or other platforms.
- `DESIGN.md` is normative. Korean UI, one navigation system, real controls, no fake tabs/buttons, no decorative KPI filler.

## Required development loop

1. Run `./harness/run.sh quick` before changes.
2. Inspect the current repository and write `evidence/preflight.md` with gaps, assumptions, and implementation plan.
3. Implement the smallest complete vertical slice.
4. Run `./harness/run.sh quick` after every meaningful milestone.
5. Run `./harness/run.sh full` for integration and browser work.
6. Run `./harness/run.sh release` before claiming technical completion.
7. Fix root causes. Do not lower assertions, skip known-bad cases, or replace real flows with toast-only behavior.

## Completion language

- `TECHNICAL_ALPHA_COMPLETE`: all release gates pass except external live credentials explicitly marked as external canaries.
- `BLOCKED_EXTERNAL_INPUT`: only when real credentials or a product-owner decision are genuinely required.
- Never claim real-world usefulness without target-user evidence.
