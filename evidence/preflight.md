# OSAU Production Alpha preflight

## 2026-07-31 UI/UX Production Alpha hardening preflight

### Current baseline

- Read the governing contract and product/design documents again before this
  change: `AGENTS.md`, `PRODUCT_INTENT.md`, `DESIGN.md`,
  `docs/PRD_BASELINE.md`, `tasks/PRODUCTION_BUILD.md`, and
  `harness/README_KO.md`.
- `./harness/run.sh quick` passed before any UI/UX change:
  contract and design checks passed, dynamically discovered known-bad cases
  passed with their exact expected issue codes, and the unit/known-bad suite
  passed.
- Existing runtime boundaries remain real: Express SSR/API, persisted
  PostgreSQL-compatible state, transactional outbox/worker, real connector
  and model-provider interfaces, immutable artifact versions, exact
  `block_source_refs` freshness, approval-gated Markdown and WordPress draft
  export.

### Confirmed gaps

1. Operational tables enforce a 700px minimum width and become horizontal
   scroll surfaces on mobile; the fixed mobile approval form can cover review
   queue entries.
2. Some user-visible routes fall through to internal identifiers and enum
   values, while disabled approval styling and interactive control borders do
   not meet the intended non-text/reading contrast.
3. All three input dialogs default rights to `owned`, rather than requiring
   an explicit operator decision.
4. Inbox, runs, planner, and Review repeat context instead of exposing a
   compact next action; Planner cards do not use their already-versioned
   profile metadata to communicate output shape.
5. The design-review evidence bundle has a duplicate selected-block capture
   and stale tab metadata. It is a capture-pipeline defect, not an artifact
   provenance defect.

### High-risk invariants

- UI presentation must never turn automatic checks or model claims into human
  verification. Segment navigation may select a block but must never write a
  verification.
- `block_source_refs` remains the sole persisted relation for stale impact;
  UI progress, profile metadata, suggestions, and display hints are not
  freshness dependencies.
- Regeneration must create a new immutable version through the existing
  worker boundary, preserve earlier history, and require server-validated
  acknowledgement of re-verification.
- Existing immutable channel profile versions are not edited in place.
  Planner visual hints derive from existing `render_metadata`.
- No raw internal IDs are rendered in user text. The `data-*` values used for
  real interaction remain opaque implementation details, not UI content.

### Implementation order

1. Add a shared presentation mapping, explicit rights validation, semantic
   contrast tokens, and real icon-bearing status controls.
2. Convert Inbox/Runs to responsive operational cards without duplicating
   records or hiding the primary next action; compact Planner selection using
   existing profile metadata.
3. Recompose Review around persisted block selection, an accessible progress
   summary, a non-overlapping mobile approval bar, and server-enforced
   regeneration confirmation.
4. Add Playwright, token, geometry, and capture-manifest regressions using an
   isolated test DB and local protocol canaries only in test mode.
5. Run quick after each slice, full after browser/worker work, then release;
   repair failures without weakening any contract, known-bad case, or gate.

작성 시각: 2026-07-29 UTC
최종 완료 기록 갱신: 2026-07-30 UTC

## 변경 전 기준선

- 필수 계약 문서 `AGENTS.md`, `PRODUCT_INTENT.md`, `DESIGN.md`,
  `docs/PRD_BASELINE.md`, `tasks/PRODUCTION_BUILD.md`,
  `harness/README_KO.md`를 모두 다시 읽었다.
- 변경 전 정확한 명령 `./harness/run.sh quick`은 PASS했다.
  - contract: PASS
  - design: PASS
  - known-bad contract: PASS (디스크에서 발견한 기존 6건)
  - unit: 7/7 PASS
  - known-bad runtime: 1/1 PASS
- 이 PASS는 기존 최소 계약과 구조 검사를 뜻한다. 생성문의 사실성,
  목적 적합성, 채널별 편집 품질 또는 실사용 유용성을 증명하지 않는다.
- Node.js v24.18.0과 npm 11.16.0은 사용할 수 있다. 현재 호스트에는
  Docker와 `psql`이 없으므로 실제 Docker 기동은 이 환경에서 수행할 수 없는
  외부 런타임 canary로 분리한다. PostgreSQL 마이그레이션과 SQL 경계는
  PGlite 통합 canary로도 검증하되 이를 실제 Docker 검증으로 표시하지 않는다.
- 상위 프로젝트의 `/home/hong/code/solar-contents/OSAU/.env`에는 값이 설정된
  `UPSTAGE_API_KEY`가 있다. 값은 출력하거나 저장소에 복사하지 않는다.
  기본 production 모델은 Upstage `solar-open2`로 유지하고 실제 API 호출
  canary는 별도 품질 보고서에 기록한다.

## 현재 구현된 기술 골격

- Express 웹 애플리케이션, 독립 worker, PostgreSQL용 migration 2개,
  persisted outbox, 세션 인증, RSS 동기화, Provider 암호화 저장, Planner,
  Artifact/Block/`block_source_refs`, Review, exact stale, Markdown 및
  WordPress draft 경계가 존재한다.
- Naver Blog, WordPress Article, Newsletter, Instagram Carousel,
  범용 Short Video의 서로 다른 JSON 구조·Preview·Markdown 경계가 있다.
- 선택하지 않은 output을 생성하지 않는 plan/outbox 흐름과 production에서
  Fixture Provider를 거부하는 경계가 있다.
- 애플리케이션은 `0.0.0.0` bind 및 내부 HTTP 운영 설정을 지원하며,
  현재 제품 계약상 인증 자체를 제거하지는 않는다.

## 확인된 기능·품질 공백

1. 채널 카탈로그가 코드의 5개 상수와 얕은 DB 정의에 묶여 있다. 한
   workspace에서 한 채널의 활성 버전 하나만 보장하지 않고, 최신 버전의
   prompt/schema/rubric/공식 근거를 immutable data로 고정하지 않는다.
2. 사용자가 선택한 7개 대상 중 YouTube Shorts, Instagram Reels,
   TikTok Video가 독립 프로필·설정·Preview·검사를 갖지 않는다. 기존
   `short_video:v1`은 과거 Artifact 호환용 legacy로만 남겨야 한다.
3. RSS HTML 정제가 불완전하고 Naver RSS 절단 가능성, 사용 가능 원자,
   권리 상태, prompt injection 격리 상태를 persisted readiness로
   판정하지 않는다.
4. 생성은 전체 atom을 한 번의 공통 prompt에 넣고 구조만 검사한다.
   목적 적합성, evidence plan, 콘텐츠 예산, 원자 주장별 entailment,
   identity 본문 검사, platform critic, 제한적 repair가 없다.
5. 제목·excerpt·preheader·caption·ending·visual direction 등 사용자에게
   보이는 사실성 표면 일부가 `artifact_block`과 provenance 대상이 아니다.
   CTA를 무조건 비사실 블록으로 취급해 일정·가격·효과 주장을 놓칠 수 있다.
6. 채널 설정(FAQ, slide count, 목표 시간, caption 등)이 prompt에만 들어가고
   결과 구조와 결정적 검사에서 완전히 강제되지 않는다.
7. 동일 Solar를 평가기로 사용할 때 생성기와 분리된 자동 검사임을 표시하지
   않으며, evaluator 계약·calibration·cache가 없다. 자동 검사가 사람 확인으로
   승격되어서는 안 된다.
8. 미확인 factual block이 남아 있어도 현재 승인할 수 있다. block 편집,
   immutable 새 ArtifactVersion, 자동 finding과 사람 확인의 분리된 화면,
   부분 원본 명시적 확인 정책이 부족하다.
9. 부분 refresh가 최신 atom `text`를 조회하지 않는 결함이 있고, 원래
   purpose/audience/voice/profile/finding 없이 stale block만 다시 쓴다.
   변경된 block의 human verification 무효화와 전체 품질 재검사가 필요하다.
10. 다중 output run에서 부분 실패 뒤 최종 성공이 run 전체 성공으로 덮일 수
    있다. 모델 호출·평가·repair의 attempt, usage, 오류와 retry가 충분히
    영속되지 않는다.
11. 현재 release gate는 실제 semantic 품질 corpus, evaluator calibration,
    7개 플랫폼 adaptation, 생성 이후 전체 브라우저 흐름과 실제 Docker
    기동을 보장하지 않는다.

## 고위험 가정과 결정

- `block_source_refs`를 source-change 영향 계산의 유일한 persisted relation으로
  유지한다. evidence plan과 평가 결과는 설명·검사 자료이지 stale dependency가
  아니다.
- Naver RSS가 부분 원본이어도 정제 후 완전한 atom이 있으면 경고와 누락 범위를
  표시하고 생성은 허용한다. 새 사실을 채우지 않으며 승인 전에 부분 원본
  acknowledgement와 모든 factual block의 사람 확인을 요구한다. 사용할 근거가
  없거나 목적이 맞지 않거나 injection 위험이면 생성 전 차단한다.
- 구조적으로 사실인 코드 plugin은 `article`, `email`, `card_sequence`,
  `timed_vertical_video`로 제한한다. 변동 가능한 플랫폼 방법론은 검증된
  immutable `PlatformProfileVersion`으로 관리하며 임의 실행 코드나 검증되지
  않은 prompt를 UI에서 입력받지 않는다.
- 기본 생성기는 Upstage `solar-open2`다. 같은 Solar 평가기는 별도 호출·prompt
  ·기록 경계에서 `LOW_ASSURANCE`로만 표시한다. 자동 검사 통과는 사람 확인이
  아니다.
- 모든 사용자 표시 문자열은 `factual | editorial | production` block으로
  만들고, factual block만 allowlist atom handle을 요구한다. 모델이 넘긴
  relation을 그대로 믿지 않고 애플리케이션이 검증한 후에만
  `block_source_refs`를 기록한다.
- repair는 schema repair 1회, 콘텐츠 repair 최대 2회로 제한한다. 통과한
  block은 불필요하게 다시 생성하지 않고 실패 후보와 finding을 보존한다.
- 기존 migration, Artifact, 기존 `short_video:v1`, 기존 known-bad 6건과
  expected issue code는 변경·삭제하지 않고 호환 보존한다.
- WordPress는 승인된 현재 버전의 `draft` 생성만 허용한다. Naver, Instagram,
  TikTok 등에는 비공식 발행 자동화를 추가하지 않는다.

## 구현 순서

1. Foundation: immutable 플랫폼 프로필, 안전한 plugin registry, Provider
   capability, 품질 시도·finding·repair 및 source readiness migration.
2. RSS ingestion: active HTML 제거, URL 조각 제거, 부분/불충분/격리 판정,
   권리·누락 상태 영속.
3. Intelligence: evidence-first plan, 목적 적합성, 구조화 생성, 결정적 검사,
   strict entailment/identity evaluator, 최대 2회 targeted repair.
4. Planner와 Artifact: 7개 동적 프로필, 설정 schema 검증, 선택 output만
   생성, 모든 visible surface의 persisted block/provenance.
5. Review Workbench: 프로필별 실제 Preview, 자동 finding과 사람 확인 분리,
   immutable block edit, 강한 approval boundary.
6. Freshness: 최신 source text와 원래 brief/profile을 사용한 exact patch,
   `block_source_refs` 기반 전체 영향, verification invalidation 및 재검사.
7. Export: 새 article/email/card/video schema의 Markdown과 승인된
   WordPress draft 직렬화·idempotency·retry 검증.
8. Quality harness: 기존 known-bad 보존, 새 issue-code corpus, 7개 플랫폼
   deterministic matrix, evaluator contract/calibration, unselected relation,
   exact stale, approval, injection 회귀.
9. UI·release hardening: desktop/mobile/keyboard/accessibility E2E, worker/DB
   통합, 보안, container 경계, Solar 반복 canary와 방법론 문서.

각 의미 있는 milestone 뒤 `./harness/run.sh quick`, DB·worker·브라우저·컨테이너
경계 뒤 `./harness/run.sh full`, 마지막에 `./harness/run.sh release`를 실행한다.
실패하면 기대값이나 release gate를 낮추지 않고 근본 원인을 수정한다.

## 2026-07-29 Planner 전체 소스 자동입력 확장

### 시작 상태

- 변경 전 `./harness/run.sh quick`: PASS.
- unit/profile/adapter/readiness/quality 49건과 디스크에서 동적으로 찾은
  known-bad 15건이 모두 기존 expected issue code로 통과했다.
- 현재 Planner는 한 `SourceItem.latest_snapshot_id`만 계획에 고정하고,
  채널 입력은 `workspace_channel_catalog.default_settings`와
  `settings_schema.default`만 사용한다. 모든 Profile의 `purpose`는 비어
  있으며 추천 run, 추천 근거, 예상 편집량, 다중 원본 Plan 관계가 없다.

### 이번 변경에서 반드시 메울 공백

1. 명시적 추천 버튼이 실제 Solar Provider와 persisted worker/outbox를 통해
   작업공간의 적격 최신 원본 전체를 분석해야 한다.
2. 모든 활성 Profile의 모든 settings property를 schema 기반으로 추천하되
   채널을 자동 선택하거나 미선택 output/Artifact를 만들면 안 된다.
3. 현재 원본을 primary로 고정하고 관련 보조 원본은 자동 포함하되 사용자가
   생성 전에 제외할 수 있어야 한다.
4. 다중 원본 factual block은 모든 정확한 atom을 `block_source_refs`에
   기록하고 Review에서 원본별로 대조할 수 있어야 한다.
5. stale 영향 집합은 다중 원본에서도 오직 `block_source_refs`에서 계산하고,
   추천·Plan source 관계를 영향 계산에 사용하면 안 된다.
6. 자동 추천과 모델 평가는 사람 확인 또는 승인으로 표시·저장하지 않는다.

### 고위험 가정과 구현 순서

- supplemental 후보는 같은 workspace의 최신 snapshot 중 권리가
  `owned|licensed`이고 readiness가 `complete|partial`이며 usable atom이 있는
  원본으로 제한한다. 제외된 원본과 이유는 숨기지 않는다.
- 추천은 전체 적격 corpus를 bounded batch로 모두 고려하되 최종 Plan에는
  primary와 최대 8개의 관련 보조 snapshot만 고정한다. 동일 fingerprint는
  primary atom을 우선한다.
- 원본·Profile·선택 context가 추천 중 변경되면 결과 이력은 보존하지만
  적용하지 않는다. 사용자 입력은 비동기 완료로 덮어쓰지 않는다.
- 기존 단일 원본 Plan/Artifact/verification은 migration backfill로 호환한다.
- 구현 순서는 `009 migration 및 추천 job → Plan/generation 다중 원본 →
  exact freshness/verification/refresh → Planner/Review UI → full/release`다.

## 2026-07-29 중간 구현 기록

- `009_planner_suggestions.sql`을 production DB에 적용했고 schema는
  `001`~`009`, 54개 base table이다.
- `내 소스로 기본값 추천`은 실제 Provider와
  `prepare → analyze batch → finalize` outbox/worker 경계를 사용한다.
  운영 canary에서 활성 Profile 7개와 설정 field 25개를 모두 nonblank로
  영속했고 채널은 자동 선택하지 않았다.
- plan/run/Artifact version에 exact 다중 원본 snapshot·seed를 고정했다.
  최종 factual dependency와 stale 영향 집합의 유일한 persisted 기준은 계속
  `block_source_refs`다.
- verification은 `verification_source_refs`의 exact
  source-item+fingerprint 집합으로만 이관한다. v1→동일 fingerprint v2→변경
  v3의 transitive invalidation과 delayed/replayed event 수렴을 검증했다.
- 당시 v3 timed video는 capacity 기반 정확한 scene 수와 server-owned
  duration plan을 사용했다. 순수 밀도 repair는 Provider가 인용 원문 token
  삭제·순서 보존 문자열 후보를 만들고 서버가 실제 단위와 수정 블록
  entailment를 다시 검사하는 경계였다. 2026-07-30의 v4 서버 인증 ID
  계약은 아래 최종 완료 기록에 별도로 적는다.
- 당시 실제 Solar Open2 전체 run:
  `live-solar-open2-server-planned-all-seven-20260729-162512.json`
  - selectable Profile 7/7
  - injection PASS
  - 별도 TikTok 49→23 density repair canary PASS
  - `LOW_ASSURANCE`, `automaticOnly=true`, `humanVerified=false`
- 당시 gate:
  - `./harness/run.sh quick`: unit 58/58, runtime known-bad 2/2,
    disk known-bad 15건 PASS
  - `./harness/run.sh full`: PostgreSQL 4/4, quality 28/28,
    Chromium E2E 2/2, security 6/6 PASS
  - 격리 LXD/Docker에서 `./harness/run.sh release`: container 2/2,
    release invariant 4/4 포함 전체 PASS
- 운영 web/worker를 당시 코드로 재시작했다. `0.0.0.0:3000`, local/LAN
  health·ready·inbox 200, 외부 Host 403, `/login`→`/app/inbox` 302다.
  실제 LAN Chromium에서 Planner 200, 추천 control, 동적 Profile 7개,
  선택 output 0, 내부 UUID 미노출을 확인했다.

## 2026-07-30 실제 TikTok 밀도 실패 재현

### 변경 전 기준선

- `./harness/run.sh quick`: contract/design PASS, disk known-bad 15건,
  unit 58/58, runtime known-bad 2/2 PASS.
- production의 2026-07-30T03:13:10.177Z `tiktok_video` 실행은
  `QUALITY_REPAIR_CONSTRAINT_VIOLATION`으로 정확히 실패했다.
- 30초 server duration plan은 3/14/13초였고 내레이션은 각각
  53/169/169 발화 단위로, 허용 상한 18/84/78을 모두 초과했다.
- 초안 attempt 1은 `schema_failed`로 영속됐지만 Solar의 두 번째
  schema-repair 응답은 constraint 적용 중 예외가 발생해 attempt row로
  저장되지 않았다. 관련 unit 32건은 모두 통과해 production 형태의
  다중 경로·긴 한국어 회귀가 빠졌음을 확인했다.

### 구현 순서와 불변 조건

1. timed-video의 고정 duration과 6 units/sec 제한은 유지한다.
2. 서버가 허용 원본의 연속 구간에서 길이·괄호·근거가 검증된 narration
   후보를 만들고 Provider는 opaque candidate ID만 선택하게 한다.
3. 실제 사용한 source handle subset과 text를 원자적으로 교체하며, 최종
   Artifact의 factual dependency는 계속 `block_source_refs`만 사용한다.
4. 신규 handle, 범위 밖 path, duration 변경, 안전 후보 부재는 fail closed
   하고 성공·실패 Provider attempt를 모두 영속한다.
5. 기존 실패 run을 변경하지 않고 새 retry run으로 실제 Solar/Chromium
   E2E를 수행한다. 자동 검사와 사람 확인·승인은 계속 분리한다.
6. focused regression → quick → full → 실제 production retry → release 순으로
   검증하며 실패 기대값이나 release gate를 낮추지 않는다.

## 2026-07-30 완료 기록

### 근본 수정과 회귀

- 품질 pipeline을 `grounded-channel-pipeline.v4`로 올리고 timed-video 밀도
  복구를 `server-certified-narration.v1`로 분리했다.
- 서버가 validator가 허용한 source atom의 연속 공백 token 구간을 열거하고
  text, 실제 발화 단위, exact 한-handle `atomRefs`, 고정 duration과 예산을
  hash 기반 opaque `candidateId`로 인증한다.
- Provider 응답은 exact narration path와 이미 인증된 `candidateId` 선택만
  허용한다. Provider가 narration 문자열, duration, kind나 `atomRefs`를
  작성하지 않는다.
- 인증 plan 변조, 신규 handle, duration drift, 범위 밖 path는
  `NARRATION_DENSITY_CERTIFICATION_INVALID` 또는
  `QUALITY_REPAIR_SCOPE_VIOLATION`, 안전 후보 부재는
  `NARRATION_DENSITY_RECOVERY_EXHAUSTED`로 fail closed한다.
- 실제 production과 같은 30초 3/14/13 scene, 53/169/169 발화 단위와
  상한 18/84/78의 세 경로 동시 실패를 unit, HTTP Provider,
  DB/worker attempt 영속, Chromium 실패→Provider 선택→새 retry→Review
  경계까지 회귀에 추가했다.
- 첫 v4 live targeted run
  `live-solar-open2-v4-certified-tiktok-20260730.json`은 Solar가 응답
  narration path 대신 request-document path
  `$.narrationRepairPlan.slots[0]`을 반환해
  `QUALITY_REPAIR_SCOPE_VIOLATION`, `INSUFFICIENT`로 실패했다. 이 evidence를
  삭제하거나 뒤의 PASS에 합산하지 않았다.
- 응답용 `outputContract.selections`에 exact path와 allowed candidate ID를
  평탄화하고 request-document path 금지를 명시했다. 별도 targeted
  `live-solar-open2-v4-certified-tiktok-path-contract-20260730.json`은
  `provider_selected`, 49→26≤30, duration·source handle·entailment 보존으로
  1/1 PASS했다.
- 별도 전체
  `live-solar-open2-v4-certified-all-seven-20260730.json`은 selectable
  Profile 7/7, injection과 v4 density repair를 모두 통과했다.
  `LOW_ASSURANCE`, `automaticOnly=true`, `humanVerified=false`이며 대상
  사용자 유용성이나 사람 확인을 뜻하지 않는다.

### Production retry와 재시작 확인

- `production-tiktok-retry-2026-07-30T04-29-40-715Z.json`은 LAN browser,
  production PostgreSQL/outbox/worker와 실제 Solar로 기존 v3 실패의
  fingerprint를 바꾸지 않고 새 v4 retry run과 Artifact를 생성한 증거다.
- 새 실행은 `draft/schema_failed(CHANNEL_CONSTRAINT_FAILED)`와
  `schema_repair/accepted` 두 attempt를 영속했다.
- 최종 Preview는 3/14/13초, narration은 17/62/58 발화 단위로 각
  18/84/78 상한 이하이고 exact source dependency를
  `block_source_refs`에 저장했다.
- source readiness가 `partial`이므로 성공을 숨기지 않으면서도
  `qualityStatus: warning`을 유지했다. Review Workbench와 Runs/Review axe
  검사를 통과했고 verification 0건, approval 0건, 사람 확인 전 승인 차단,
  `LOW_ASSURANCE` 상태를 확인했다.
- 최종 web/worker 재시작 뒤 mutation 없는 read-only canary로 기존 실패
  fingerprint와 성공한 현재 output을 다시 확인했다. 새 run이나 Artifact는
  만들지 않았다.
- 운영 listener는 `0.0.0.0:3000`이고 local health/ready, LAN
  `/health`와 `/app/runs`는 HTTP 200, 외부 Host header는 403,
  `/login`은 `/app/inbox`로 302다. active outbox는 0이며 terminal 실패
  이력은 보존된다.

### 최종 gate

마지막 quick:

```bash
./harness/run.sh quick
```

- contract/design PASS
- unit 63/63 PASS
- runtime known-bad 2/2 PASS
- 디스크에서 동적으로 열거한 known-bad 15건이 exact expected issue code로 PASS

마지막 full의 exact shell:

```bash
bash -c 'set -a
source /home/hong/.local/share/osau/runtime.env
set +a
export OSAU_POSTGRES_TEST_URL="$DATABASE_URL"
exec ./harness/run.sh full
'
```

- runtime module build 27 PASS
- 실제 PostgreSQL isolated schema integration 4/4 PASS
- quality 29/29 PASS
- Chromium E2E 3/3 PASS
- security 6/6 PASS

최종 full 직전 한 실행은 redirect 없는 성공 form의 500ms 지연 reload가 다음
browser 조작과 충돌하는 race를 드러냈다. 지연 timer를 제거하고 성공 직후
같은 문서를 reload하도록 근본 원인을 수정했으며 server 계약이나 assertion을
낮추지 않았다. 위 exact full을 다시 실행해 전체 PASS했다.

호스트에서 Docker 검사를 skip하지 않고 격리 LXD runner의
`/workspace/osau-release-20260730-045110`과 PostgreSQL 16
`127.0.0.1:55433`을 사용해 다음 exact command를 실행했다.

```bash
lxc exec osau-release-runner \
  --cwd /workspace/osau-release-20260730-045110 \
  -- env \
  OSAU_POSTGRES_TEST_URL=postgresql://osau:osau_release_test@127.0.0.1:55433/osau_release \
  ./harness/run.sh release
```

- `OSAU harness 'release': PASS`
- 실제 Docker Compose smoke 2/2 PASS
- release invariant 4/4 PASS
- quick/build/PostgreSQL/quality/E2E/security도 release 안에서 다시 PASS
- 검증 뒤 전용 PostgreSQL container, release workspace와 host temporary
  archive를 제거하고 55433 임시 port를 남기지 않음

known-bad payload, expected issue code, Product Truth, `DESIGN.md`, release
gate는 수정하거나 약화하지 않았다.

### 최종 판정과 남은 외부 경계

최종 판정은 **TECHNICAL_ALPHA_COMPLETE**다. 이는 release gate, 실제
PostgreSQL/Docker/browser, LAN 운영, actual Solar v4 7-profile simulation과
기존 실패를 보존한 production retry가 통과했다는 기술 판정이다.

실제 WordPress site/Application Password draft canary, 독립 evaluator의
`HIGH_ASSURANCE`, 다양한 실제 RSS·언어·길이, 실제 platform device rendering,
Firefox/WebKit/실제 mobile과 수동 screen reader, backup/restore·장기 soak,
대상 사용자 검수는 외부 또는 후속 운영 evidence로 남는다. 자동 통과를
사람 확인이나 실제 콘텐츠 성과로 승격하지 않는다.

## 2026-07-30 생성 완료 후 검토 진입 UX preflight

### 변경 전 상태

- 이번 변경 직전 `./harness/run.sh quick`은 PASS했다.
  - unit 63/63 PASS
  - runtime known-bad 2/2 PASS
  - 디스크에서 동적으로 발견한 known-bad 15건 PASS
- Planner와 실패 결과물 재시도 API는 모두 영속 `runId`를 반환한다.
  기존 화면은 이를 사용하지 않고 `/app/runs`로만 이동한다.
- 실행 기록의 성공한 `artifact_generation` 행은 단순히 `기록 유지`를
  표시한다. 실제 결과물 및 Review Workbench 링크는 별도 결과물 표에 있어,
  방금 끝난 실행과 다음 검토 행동의 연결이 화면상 명확하지 않다.
- 정확한 관계는 이미 영속돼 있다. `generation_executions.run_id`와
  `plan_output_id`, 그리고 `plan_outputs.artifact_id`를 사용하고, 실행이
  시작되기 전에는 `outbox_events.payload.runId` 및 `planOutputId`를 사용해
  대상 출력을 정확히 찾을 수 있다. 추정·최신 결과물 순서·UI 상태를 쓰지 않는다.

### 이번 변경의 공백과 고위험 가정

1. 성공 표시는 자동 검사·artifact 저장 완료일 뿐 사람 검토나 승인이 아니다.
   따라서 성공 요약은 반드시 `자동 검사 완료 · 사람 확인 필요`를 명시한다.
2. 한 실행에는 복수의 선택 출력이 있을 수 있다. 임의로 첫 결과물을 열지 않고
   채널별 실제 Review Workbench 링크를 제공한다.
3. retry는 원래 실패 실행을 절대 수정하지 않는다. 새 retry `runId`만 새 결과
   요약과 연결해야 한다.
4. 계획 생성 또는 재시도 뒤에는 Review로 자동 이동하지 않는다. 사용자가
   실행 요약에서 명시적으로 검토를 시작한다.
5. run query parameter는 현 작업공간의 생성/생성 재시도 run만 허용하고
   화면에 internal ID를 렌더하지 않는다.

### 구현·검증 순서

1. Planner/retry 응답의 `runId`로 범위 지정 실행 기록 화면으로 이동시키는
   좁은 client redirect 경계를 추가한다.
2. Runs route에서 persisted run-target relation을 조회해 `이번 생성` 요약,
   상태별 다음 행동, exact Review link를 렌더한다.
3. 실행 이력 표에서 생성 성공의 `기록 유지`를 실제 검토 action으로 교체하고,
   실패·보류·진행 상태의 복구 의미를 유지한다.
4. 단일·복수 출력·retry·held/failed·자동 검사/사람 확인 경계의 browser E2E와
   accessibility 검사를 추가한다.
5. milestone quick, DB/browser full, 최종 release를 실행한다. known-bad,
   Product Truth, DESIGN.md, release assertion은 변경하거나 약화하지 않는다.

## 2026-07-30 생성 완료 → 검토 시작 UX 완료 기록

### 구현 결과

- Planner와 결과물 재시도는 API가 돌려준 새 영속 `runId`로
  `/app/runs?run=…#current-generation`에 이동한다. Review Workbench로
  자동 이동하지 않으며, 사용자가 명시적으로 검토를 시작한다.
- Runs 화면은 `generation_executions`의 exact `artifact_version_id`와
  `plan_output_id`, 실행 전 outbox payload의 `runId`/`planOutputId`를 함께
  사용해 해당 실행의 대상만 찾는다. 변경 가능한 최신 결과물이나 UI 추정을
  사용하지 않는다.
- 단일 성공 결과에는 하나의 실제 `Review Workbench에서 검토 시작` 행동을,
  복수 결과에는 임의의 첫 결과물 선택 없이 채널별 실제 검토 행동을 표시한다.
  재시도는 새 실행으로 표시하며 기존 실패 이력은 유지한다.
- 자동 검사와 사람 확인을 분리했다. 성공·부분 원본 경고·보류·실패·진행의
  다음 행동을 각각 명시하고, 생성 실행 이력의 모호한 `기록 유지`는 실제
  `다음 작업`으로 바꿨다. 내부 ID는 화면에 표시하지 않는다.

### 최종 검증

- `./harness/run.sh quick`: PASS (unit 63/63, runtime known-bad 2/2,
  디스크 동적 known-bad 15건).
- `OSAU_POSTGRES_TEST_URL`을 격리 PostgreSQL에 연결한
  `./harness/run.sh full`: PASS (runtime build 27, PostgreSQL integration
  4/4, quality 29/29, browser E2E 3/3, security 6/6).
- 격리 LXD release runner에서 실제 Docker Compose 경계를 포함한
  `./harness/run.sh release`: PASS. container smoke 2/2 및 release
  invariant 4/4도 통과했다.
- 실제 내부 운영 인스턴스에서 `0.0.0.0:3000` listener와 `/ready`를 확인했고,
  desktop/mobile browser에서 성공 요약의 사람이 누르는 검토 행동을 확인했다.
  그 행동을 직접 눌러 Review Workbench 도착까지 검증했으며, 단일 결과에서
  잘못된 저장 결과물 연결 경고가 나오던 fallback도 수정 후 재검증했다.

스키마 변경은 필요하지 않았다. 기존의 immutable execution, exact artifact
version, outbox relation을 조회 경계에만 사용했다. known-bad payload,
expected issue code, Product Truth, `DESIGN.md`, release gate는 변경하거나
약화하지 않았다.

## 2026-07-31 사람 원본 대조 큐 UX preflight

### 현재 상태와 공백

- 변경 전 `./harness/run.sh quick`은 PASS했다. unit 63/63, runtime
  known-bad 2/2, 디스크 동적 known-bad 15건이 모두 통과했다.
- 운영 데이터에서 확인한 현재 11건 사례는 모두 factual block이며 각 block에
  영속 source ref가 있다. 따라서 `원본 연결 없음`을 숨기거나 검증을 우회할
  이유가 없다.
- `approvalBlockers()`는 current artifact version의 `block_source_refs`와
  `verification_source_refs`를 양방향 exact-set 비교해 미확인 factual block을
  이미 반환한다. `getArtifactReview()`과 browser는 이 관계를 다시 추정하지
  않아야 한다.
- 현재 Review Workbench는 첫 block을 선택하고, 사용자가 11개 factual block을
  직접 찾아 선택·검사 탭 전환·메모 입력해야 한다. 진행률, 다음 실제 블록,
  다른 blocker의 실제 처리 위치가 표시되지 않는다.

### 고위험 가정과 고정 결정

1. 자동 평가, 자동 근거 지원, UI 선택은 사람 확인 또는 승인으로 승격되지
   않는다. 블록별 사람 메모와 기존 `POST /api/blocks/:blockId/verify`만
   verification을 만든다.
2. 사람 대조 큐는 human-verification blocker만 다룬다. 자동 실패, stale,
   held, conflict, 부분 원본 acknowledgement는 서로 다른 상태로 보존하고
   가능한 경우에만 기존의 실제 처리 위치로 연결한다.
3. 진행률과 큐는 current version의 persisted blocker 목록에서 매 렌더
   재계산한다. 숫자 11, source position, block ID를 하드코딩하거나 UI cache를
   source of truth로 사용하지 않는다.
4. 최초와 성공적 대조 기록 뒤에는 ordinal 순서의 다음 pending block을
   선택할 수 있게 하되, 선택만 할 뿐 자동 대조·자동 승인하지 않는다.
5. 새 schema, bulk verification write API, URL internal ID 노출은 만들지
   않는다. source ref 없는 factual block은 실제 검증 control을 만들지 않고
   명확한 복구 설명을 유지한다.

### 구현·검증 순서

1. review read model에 exact pending queue와 completed/total count를
   추가하고, source drift/invalidated verification의 기존 fail-closed 의미를
   유지한다.
2. Workbench의 승인 사유에 사람 대조 진행 요약, 실제 다음/개별 block 선택,
   현재 선택과 동기화된 원본·검사 화면을 추가한다.
3. 다른 blocker에는 검사·변경 영향·해당 block 등 실제 위치만 연결하고,
   처리할 수 없는 상태에는 가짜 버튼을 만들지 않는다.
4. desktop/mobile keyboard 흐름과 대조 성공 후 persisted state 재렌더를
   E2E로 검증한다. quick, full, release 순서로 root cause를 고친다.

## 2026-07-31 사람 원본 대조 큐 UX 완료 기록

### 구현 결과

- `getArtifactReview()`은 기존 approval blocker와 current review block의 exact
  verification state를 사용해 `humanVerification.progress`와 pending queue를
  반환한다. total/completed/pending과 actionability는 current artifact version의
  영속 관계에서 계산되며, schema와 verification write API는 추가하지 않았다.
- Review Workbench는 `사람 원본 대조 0/11 완료 · 11건 남음`처럼 실제 진행률과
  다음/개별 pending factual block을 보인다. 첫 pending block은 선택만 되며,
  `다음 미확인 사실 블록 검토`를 눌러야 검사 맥락으로 이동한다.
- 사람 대조를 저장하면 기존 CSRF-protected block verify API가 하나의
  verification과 exact source ref set을 영속한다. 화면은 다시 DB를 읽어 다음
  pending block을 선택하고 진행률을 갱신한다. 자동 대조·일괄 대조·자동 승인은
  추가하지 않았다.
- 다른 blocker는 별도 상태로 남는다. 자동 실패는 자동 품질 검사, stale은 실제
  변경 영향 결정, held/conflict는 해당 block, 부분 원본은 수집 범위로만 연결한다.
  처리할 수 없는 상태에는 가짜 해결 버튼을 만들지 않았다.
- desktop은 원본 위치·선택 block·검사 맥락을 함께 보여 주고, mobile은 검토
  큐에서 원본 탭으로 전환해 대조한 뒤 검토 탭에서 기록한다. 내부 ID는 UI text에
  표시하지 않는다.

### 최종 검증

- `./harness/run.sh quick`: PASS (unit 63/63, runtime known-bad 2/2,
  디스크 동적 known-bad 15건).
- `node --test tests/e2e.test.js`: PASS 3/3. 11건 큐의 선택만 수행, block별
  저장 후 exact 진행률 재렌더, 마지막 대조 전 승인 비활성, mobile 원본/검토
  전환, stale의 실제 변경 영향 action을 검사했다.
- `OSAU_POSTGRES_TEST_URL`을 격리 PostgreSQL에 연결한
  `./harness/run.sh full`: PASS (build 27, PostgreSQL integration 4/4,
  quality 29/29, browser E2E 3/3, security 6/6).
- 격리 LXD runner에서 실제 Docker Compose 경계를 포함한
  `./harness/run.sh release`: PASS (container smoke 2/2, release invariant
  4/4). runner staging copy의 host virtualenv가 PyYAML을 찾지 못한 환경 문제는
  runner의 전용 virtualenv를 연결해 해결했으며, source/release assertion은
  변경하지 않았다.
- 실제 내부 운영 인스턴스에서 desktop/mobile Playwright로 진행률 0/11,
  pending 11건, desktop 검사 전환과 exact source highlight, mobile 원본 전환과
  검토 panel 복귀를 확인했다. `0.0.0.0:3000` 및 두 readiness endpoint도
  정상 응답했다.

known-bad payload, expected issue code, Product Truth, `DESIGN.md`, stale
dependency와 release gate는 변경하거나 약화하지 않았다.
