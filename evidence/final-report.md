# OSAU Production Alpha 최종 보고서

작성 시각: 2026-07-30 UTC

최종 판정: **TECHNICAL_ALPHA_COMPLETE**

이 판정은 기술 release gate와 현재 self-hosted 운영 경계가 통과했다는
뜻이다. 대상 사용자의 실사용 유용성, 콘텐츠 성과, 실제 외부 플랫폼에서의
제작 품질을 입증했다는 뜻은 아니다.

## 1. 현재 접속 및 실행 상태

- 내부 네트워크 주소: `http://192.168.50.130:3000`
- listener: `0.0.0.0:3000`
- web/worker: 독립 tmux process, 둘 다 실행 중
- PostgreSQL: host-local 실제 PostgreSQL, migration `001`~`009` 적용
- 인증: 현재 요청에 따라 로그인 비활성
  - `OSAU_INTERNAL_NETWORK_MODE=true`
  - `OSAU_AUTH_DISABLED=true`
  - `OSAU_INTERNAL_PEER_ADDRESS_PRESERVED=true`
  - socket peer와 `Host`가 loopback 또는 사설 IP literal일 때만 허용
- 최종 상태 확인:
  - local `/health`: HTTP 200
  - local `/ready`: HTTP 200
  - LAN `/health`: HTTP 200
  - `Host: attacker.example`: HTTP 403
  - `/login`: `/app/inbox`로 HTTP 302
  - active outbox job: 0
  - outbox history: `succeeded=20`, `failed=2`; terminal 실패 이력은 삭제하지 않음
  - production 재시작 뒤 read-only TikTok canary: 기존 실패 fingerprint와
    성공한 현재 output을 변경 없이 다시 확인

현재 host-direct 운영을 다시 시작하는 명령은 다음과 같다. Key 값은
출력하거나 저장소에 복사하지 않고 상위 `.env`에서만 읽는다.

```bash
cd /home/hong/code/solar-contents/OSAU/OSAU_Codex_Harness_Minimal
set -a
. /home/hong/code/solar-contents/OSAU/.env
. /home/hong/.local/share/osau/runtime.env
set +a

export NODE_ENV=production
export HOST=0.0.0.0
export PORT=3000
export OSAU_INTERNAL_NETWORK_MODE=true
export OSAU_AUTH_DISABLED=true
export OSAU_INTERNAL_PEER_ADDRESS_PRESERVED=true

npm run migrate
npm run dev
```

같은 환경에서 별도 process로 `npm run worker`를 실행한다. 일반 배포와
인증 사용 Docker Compose 절차는 저장소 `README.md`에 있다. 현재 HTTP
무로그인 모드는 신뢰 LAN과 firewall 뒤에서만 사용해야 한다.

## 2. 구현된 전체 사용자 흐름

1. **원본 수집**
   - Naver/general RSS 또는 Atom 연결
   - 텍스트·Markdown·SRT·VTT 전사 업로드
   - 공식 YouTube oEmbed metadata 수집
   - 비공식 Naver/Instagram/TikTok/YouTube browser scraping 없음
   - 실제 outbox와 별도 worker에서 비동기 처리
2. **원본 영속화와 readiness**
   - raw payload, 정규화 본문, immutable snapshot, segment, atom 저장
   - 권리 상태와 `complete`, `partial`, `incompatible`, `insufficient`,
     `quarantined` 판정 저장
   - Naver description-only와 YouTube transcript 누락을 부분 원본으로 표시
   - 간접 prompt injection 신호는 생성 전에 격리
3. **Creator/Audience/Provider**
   - 근거 URL과 설명이 있는 Creator Identity 사실만 버전으로 저장
   - Creator Voice와 Audience Persona를 별도 버전으로 저장
   - Provider secret은 암호화
   - 기본 Provider는 Upstage `solar-open2`
   - 실제 응답 계약 canary의 성공·실패·시각·응답 모델을 DB에 저장
4. **Planner**
   - DB에 고정된 immutable Platform Profile과 `settings_schema`로 동적 렌더링
   - 사용자가 `내 소스로 기본값 추천`을 명시적으로 누르면 실제
     Provider/outbox/worker가 주원본과 작업공간의 적격 최신 원본을 bounded
     batch로 분석
   - 모든 활성 Profile의 모든 설정값·근거·origin·예상 편집량을 영속하고
     주원본과 최대 8개 관련 보조 원본을 추천
   - 추천은 채널을 자동 선택하지 않고 기존 사용자 입력을 비동기 결과로
     덮어쓰지 않음
   - 보조 원본은 추천 allowlist 안에서만 포함·제외할 수 있고 주원본과
     부분 원본 acknowledgement를 별도로 저장
   - 생성 Provider와 평가 Provider를 별도로 선택
   - Creator/Audience 버전, CTA, 채널별 목적과 설정을 선택
   - 선택한 출력만 `plan_outputs`와 outbox event 생성
   - 선택하지 않은 채널의 설정은 disabled이며 Artifact도 생성하지 않음
5. **지원 Platform Profile**
   - Naver Blog Draft v2
   - WordPress Article v2
   - Newsletter v2
   - Instagram Carousel v2
   - YouTube Shorts v1
   - Instagram Reels v1
   - TikTok Video v1
   - legacy `short_video:v1`은 기존 기록 호환만 하고 신규 실행은 차단
6. **실제 모델 생성**
   - readiness → evidence plan/claim budget → channel draft
   - adapter의 결정적 구조 검사
   - 모든 사실 block의 atomic claim 평가
   - 최대 1회 contract repair와 최대 2회 path-scoped content repair
   - 모델이 전체 결과를 임의 재작성하지 않고 server가 허용된 concrete path만 적용
   - timed-video 밀도 실패는 `grounded-channel-pipeline.v4`의
     `server-certified-narration.v1`로 처리
   - 서버가 허용 원문의 연속 token 구간에서 text·발화 단위·exact
     `atomRefs`·고정 duration을 인증하고 Provider는 opaque `candidateId`만 선택
   - request-document path, 신규 handle, duration drift, 예산 변조와 안전
     후보 부재는 정확한 issue code로 fail closed
   - attempt, usage, evaluation, finding, repair, run/step을 영속
7. **Artifact와 Review Workbench**
   - channel별 다른 persisted schema, block 구조, Preview, 검사
   - 사실/편집/제작 표면을 별도 block으로 저장
   - 모든 사실 block의 source relation은 `block_source_refs`에 저장
   - 자동 finding과 사람 확인을 별도 상태와 UI로 표시
   - comment, conflict, hold, immutable block edit, version/run/export history
   - factual edit는 현재 snapshot의 source position을 다시 선택해야 함
8. **승인**
   - open 자동 실패, stale, live source drift, conflict, hold, 미확인 factual
     block이 하나라도 있으면 승인 차단
   - verify/conflict/hold/approve/export가 artifact-first lock 순서로 직렬화
   - 장시간 patch/regeneration의 late result가 최신 사용자 편집을 덮지 못하도록
     base Artifact version을 시작과 최종 commit에서 재검증
9. **정확한 freshness와 복구**
   - plan/run/Artifact version마다 주원본과 보조 원본의 exact snapshot·seed를 고정
   - source별 old/latest atom fingerprint 변화 계산
   - 모든 역사적 참조를 `block_source_refs`에서만 읽어 exact 영향 block 계산
   - 영향 block stale, human verification 무효화, approval revoke
   - async invalidation 전에도 approval/verify/export live drift fence 적용
   - patch는 stale block 전체만 최신 다중 원본과 원래 brief/profile/context로 재생성
   - terminal `apply_source_update` 실패는 인박스에서 같은 exact snapshot
     transition을 새 event로 재시도하며 기존 failed event를 변경하지 않음
10. **내보내기**
    - 승인된 현재 버전만 channel별 Markdown 다운로드
    - Naver/WordPress article만 WordPress REST API draft 생성
    - HTML escaping, version-derived idempotency, 기존 draft 조회
    - upstream 응답은 exact `status=draft`와 positive integer ID를 요구
    - public publish 동작과 비공식 플랫폼 자동 업로드는 없음

## 3. 품질 방법론과 실제 Solar 시뮬레이션

방법론은 생성 전에 근거를 고정하는
[Attribute First, then Generate](https://aclanthology.org/2024.acl-long.182/),
atomic claim 단위의 [FActScore](https://aclanthology.org/2023.emnlp-main.741/),
생성과 검증을 분리하는
[Chain-of-Verification](https://aclanthology.org/2024.findings-acl.212/)을
OSAU의 persisted product 경계로 구현했다. 연구 아이디어를 모델 prompt
주장으로 끝내지 않고 source handle allowlist, server validator,
path-operation repair, attempt/finding 이력, 사람 승인 경계로 고정했다.

플랫폼별 형식은 공식 문서를 보수적으로 사용하며 도달·성과 규칙으로
과장하지 않는다. 전체 방법론과 platform별 계약은
`docs/QUALITY_METHODOLOGY.md`와 `docs/platforms/`에 기록했다.

최종 v4 전체 run은 이전 evidence를 덮어쓰지 않도록 다음 명령으로 실행했다.

```bash
bash -c 'set -a
source /home/hong/code/solar-contents/OSAU/.env
set +a
exec node scripts/live-quality-simulation.js \
  --live \
  --prompt-v2 \
  --run-label=v4-certified-all-seven-20260730 \
  --write
'
```

최종 결과:

- 실제 Provider: Upstage, `https://api.upstage.ai/v1`, `solar-open2`
- deterministic profile: 7/7 PASS
- adversarial: 4/4 PASS
- cross-profile: 5/5 PASS
- live profile: 7/7 PASS
- injection canary: 선택/marker 반향 없음
- `server-certified-narration.v1` TikTok density repair canary: PASS
  - 서버가 허용 원문에서 24개의 연속 token 후보와 opaque ID를 인증
  - Provider가 인증 ID를 직접 선택해 narration 49단위 → 26단위
  - 상한 30단위, duration 불변, exact source handle 인증
  - 수정 블록 atomic entailment finding 0
- 보증 수준: `LOW_ASSURANCE`
- `automaticOnly=true`
- `humanVerified=false`

최종 증거는
`evidence/quality/live-solar-open2-v4-certified-all-seven-20260730.json`이다.
첫 v4 targeted run
`live-solar-open2-v4-certified-tiktok-20260730.json`은 Solar가 narration
path 대신 request-document path를 반환해
`QUALITY_REPAIR_SCOPE_VIOLATION`, `INSUFFICIENT`로 fail closed한 원본을
그대로 보존한다. 응답용 exact path와 candidate ID allowlist를 평탄화한
별도 targeted run
`live-solar-open2-v4-certified-tiktok-path-contract-20260730.json`이 1/1
PASS한 뒤 다시 별도 전체 run에서 7/7을 확인했다. targeted PASS를 전체
PASS로 합산하지 않았고, v3 실패·성공 이력도 삭제하지 않았다.

### 실제 production browser canary

LAN browser에서 다음을 직접 실행했다.

1. 로그인 없이 원본 인박스 진입
2. owned synthetic transcript 업로드
3. worker의 비동기 수집 완료
4. Naver Blog만 선택해 계획 저장
5. production DB/outbox/worker와 실제 Solar Open2로 생성
6. Review Workbench의 Naver Preview, 자동 검사, provenance 확인

결과:

- 실제 LAN Planner 추천:
  - actual Solar Open2, persisted 3-stage outbox/worker run `succeeded`
  - 활성 Profile 7개, schema field 25개 모두 nonblank
  - 추천 전후 선택 채널 0, plan output 0, Artifact 0
  - 당시 작업공간에는 적격 보조 후보가 없어 후보 0건을 그대로 표시
  - insecure private-IP HTTP에서 `crypto.randomUUID`가 없는 브라우저도
    Web Crypto random bytes fallback으로 실제 요청 key를 생성
- output: `succeeded`
- quality: `passed`
- Artifact state: `review_required`
- persisted block: 11
- factual block: 11
- persisted source ref: 11
- open automatic failure: 0
- repair 과정의 resolved failure: 3개, 이력 보존
- active human verification/approval: 0
- Review에서 `LOW_ASSURANCE`와 자동 평가가 사람 확인을 대신하지 않는다는
  설명이 표시됨
- 사람 확인 전 승인 button은 disabled
- 내부 Artifact ID는 UI text에 노출되지 않음

첫 canary instrumentation은 navigation 뒤 response body를 읽으려 해
Playwright 자체 오류로 중단됐고, 이미 저장된 plan을 중복 생성하지 않고
이어 실행했다. 이어진 두 read assertion도 hidden tab의 `innerText`와
resolved finding CSS class를 open failure로 잘못 해석해 수정했다. 제품의
최종 DB 상태와 올바른 browser selector로 다시 확인한 최종 canary는 PASS다.

### 실제 production TikTok v4 retry canary

`evidence/quality/production-tiktok-retry-2026-07-30T04-29-40-715Z.json`은
LAN browser와 production PostgreSQL/outbox/worker/실제 Solar 경계를 함께
검사했다.

- 2026-07-30T03:13:10.177Z의 기존 v3 실패 run, execution, attempt,
  failed outbox와 fingerprint는 변경하지 않음
- Runs 화면에서 실제 생성·평가 Provider를 선택한 새 v4 retry run 성공
- attempt 1: `draft`, `schema_failed`, `CHANNEL_CONSTRAINT_FAILED`
- attempt 2: `schema_repair`, `accepted`,
  `server-certified-narration.v1` 3 slot
- 30초 Preview: 3/14/13초
- 발화 단위: 17/62/58, 정확한 상한 18/84/78 이하
- final narration block의 exact source relation을 `block_source_refs`에 저장
- source readiness가 `partial`이므로 생성 성공을 `qualityStatus: warning`으로
  정직하게 표시
- Review Workbench 도달, Runs/Review axe violation 0, 내부 ID 미노출
- `LOW_ASSURANCE`, `automaticOnly=true`, `humanVerified=false`
- verification 0건, approval 0건이며 사람 확인 전 승인은 차단

운영 web/worker를 최종 코드로 재시작한 뒤 같은 canary를 mutation 없는
read-only 모드로 다시 실행했다. 기존 실패 fingerprint, 현재 성공 output과
Provider 경계가 그대로였고 새 retry나 Artifact를 만들지 않았다.

## 4. 데이터 모델과 migration

현재 production schema는 54개 base table을 가진다.

- Workspace/Auth: workspace, user, session
- Source: source, sync state, item, snapshot, assessment, segment, atom
- Intelligence: Creator Identity version/fact, Voice version, Audience version,
  Model Provider
- Planning/Profile: Plan, selected Plan Output, Channel Definition Version,
  Workspace Channel Catalog, Planner Suggestion Run/Batch/Profile/Source
- Multi-source snapshots: Plan/Run/Artifact Version source snapshot,
  Plan/Run seed atom
- Quality runtime: Run, Run Step, Generation Execution, Evidence Plan,
  Generation Attempt, Evaluation Run, Finding, Repair Attempt, Evaluation Cache
- Artifact: Artifact, immutable Artifact Version, Artifact Block,
  `block_source_refs`, Comment
- Trust/Delivery: Verification, exact Verification Source Ref, Approval,
  Refresh Decision, Export
- Operations: Domain Event, Audit Event, Outbox Event

Migration:

| Version | 내용 |
|---|---|
| `001_initial` | P0 system of record, 상태/고유성/참조/index |
| `002_provider_and_channel_catalog` | default Provider, channel catalog, profile pin |
| `003_platform_profile_versions` | immutable 7-channel modern profile, legacy 보존 |
| `004_source_readiness` | 권리, ingestion metadata, readiness/omission/signal |
| `005_quality_pipeline` | evidence/attempt/evaluation/finding/repair/comment |
| `006_operational_provider` | 실제 Provider test 상태와 응답 모델 |
| `007_extensible_platform_channels` | hardcoded enum 대신 안전한 slug DB 경계 |
| `008_refresh_decision_base_version` | refresh 기준 Artifact version FK/backfill/index |
| `009_planner_suggestions` | 실제 비동기 Planner 추천, profile/source 근거, 다중 원본 snapshot·seed, exact verification refs 및 legacy backfill |

`009`가 추가한 12개 relation은
`planner_suggestion_runs/batches/sources/source_refs/profiles/profile_source_refs`,
`plan_source_snapshots/seed_atoms`, `run_source_snapshots/seed_atoms`,
`artifact_version_source_snapshots`, `verification_source_refs`다. 복합 FK로
source item↔snapshot과 atom↔snapshot 교차 참조를 차단하고 기존 단일 원본
plan/run/artifact/verification을 backfill한다. `plan_outputs.settings_origin`은
수동, 자동 추천, 추천 후 사용자 편집을 구분한다.

Migration runner는 filename 순서의 `schema_migrations`와 PostgreSQL advisory
transaction lock을 사용한다. production DB에서 `001`~`009` 적용을 직접
확인했다. down migration, backup/restore tooling은 이번 범위에 포함되지 않는다.

## 5. 실행한 정확한 gate와 결과

### Preflight

```bash
./harness/run.sh quick
```

변경 전 PASS. contract/design, 당시 disk known-bad 6건, unit 7/7,
runtime known-bad 1/1이었다. 결과와 초기 gap은 `evidence/preflight.md`에
기록했다.

각 구현 milestone 뒤 같은 `./harness/run.sh quick`을 반복 실행했다. 마지막
quick 결과는 다음과 같다.

- contract: PASS
- design: PASS
- disk에서 동적으로 열거한 known-bad contract: 15건 PASS
- unit: 63/63 PASS
- known-bad runtime: 2/2 PASS

known-bad payload나 expected issue code, Product Truth, DESIGN, release gate를
느슨하게 바꾸지 않았다.

### Focused quality

```bash
npm run test:quality
```

29/29 PASS. 다중 원본 고정·중복 제거·별도 acknowledgement,
approval/export/verify interleaving, transitive exact freshness, base-version
patch/regeneration/retry, terminal worker failure, 실제와 같은 TikTok
밀도 실패→서버 인증 repair→retry 영속 경계가 포함된다.

### Full

```bash
bash -c 'set -a
source /home/hong/.local/share/osau/runtime.env
set +a
export OSAU_POSTGRES_TEST_URL="$DATABASE_URL"
exec ./harness/run.sh full
'
```

최종 PASS:

- quick 전체 PASS
- runtime module build: 27 modules PASS
- 실제 PostgreSQL isolated schema integration: 4/4 PASS
- quality: 29/29 PASS
- Chromium E2E: 3/3 PASS
- security: 6/6 PASS

최종 full 전 한 번은 `data-redirect`가 없는 성공 form의 500ms 지연 reload가
다음 browser 조작과 충돌하는 race를 드러냈다. 성공 응답 뒤 불필요한 지연
timer를 제거해 같은 문서를 즉시 reload하도록 근본 원인을 수정했다.
서버 계약이나 E2E assertion을 느슨하게 하지 않았고 위 exact full command를
다시 실행해 전체 통과했다. 앞선 미선택 profile required-input 회귀도
미선택 fieldset control만 disable하고 server-side 선택 profile 검증은
유지한 상태다.

### Release

호스트에 Docker가 없어 검사를 skip하지 않고, 격리 LXD runner 안에 실제
Docker 29.1.3, Docker Compose 2.40.3, Node 24.18.0과 PostgreSQL 16 test
container를 준비했다. 최종 source를 새
`/workspace/osau-release-20260730-045110`에 복사하고 전용 PostgreSQL을
`127.0.0.1:55433`에 띄운 뒤 다음 exact command를 실행했다.

```bash
lxc exec osau-release-runner \
  --cwd /workspace/osau-release-20260730-045110 \
  -- env \
  OSAU_POSTGRES_TEST_URL=postgresql://osau:osau_release_test@127.0.0.1:55433/osau_release \
  ./harness/run.sh release
```

최종 PASS:

- quick/release contract/build PASS
- unit: 63/63, known-bad runtime 2/2, disk known-bad 15건
- 실제 PostgreSQL integration: 4/4 PASS
- quality: 29/29 PASS
- Chromium E2E: 3/3 PASS
- security: 6/6 PASS
- 실제 Docker Compose smoke: 2/2 PASS
  - PostgreSQL, web, worker 모두 running
  - `/health`, `/ready` 성공
  - web process restart 뒤 administrator row 영속
- release invariant: 4/4 PASS
  - P0 schema
  - exact `block_source_refs` freshness
  - production Fixture 격리
  - web/worker 분리와 draft-only publish 경계

최종 출력: `OSAU harness 'release': PASS`

검증 뒤 전용 PostgreSQL container,
`/workspace/osau-release-20260730-045110`, host temporary archive를
제거했고 `127.0.0.1:55433`의 임시 test DB도 남기지 않았다.

## 6. 보안·접근성·브라우저·컨테이너 결과

### 보안

- scrypt password hash와 random session token hash
- HttpOnly, SameSite, production Secure cookie 기본값
- same-origin + token CSRF와 role enforcement
- auth-disabled는 private socket peer, IP literal Host, explicit deployment
  setting을 모두 요구
- CSP, `frame-ancestors 'none'`, `nosniff`, `x-powered-by` 제거
- Provider/API secret AES-256-GCM at rest
- production credential transport HTTPS 강제
- SSRF IPv4/IPv6/reserved 차단, 단일 검증 DNS 주소에 socket pinning
- 전체 응답 deadline과 byte bound
- credential/log redaction
- Fixture Provider production 즉시 거부
- WordPress non-draft/invalid ID 응답 거부
- approval/export live freshness와 blocker 재검증
- automated security suite 6/6 PASS

외부 penetration test, abuse rate limit, WAF 검증을 완료했다는 뜻은 아니다.

### 접근성

- axe color contrast 포함:
  - desktop inbox: 0 violation
  - desktop Review: 0 violation
  - mobile inbox: 0 violation
  - mobile Review: 0 violation
- skip link, semantic navigation, `aria-live`
- dialog keyboard Escape
- nested tab Arrow/Home/End
- mobile 44×44 touch target

자동 axe 결과는 수동 screen-reader/WCAG audit를 대신하지 않는다.

### 브라우저

- headless Chromium, desktop `1440×900`, mobile `390×844`
- 명시적 실제 worker Planner 추천, 추천 전후 미선택 output 0,
  무로그인 진입, transcript, YouTube partial, RSS, 동적 7 profile,
  selected-only Naver+YouTube, Review, comment, human verification, approval,
  Markdown, WordPress draft protocol, model failure→retry, exact stale→patch,
  RSS 5회 failure→retry를 전체 3개 E2E에서 통과
- 별도 TikTok E2E에서 다중 narration 밀도 실패, 실패 attempt/outbox 불변,
  Provider 재선택, 새 retry, 서버 인증 ID 적용과 Review 진입 통과
- production LAN browser + 실제 Solar Naver와 TikTok v4 retry canary 별도 PASS
- Firefox, WebKit/Safari, 실제 모바일 browser는 외부 canary로 남음

### 컨테이너

- 실제 Docker Compose build/up/down 사용
- `postgres:16-alpine`, web, worker의 실제 process boundary
- named PostgreSQL volume
- health dependency
- web restart와 administrator persistence 검증
- Docker 검사를 unavailable/skip으로 통과시키지 않음

## 7. 외부 live canary가 필요한 항목

다음은 기술 Alpha를 막지 않지만 실제 자격증명·외부 시스템·사람 증거가
있어야 확인할 수 있다.

1. 실제 WordPress site와 Application Password를 사용한 draft
   create/lookup/idempotency
2. 실제 다양한 Naver/general RSS의 전문/요약/절단/encoding 변화
3. 실제 독립 evaluator Provider를 사용한 `HIGH_ASSURANCE`
4. 실제 Instagram/YouTube/TikTok device에서 crop, safe zone, 발화 시간,
   caption, sound-off 검수
5. 실제 email client의 subject/preheader/rendering
6. Firefox, WebKit/Safari, 실제 모바일 browser, 수동 screen reader
7. backup/restore rehearsal, pending outbox와 Artifact를 포함한 whole-stack
   restart, disk-full/DB 장애, 장기 worker soak/load
8. agency/2~10명 콘텐츠 팀의 대상 사용자 검수와 실제 제작 가능성 평가

## 8. 남은 제품 위험

- 생성기와 평가기가 같은 Solar인 현재 기본값은 `LOW_ASSURANCE`다.
- 7/7 live simulation과 밀도 repair는 synthetic owned 3-atom source 한
  종류와 한 시점의 기술 canary다. 다양한 길이·언어·source와 upstream model
  drift를 보장하지 않는다.
- Planner 추천 corpus는 원본당 기본 4,000자로 bounded되어 긴 원본 후반의
  관련 근거를 놓칠 수 있다.
- auth-disabled LAN의 모든 작업은 하나의 persisted administrator actor로
  기록되어 사용자별 책임 추적이 없다.
- 현재 HTTP LAN 운영은 firewall과 망 격리에 의존한다. 일반 운영은 TLS
  reverse proxy가 필요하다.
- Playwright 자동 검증은 Chromium 한 종류다.
- 실제 WordPress live draft와 실제 platform rendering은 아직 외부 canary다.
- Instagram/TikTok/Naver public publish나 비공식 자동화는 의도적으로 없다.
- platform 결과는 text/production plan/Preview이며 실제 pixel/media asset은 아니다.
- 현재 7개 profile과 audited 4 adapter family는 확장 가능하지만, 임의의 새
  platform이 자동으로 같은 품질을 얻는 것은 아니다. 새 adapter family에는
  schema, renderer, checks, regression이 필요하다.
- backup/restore, migration rollback, failover, observability, performance
  budget은 Production Alpha 이후 운영 hardening 항목이다.

## 9. 최종 판정

**TECHNICAL_ALPHA_COMPLETE**

Release gate, 실제 PostgreSQL, 실제 Docker Compose, browser E2E, production
LAN 접속, production migration/restart, 실제 Upstage Solar Open2 7-channel
simulation·밀도 repair canary, production Planner 7-profile/25-field 자동입력
및 Naver browser generation, 기존 실패를 보존한 TikTok v4 production
retry가 통과했다. 외부 WordPress와 독립 evaluator 등 live credentials,
다양한 실제 원본·플랫폼 rendering, 대상 사용자 증거가 필요한 항목은 위에
명시했으며 자동 검사를 사람 검증이나 실사용 유용성으로 승격하지 않았다.
