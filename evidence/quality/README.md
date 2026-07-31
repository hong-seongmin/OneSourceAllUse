# 품질 시뮬레이션 Evidence

이 디렉터리는 자동 품질 시뮬레이션의 서로 다른 run을 보존한다. 앞선 실패를 후속 성공으로 덮어쓰거나, 자동 평가를 사람 확인으로 표시하지 않는다.

## 현재 runtime 계약

현재 품질 pipeline은 `grounded-channel-pipeline.v4`이며 timed-video
`NARRATION_DENSITY` 복구는 `server-certified-narration.v1`을 사용한다.
서버가 허용 source atom의 연속 token 구간에서 후보를 만들고, 각 후보의
text·발화 단위·exact 한-handle `atomRefs`·고정 duration을 검증해 opaque
`candidateId`로 인증한다. Provider는 `{selections:[{path,candidateId}]}`
외에 narration 문자열, duration, kind, `atomRefs`를 반환하거나 수정할 수
없다.

2026-07-30 actual-equivalent 자동 회귀는 30초 TikTok의 3/14/13초 plan,
53/169/169 발화 단위 초안과 18/84/78 상한을 재현한다. 첫 Provider repair가
계약 밖 key를 반환하면 두 번째 attempt까지 영속한 뒤
`QUALITY_REPAIR_SCOPE_VIOLATION`으로 실패하고, Chromium에서 실제 Provider를
선택해 새 retry run을 만들면 세 개의 서로 다른 인증 ID만 선택해 복구한다.
기존 실패 run 불변성, Preview, exact `block_source_refs`,
`LOW_ASSURANCE`/`automaticOnly`, verification·approval 0건까지 함께 검사한다.

이 변경 뒤 `./harness/run.sh full`은 quick unit 63/63, build 27/27,
PostgreSQL integration 4/4, quality 29/29, Chromium E2E 3/3, security
6/6으로 통과했다. 이는 격리된 자동 회귀 결과이지 production live canary,
사람 확인 또는 대상 사용자 품질 평가가 아니다.

## 현재 v4 evidence 순서

실패, 수정 확인, 전체 확인을 합산하지 않고 각각 보존한다.

| 파일 | 경계 | 판정 | 확인한 사실 |
|---|---|---:|---|
| `production-tiktok-retry-2026-07-30T04-29-40-715Z.json` | production LAN browser + DB | succeeded / quality warning | 기존 v3 실패 fingerprint 불변, 새 v4 retry·Artifact 성공, partial readiness 경고 유지, Review와 axe 통과 |
| `live-solar-open2-v4-certified-tiktok-20260730.json` | actual Solar targeted | INSUFFICIENT | profile·injection은 통과했으나 request-document path 반환을 `QUALITY_REPAIR_SCOPE_VIOLATION`으로 거부 |
| `live-solar-open2-v4-certified-tiktok-path-contract-20260730.json` | actual Solar targeted | PASS 1/1 | 평탄화한 exact response path, `provider_selected`, 49→26≤30, duration·source handle·entailment 보존 |
| `live-solar-open2-v4-certified-all-seven-20260730.json` | actual Solar full | PASS 7/7 | selectable profile 7/7, injection, `server-certified-narration.v1` density repair 통과 |

Production retry의 generation attempt는
`draft/schema_failed(CHANNEL_CONSTRAINT_FAILED)`와
`schema_repair/accepted` 두 건이다. 최종 30초 Preview의 장면은
3/14/13초이고 발화 단위는 17/62/58로 각 상한 18/84/78 이하이다.
`sourceReadiness: partial`이므로 생성 성공과 별개로
`qualityStatus: warning`이며 Review에서 사람 확인 전 승인은 차단된다.
Runs와 Review의 axe 위반은 0건이고, `LOW_ASSURANCE`,
`automaticOnly: true`, `humanVerified: false`, verification 0건, approval
0건이다.

첫 v4 targeted run에서 Solar는 응답 대상 narration path 대신
`$.narrationRepairPlan.slots[0]`을 반환했다. 이 실패를 삭제하지 않고
`INSUFFICIENT`로 보존했다. response용 exact path와 candidate ID allowlist를
평탄화한 다음 run은 Provider가 ID를 직접 선택해 통과했고, 이후 별도 전체
run이 7개 profile을 모두 확인했다. targeted PASS는 full PASS를 대신하지
않는다.

## 대표 판정

- `deterministic-simulation.json`: selectable profile 7/7, adversarial 4/4, cross-profile 5/5 통과.
- `live-solar-open2-followup.json`: 2026-07-29T11:47:50.312Z 앞선 전체 Solar run. profile 7/7, injection 통과, `PASS`.
- `live-solar-open2-current-recheck-20260729-151148.json`: 후속 재검증에서
  TikTok의 합계 시간·내레이션 밀도 동시 repair가 1초·0.5 speech
  unit/s만큼 남아 6/7, `INSUFFICIENT`. 이 실패는 삭제하거나 앞선 PASS로
  상쇄하지 않는다.
- `live-solar-open2-server-planned-all-seven-20260729-162512.json`: 보존된
  v3 전체 run. profile 7/7, injection 통과, 별도의 TikTok 밀도 repair
  canary 통과, `PASS`. canary는 두 원자 49단위 내레이션을 인용 원문의
  순서를 보존한 23단위 한 원자로 축소했고, 30단위 상한·duration·source
  handle·한 블록 entailment를 다시 확인했다. 이는 모델이 축약 문자열을
  만들던 이전 경계이며 현재 v4의 ID-only live 증거로 재해석하지 않는다.
- `live-solar-open2-v4-certified-tiktok-20260730.json`: 첫 v4 targeted
  `INSUFFICIENT`; 잘못된 request-document path를 정확한 issue code로 거부.
- `live-solar-open2-v4-certified-tiktok-path-contract-20260730.json`: exact
  response path 계약을 확인한 targeted 1/1 `PASS`.
- `live-solar-open2-v4-certified-all-seven-20260730.json`: 별도 전체 v4
  profile 7/7, injection, density repair `PASS`.
- 모든 live 결과는 `LOW_ASSURANCE`, `automaticOnly: true`, `humanVerified: false`다.

## 보존된 v3 Live run 이력

| 파일 | 판정 | Profile | Injection | 목적 또는 드러난 결함 |
|---|---:|---:|---:|---|
| `live-solar-open2-simulation.json` | INSUFFICIENT | 2/7 | pass | 초기 전체 기준선 |
| `live-solar-open2-core-v2-pre-bounded-repair.json` | INSUFFICIENT | 0/5 | pass | prior candidate 없는 v2 반복 |
| `live-solar-open2-bounded-full-candidate.json` | INSUFFICIENT | 0/5 | pass | 전체 candidate rewrite 방식 |
| `live-solar-open2-path-operations-targeted-pre-aggregate.json` | INSUFFICIENT | 0/2 | pass | path operation 초기 aggregate/shape 실패 |
| `live-solar-open2-path-operations-targeted-ssrf-transient.json` | INSUFFICIENT | 0/2 | fail | 모델 호출 전 public Upstage 주소를 잘못 막은 SSRF regression; 모델 품질에 합산하지 않음 |
| `live-solar-open2-path-operations-targeted-v3-pre-compact-feedback.json` | INSUFFICIENT | 0/2 | fail | evaluator handle, hook shape, marker 반향 |
| `live-solar-open2-path-operations-targeted-compact-feedback.json` | INSUFFICIENT | 1/2 | fail | compact feedback 뒤 남은 Shorts/marker 결함 |
| `live-solar-open2-path-operations-targeted-quarantine-pass-sequential-failures.json` | INSUFFICIENT | 0/2 | pass | injection 격리는 통과했으나 순차 contract 실패 |
| `live-solar-open2-path-operations-targeted-one-pass-object-atomrefs.json` | INSUFFICIENT | 1/2 | pass | object-shaped atomRefs 정규화 경계 |
| `live-solar-open2-path-operations-targeted-semantic-and-timing-failures.json` | INSUFFICIENT | 0/2 | pass | Naver 의미 finding과 Shorts timing |
| `live-solar-open2-path-operations-targeted-correlated-timing-failure.json` | INSUFFICIENT | 1/2 | pass | 총시간 repair가 훅 제한을 뒤늦게 위반 |
| `live-solar-open2-path-operations-targeted-depth-limited-handle-failure.json` | INSUFFICIENT | 1/2 | pass | 안전한 leaf handle까지 depth marker로 바뀐 feedback 결함 |
| `live-solar-open2-path-operations-targeted-model-timing-arithmetic-failure.json` | INSUFFICIENT | 1/2 | pass | 모델에 한국어 발화 단위 산술을 맡긴 결함 |
| `live-solar-open2-path-operations-targeted-hook-syllable-repair-failure.json` | INSUFFICIENT | 1/2 | pass | 모델의 hook narration 축약 불충분 |
| `live-solar-open2-path-operations-targeted-no-short-first-scene-surface.json` | INSUFFICIENT | 1/2 | pass | 첫 scene 안에만 extractive 대상을 찾은 범위 부족 |
| `live-solar-open2-youtube-only-eai-again.json` | INSUFFICIENT | 0/1 | fail | DNS `EAI_AGAIN`; 모델 품질에 합산하지 않음 |
| `live-solar-open2-youtube-only-pass.json` | PASS | 1/1 | pass | extractive hook assembly 단일 확인 |
| `live-solar-open2-targeted-naver-youtube-pass.json` | PASS | 2/2 | pass | 초기 Naver+Shorts 통합 확인 |
| `live-solar-open2-all-seven-five-pass-sequential-visible-failures.json` | INSUFFICIENT | 5/7 | pass | WordPress/Carousel 순차 visible validation |
| `live-solar-open2-targeted-wordpress-carousel-pass.json` | PASS | 2/2 | pass | aggregate visible validation 확인 |
| `live-solar-open2-all-seven-five-pass-semantic-length-failures.json` | INSUFFICIENT | 5/7 | pass | Naver atomic feedback 부족, Shorts evaluator length 종료 |
| `live-solar-open2-targeted-naver-youtube-semantic-length-pass.json` | PASS | 2/2 | pass | atomic feedback와 evaluator budget 확인 |
| `live-solar-open2-followup.json` | PASS | 7/7 | pass | 앞선 전체 PASS 대표 run |
| `live-solar-open2-current-recheck-20260729-151148.json` | INSUFFICIENT | 6/7 | pass | TikTok 합계 시간·내레이션 밀도 bounded repair 잔여 실패 |
| `live-solar-open2-post-density-fix-20260729-153130.json` | INSUFFICIENT | 6/7 | pass | duration은 잠갔지만 Solar가 밀도 대상 text를 그대로 반환 |
| `live-solar-open2-tiktok-flat-constraints-20260729-154458.json` | INSUFFICIENT | 0/1 | pass | 평탄화한 숫자 상한만으로는 한국어 문자 산술을 수행하지 못함 |
| `live-solar-open2-tiktok-bounded-candidates-20260729-154812.json` | INSUFFICIENT | 0/1 | pass | 후보 배열 지시 전 모델이 단일 value를 유지 |
| `live-solar-open2-tiktok-candidate-contract-20260729-154953.json` | INSUFFICIENT | 0/1 | pass | 초안 응답 `MODEL_RESPONSE_INCOMPLETE`; repair 품질에 합산하지 않음 |
| `live-solar-open2-tiktok-candidate-contract-recheck-20260729-155054.json` | PASS | 1/1 | pass | profile 단일 재확인; 전용 밀도 canary 추가 전 |
| `live-solar-open2-tiktok-density-canary-20260729-155451.json` | INSUFFICIENT | 1/1 | pass | profile은 통과했으나 전용 밀도 canary 후보가 실제 상한을 넘음 |
| `live-solar-open2-tiktok-density-diagnostics-20260729-155645.json` | INSUFFICIENT | 1/1 | pass | 후보 5개의 실제 단위가 26/25/25/24/23임을 안전하게 진단 |
| `live-solar-open2-tiktok-tiered-budgets-20260729-155922.json` | INSUFFICIENT | 1/1 | pass | 단계별 숫자 예산도 26/25/23/22/22로 수렴하지 못함 |
| `live-solar-open2-tiktok-server-plan-20260729-160746.json` | INSUFFICIENT | 1/1 | pass | 서버 소유 scene plan은 통과, 자유 압축 후보의 entailment 실패 |
| `live-solar-open2-tiktok-extractive-repair-20260729-161124.json` | INSUFFICIENT | 1/1 | pass | 추출식 5후보 요청이 `MODEL_RESPONSE_INCOMPLETE` |
| `live-solar-open2-tiktok-extractive-recheck-20260729-161306.json` | INSUFFICIENT | 1/1 | pass | 출력 상한 확대 뒤에도 같은 upstream 길이 종료 |
| `live-solar-open2-tiktok-extractive-three-20260729-161528.json` | INSUFFICIENT | 1/1 | pass | 3후보 모두 단일 원자 원문과 거의 같아 상한 초과 |
| `live-solar-open2-tiktok-atomic-reduction-20260729-161730.json` | INSUFFICIENT | 1/1 | pass | 두 원자 입력에서도 일반 repair prompt가 전체 문장을 복사 |
| `live-solar-open2-tiktok-compact-density-prompt-20260729-161942.json` | INSUFFICIENT | 1/1 | pass | 전용 최소 prompt로 49→23, 시간/handle 보존; canary 외 블록 평가가 섞인 결함 |
| `live-solar-open2-tiktok-repair-block-eval-20260729-162253.json` | PASS | 1/1 | pass | 전용 최소 prompt와 수정 블록 entailment 경계를 단일 확인 |
| `live-solar-open2-server-planned-all-seven-20260729-162512.json` | PASS | 7/7 | pass | 보존된 v3 전체 profile과 별도 49→23 문자열 밀도 repair canary 통과 |

각 JSON의 `summary`와 `verdict`가 해당 run의 판정이다. run끼리 합산해 실패를 숨기지 않으며, targeted pass를 전체 pass로 대체하지 않는다.

## 데이터 처리

Live canary는 저장소 소유 synthetic source만 사용한다. 다음은 evidence에 저장하지 않는다.

- API key
- raw prompt
- raw model output

다음만 저장한다.

- 요청 모델과 Provider 종류
- finish reason과 token usage
- 출력 byte length와 SHA-256
- validator issue code와 안전한 message
- 자동 통과 여부, assurance, `automaticOnly`, `humanVerified: false`

현재 v4 밀도 repair evidence에는 raw 후보 text 대신 contract version,
slot 수, 선택 origin, 발화 단위와 상한, `atomRefCount` 같은 안전한
diagnostics만 남긴다. 인증 후보 자체나 원문, Provider prompt/response를
evidence 요약에 복사하지 않는다.

API key는 스크립트가 파일에서 읽거나 복사하지 않는다. 실행하는 shell이 부모 `.env`를 source해 `UPSTAGE_API_KEY` 환경 변수로 전달한다.

## 재현

```bash
node scripts/live-quality-simulation.js --deterministic-only --write

set -a
source ../.env
set +a
node scripts/live-quality-simulation.js \
  --live \
  --prompt-v2 \
  --run-label=<lowercase-run-label> \
  --write
```

`--run-label`을 주면 이전 live JSON을 덮어쓰지 않고 별도 evidence 파일을
만든다. CLI에는 raw 응답 대신 profile별 pass, finding code, 안전한 error
요약만 출력된다.

스크립트의 non-zero 상태:

- `1`: 결정적 simulation 실패
- `2`: live canary `INSUFFICIENT`
- `3`: `UPSTAGE_API_KEY`가 없어 `BLOCKED_EXTERNAL_INPUT`

자동 live 통과도 대상 사용자의 유용성, 사람 근거 확인, 외부 게시 성공을 증명하지 않는다.
