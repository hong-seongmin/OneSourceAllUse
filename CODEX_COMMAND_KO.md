이 저장소를 OSAU 실사용 Production Alpha로 끝까지 완성해.

먼저 `AGENTS.md`, `PRODUCT_INTENT.md`, `DESIGN.md`, `docs/PRD_BASELINE.md`, `tasks/PRODUCTION_BUILD.md`, `harness/README_KO.md`를 모두 읽어.

운영 규칙:
- Git 작업은 하지 마.
- 데모·정적 목업·토스트 전용 동작을 만들지 마.
- 실제 DB, 비동기 작업, 실제 RSS 처리, 실제 모델 Provider 경계, 영속 Artifact, 정확한 stale, 승인, Markdown, WordPress Draft까지 구현해.
- 시작 전에 `./harness/run.sh quick`을 실행하고 `evidence/preflight.md`에 현재 상태, 빠진 기능, 고위험 가정, 구현 순서를 기록해.
- 낮은 위험의 구현 세부사항은 합리적인 기본값으로 결정하고 계속 진행해.
- 외부 자격증명이나 되돌리기 어려운 제품 결정만 `BLOCKED_EXTERNAL_INPUT`으로 보고해.
- `harness/known-bad`, Product Truth, DESIGN.md의 핵심 의미, release gate를 수정하거나 약화하지 마.
- known-bad는 디스크에서 동적으로 열거하고 정확한 expected issue code로 실패시켜.
- `block_source_refs` 또는 동일한 단일 persisted relation을 stale 영향 계산의 유일한 기준으로 사용해.
- 자동 검사와 사람 확인을 같은 상태로 표시하지 마.
- 선택하지 않은 출력은 생성하지 마.
- Fixture Provider는 테스트 전용이며 production에서 즉시 실패해야 해.
- Naver/Short 결과는 길이만 다르게 만들지 말고 구조·목적·Preview·검사까지 다르게 구현해.
- DESIGN.md를 그대로 적용하고 가짜 버튼, 가짜 탭, 중복 내비게이션, 내부 ID 노출을 만들지 마.

진행 방식:
1. Preflight와 아키텍처 계획
2. Foundation와 DB/worker/auth
3. RSS ingestion
4. Model/Creator/Audience intelligence
5. Planner와 persistent artifacts
6. Review Workbench
7. Exact freshness와 refresh
8. Markdown/WordPress draft export
9. Release hardening

각 단계마다 `./harness/run.sh quick`을 실행해. DB·브라우저·컨테이너 경계를 구현한 뒤에는 `./harness/run.sh full`을 실행해. 마지막에는 `./harness/run.sh release`가 통과할 때까지 근본 원인을 수정해.

테스트를 통과시키려고 기대값·known-bad·release 기준을 느슨하게 하지 마. 실패한 기능을 숨기거나 완료됐다고 보고하지 마.

최종 보고서에 다음을 포함해:
- 실제 실행 방법
- 구현된 전체 사용자 흐름
- 데이터 모델과 마이그레이션
- 실행한 정확한 하네스 명령과 결과
- 보안·접근성·브라우저·컨테이너 결과
- 외부 live canary가 필요한 항목
- 남은 제품 위험
- 최종 판정: TECHNICAL_ALPHA_COMPLETE 또는 BLOCKED_EXTERNAL_INPUT
