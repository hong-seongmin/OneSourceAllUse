# OSAU 근거 기반 멀티플랫폼 품질 방법론

문서 버전: 1.2
적용 계약: `grounded-channel-pipeline.v4`, `visible-text-platform-draft.v2`, `claim-entailment.v3`, `server-certified-narration.v1`
검토 기준일: 2026-07-30

## 목표와 판정 경계

이 방법론의 목표는 하나의 원문을 단순히 길이만 바꿔 복제하는 것이 아니다. 원문에서 실제로 지지되는 주장만 선택하고, 선택한 플랫폼의 사용 맥락에 맞는 별도 구조로 변환하며, 결과의 각 사실 표면을 다시 원문과 대조할 수 있게 만드는 것이다.

자동 검사가 통과했다는 사실은 구조와 근거 계약을 만족했다는 뜻이다. 사람이 실제 독자에게 유용하다고 확인했다는 뜻은 아니다. OSAU는 다음 상태를 분리한다.

- `automaticOnly: true`: 결정적 검사와 모델 평가만 완료
- `LOW_ASSURANCE`: 생성기와 평가기가 같은 Provider인 자동 평가
- `HIGH_ASSURANCE`: 생성기와 평가기 Provider 경계가 분리된 자동 평가
- 사람 확인: 사용자가 표시 블록과 원문을 직접 대조해 저장한 별도 verification
- 승인: 현재 Artifact version을 외부 draft 전송 대상으로 허용한 별도 상태

실사용 유용성, 전환, 체류, 저장·공유 성과는 대상 사용자 검증이나 플랫폼 실험 없이는 주장하지 않는다.

## 품질 모델

OSAU의 품질은 하나의 점수가 아니라 다음 통과 조건의 교집합이다.

| 차원 | 통과 조건 | 실패 처리 |
|---|---|---|
| 원문 준비도 | immutable snapshot에 사용할 수 있는 원문과 atom이 있고 공격성 지시가 격리됨 | `insufficient`, `partial`, `quarantined`를 명시 |
| 목적 적합성 | 요청 목적이 선택한 atom으로 전부 또는 허용된 일부까지 지지됨 | 불일치면 생성 보류, partial은 사용자 확인 필요 |
| 사실성 | 모든 factual visible-text block이 선택된 정확한 atom ID를 참조 | 누락·범위 밖 참조는 fail closed |
| Creator Identity | 잠긴 증거와 정확히 같은 창작자 사실만 사용 | 경험·자격·성과 창작은 보류 |
| 플랫폼 구조 | 선택한 versioned profile의 구조·설정·Preview·검사를 만족 | 선택하지 않은 표면 생성 금지 |
| 의미 평가 | factual block을 atomic claim으로 분해해 entailment 판정 | unsupported/contradicted claim은 block finding |
| 수정 국소성 | repair가 실패 block 또는 validator가 지정한 JSON path만 변경 | 범위 밖 변경은 `QUALITY_REPAIR_SCOPE_VIOLATION` |
| 발화 밀도 복구 | 서버가 허용 원문에서 후보 text·발화 단위·`atomRefs`·고정 시간을 인증하고 Provider는 opaque `candidateId`만 선택 | 인증 변조는 `NARRATION_DENSITY_CERTIFICATION_INVALID`, 안전 후보 부재는 `NARRATION_DENSITY_RECOVERY_EXHAUSTED` |
| 사람·발행 경계 | 자동 판정, 사람 확인, 승인, 외부 draft 상태가 분리됨 | 미승인 외부 전송 금지, WordPress는 draft만 |

## 연구에서 제품 계약으로 옮긴 원칙

연구 결과는 방향을 정하는 근거이지, 특정 모델이 이 저장소에서 항상 성공한다는 보증이 아니다.

| 연구 | 채택한 원칙 | OSAU 구현 |
|---|---|---|
| [Attribute First, then Generate (ACL 2024)](https://aclanthology.org/2024.acl-long.182/) | 생성 전에 귀속 가능한 근거를 고른다 | `evidence-plan.v1`이 source handle과 claim budget을 먼저 고정 |
| [FActScore (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.741/) | 긴 문장을 atomic claim으로 나눠 검증한다 | `claim-entailment.v3`가 factual block별 atomic claim verdict를 요구하고 block verdict는 서버가 집계 |
| [Chain-of-Verification (Findings of ACL 2024)](https://aclanthology.org/2024.findings-acl.212/) | 초안과 검증을 분리하고 검증 결과로 수정한다 | 독립 evaluator 단계와 persisted findings; 같은 Provider는 LOW assurance |
| [Self-Refine (NeurIPS 2023)](https://papers.neurips.cc/paper_files/paper/2023/hash/91edff07232fb1b55a505a9e9f6c0ff3-Abstract-Conference.html) | 피드백을 사용한 제한적 반복은 결과를 개선할 수 있다 | 무한 재시도가 아닌 최대 1회 contract repair와 최대 2회 content repair |
| [BIPIA (2023)](https://arxiv.org/abs/2312.14197) | 외부 문서는 간접 prompt injection 경계다 | source atom을 untrusted data로 감싸고 공격 신호는 quarantine |
| [Grammar-Constrained Decoding (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.674/) | 출력 문법 제약은 parsing 신뢰도를 높일 수 있다 | Provider capability에 따라 JSON object를 요청하고 서버가 다시 검증 |
| [JSONSchemaBench (2025)](https://arxiv.org/abs/2501.10868), [SchemaBench (ACL 2025)](https://aclanthology.org/2025.acl-long.243/) | structured output 지원과 실제 schema 준수는 별개다 | Provider 응답을 신뢰하지 않고 profile adapter가 완전한 후보를 검증 |
| [JSON Patch, RFC 6902](https://www.rfc-editor.org/rfc/rfc6902.html) | 전체 문서를 재전송하지 않고 명시적 operation으로 부분 변경한다 | OSAU 전용 replace/add subset이 validator allowlist 안의 concrete JSON path만 서버에서 적용 |
| [Structured Feedback Improves Repair in an LLM Agent Loop (2026)](https://arxiv.org/abs/2607.14167) | 위치·관찰값·허용 대안을 포함한 구조화 feedback이 repair에 유리하다 | issue meta에 safe `observed`/`allowed`, 정확한 path와 code를 함께 제공 |
| [Decoupling Task-Solving and Output Formatting (ACL 2026)](https://aclanthology.org/2026.acl-long.764/) | 내용 해결과 출력 formatting 책임을 분리한다 | profile adapter가 type·timing metadata를 조립하고, 밀도 복구에서는 서버가 원문 파생 후보와 발화 산술을 소유하며 Provider는 후보 ID만 선택 |

동일 모델의 자기평가에는 편향과 상관 오류가 남을 수 있으므로 자동 entailment를 사람 검증으로 승격하지 않는다. 생성·평가 Provider가 같을 때 `LOW_ASSURANCE`로 저장하는 이유다.

## 실제 생성 파이프라인

1. RSS 수집 결과를 immutable source snapshot과 content atom으로 저장한다.
2. 준비도와 공격 신호를 평가한다. description-only 같은 부분 원문은 `partial`, 명시적 prompt/credential 공격은 `quarantined`로 둔다.
3. 사용자가 고른 목적·Creator Voice·증거가 잠긴 Creator Identity·Audience Persona·공통 CTA를 versioned context로 고정한다.
4. 선택한 출력만 plan output으로 만든다. 선택하지 않은 채널에는 run, attempt, Artifact를 만들지 않는다.
5. `evidence-plan.v1`이 목적을 지지하는 정확한 source handle과 최대 claim 수를 선택한다.
6. 선택한 platform profile이 `visible-text-platform-draft.v2` 계약을 만든다. 모델은 그 한 채널의 완전한 typed candidate만 반환한다.
7. adapter-owned assembly가 모델이 작성할 필요가 없는 구조 metadata를 결정적으로 정규화한다. declared surface의 kind, production ref, 승인 문구와 정확히 같은 CTA kind/ref, source-handle object의 exact handle 문자열을 다룬다. timed video는 첫 훅과 20초 scene 수용량에서 정확한 scene 수를 계산하고 목표 범위 안의 scene별 시간·발화 예산을 서버가 먼저 배분해 모델의 시간 산술과 불필요한 claim 반복을 제거한다. 문자열과 exact companion source positions가 모델 응답에 함께 있을 때만 typed factual object로 감싼다. 첫 영상 narration이 훅 창에 물리적으로 들어오지 않으면 새 문구를 자르거나 만들지 않고, 이미 후보 안에 있는 짧은 factual hook/on-screen/cover/title/ending 표면을 atomRefs와 함께 추출 재사용할 수 있다.
8. adapter가 한 profile의 모든 visible surface 위반을 함께 수집하고, 배열 수, 설정, 시간, Preview, source handle을 결정적으로 검증해 persisted block으로 정규화한다. timed-video의 `NARRATION_DENSITY`만 실패한 경우 서버는 `server-certified-narration.v1` 계획을 만든다. 허용 source atom의 공백 단위 연속 구간에서 발화 상한·괄호 균형·목적 연관성을 만족하는 후보를 만들고, 각 후보의 text, 단일 exact `atomRefs`, 발화 단위, token 범위와 opaque `candidateId`를 함께 인증한다.
9. 공통 결정적 검사가 factual block의 참조 누락과 evidence-plan 밖 참조를 검사한다.
10. `claim-entailment.v3` 평가기가 factual block을 atomic claim으로 분해하고, 연결된 source handle 안에서만 `supported`, `contradicted`, `insufficient`를 판정한다. block verdict는 claim verdict에서 서버가 `contradicted → insufficient → supported` 우선순위로 결정적으로 집계한다. 동시에 platform rubric을 정확히 한 번씩 판정한다. claim reason은 160자 이내로 제한해 긴 영상 timeline에서도 구조 응답을 완결할 수 있게 하고, evaluator 호출은 8,192 token 출력 상한을 사용한다.
11. 실패가 block에 국한되면 실패 atomic claim과 reason을 feedback에 포함하되, 해당 block의 persisted surface path만 바꾸는 path-operation content repair를 최대 두 번 수행하고 다시 전체 검증한다. 발화 밀도 schema repair에서 Provider는 text, duration, `atomRefs`를 쓰지 않고 slot별 `candidateId`만 반환하며 서버가 인증된 narration object를 원자적으로 적용한다. 남은 실패는 숨기지 않고 held Artifact와 finding으로 보존한다.
12. accepted candidate만 versioned Artifact, blocks, `block_source_refs`, evaluation, usage와 함께 영속화한다.
13. 사람 확인과 승인을 별도 상태로 저장한다. 승인된 현재 version만 Markdown export나 WordPress `draft` 전송 경계에 들어간다.

## Prompt 계약

### 근거 계획

입력에는 요청 목적, snapshot 준비도, 원문 atom의 위치·형식·텍스트만 제공한다. 모델은 준비도, 지원 가능한 목적, 빠진 정보, 선택한 source handle, claim budget을 반환한다. 서버는 존재하지 않는 handle, 과장된 readiness, 무근거 선택을 거부한다.

### 플랫폼 초안

모든 표시 텍스트는 다음 세 kind 중 하나다.

- `factual`: `{ text, kind: "factual", atomRefs: [...] }`; 하나 이상의 선택된 handle 필수
- `editorial`: 사용자가 미리 승인한 CTA와 정확히 같아야 하며 atom 참조 금지
- `production`: 레이아웃·촬영·safe-zone·alt-text 제작 지시이며 atom 참조 금지

profile은 채널별 목적, settings schema, 출력 구조, 생성 제약, Preview 종류, rubric을 함께 제공한다. 따라서 Naver 글을 잘라 Shorts로 만들거나 세 영상 채널의 이름만 바꾸는 방식은 계약을 통과할 수 없다.

### 평가

평가기는 외부 지식을 쓰지 않고 block에 연결된 증거만 본다. factual block마다 하나 이상의 atomic claim과 각 claim의 verdict·source handle·이유를 반환한다. 모델에게 block 집계 verdict를 묻지 않으며 서버가 atomic verdict에서 계산해 자기모순 가능성을 제거한다. 모든 visible block의 Creator Identity 주장과 profile rubric도 확인한다.

모델이 `supported`라고 말해도 사람 확인으로 기록되지 않는다. 자동 결과는 finding과 assurance로만 저장된다.

## 제한적 repair

Contract repair는 이전 실패 후보를 버리고 새로 생성하는 재시도가 아니다.

1. 서버는 실패 후보 전체를 보존한다.
2. validator의 issue code, 안전한 message, meta, `affectedSurfacePaths`를 추출한다.
3. 두 번째 요청에는 원계약의 task/profile/관련 evidence/output contract/generation constraints 요약, 이전 후보의 SHA-256과 실패 path 현재값, 실패 code·안전한 message·`observed`·`allowed`, 변경 허용 JSON path만 보낸다. 전체 원계약과 전체 후보는 서버가 보존하며 모델에 반복하지 않는다.
4. 일반 schema repair에서 모델은 전체 후보를 다시 쓰지 않고 `{repairs:[{path,value}]}`만 반환한다. 반환 path는 wildcard 없는 concrete path여야 한다. `NARRATION_DENSITY` 전용 경계에서는 이 문자열 operation도 허용하지 않고 `{selections:[{path,candidateId}]}`만 받는다.
5. 서버는 operation path를 validator allowlist와 대조한 뒤 이전 후보에 원자적으로 적용한다. wildcard allowlist는 해당 배열의 concrete index만 허용한다.
6. 서버가 이전 후보와 적용 결과의 JSON diff를 다시 계산한다. 허용 path 밖 변경은 거부한다.
7. 수정 후보도 완전한 profile·근거·평가 계약을 다시 통과해야 한다.

`[*]`는 예를 들어 모든 장면의 `durationSeconds`처럼 validator가 명시한 동일 필드만 허용한다. 모델은 `[*]`를 반환할 수 없고 `$.scenes[2].durationSeconds` 같은 concrete path를 사용한다. 상위 object path를 암묵적으로 허용하지 않는다. parse 자체가 실패해 이전 후보가 없을 때만 전체 candidate 복구가 가능하다. 재시도 횟수를 늘리거나 validator를 느슨하게 하는 방식은 사용하지 않는다.

Adapter assembly도 자유 생성 repair가 아니다. profile의 훅 상한과 scene 수용량에서
정확한 scene 수와 목표 범위 안의 duration plan을 먼저 계산하고, 후보가 그
scene 수를 지켰을 때 duration metadata를 서버 계획으로 정규화한다. scene 수가
다르면 내용을 합치거나 새 장면을 만들지 않고 validator가 실패시킨다. 첫
narration만 훅 창을 넘으면 후보 안의 더 짧은 factual 표면을 **그 text와
atomRefs 그대로** 추출해 첫 narration으로 사용할 수 있다. 적합한 기존 표면도
없으면 내용을 자르거나 새로 쓰지 않는다. kind/ref 정규화도 factual handle을
창작하지 않으며 기존 문자열에 exact companion source positions가 실제로 함께
온 경우만 server-owned formatting으로 감싼다.

Timed-video 순수 밀도 실패는 일반 schema repair와 분리한다.

1. 서버는 실패한 `narration.text` path를 whole narration object path로 올리고,
   이전 후보의 duration, validator의 발화 단위 상한, 허용 source handle을
   고정한다.
2. 서버는 허용된 각 source atom의 **연속 공백 token 구간**을 열거한다.
   발화 단위를 직접 계산하고, 상한을 넘거나 괄호가 불균형하거나 현재
   narration과 같은 구간을 제거한다. 목적 용어, 문장 경계와 종결 형태를
   사용해 결정적으로 정렬하고 slot당 최대 24개만 보존한다.
3. 각 후보는 `server-certified-narration.v1`, narration path, exact source
   handle, token 범위, text와 발화 단위를 포함한 hash 기반 opaque
   `candidateId`를 갖는다. 후보의 `atomRefs`는 그 exact handle 하나다.
4. Provider가 볼 수 있는 선택지는 서버 인증 plan뿐이며 응답은 slot별
   `{path,candidateId}`뿐이다. Provider는 text를 줄이거나 바꾸고 duration,
   kind, `atomRefs`, 발화 산술을 반환하지 않는다. 응답용
   `outputContract.selections`는 exact narration path와 그 path에서 허용된
   candidate ID 목록을 평탄하게 제공한다. `$.narrationRepairPlan.slots[0]`
   같은 request-document 내부 위치는 응답 path가 아니며 fail closed한다.
5. 서버는 plan을 적용하기 직전에 candidate ID, 실제 발화 단위, 허용 handle,
   고정 duration과 예산을 다시 검증한다. 응답이 후보를 누락하거나 모르는 ID를
   고르면 중복되지 않는 최상위 서버 인증 후보만 fallback으로 쓴다. 추가 key,
   중복·범위 밖 path는 `QUALITY_REPAIR_SCOPE_VIOLATION`으로 거부한다.
6. 서버는 선택된 text, `kind: factual`, exact `atomRefs`를 whole narration
   object에 원자적으로 적용하고 허용 path 밖 diff가 없는지 다시 검사한다.
   인증 plan 변조는 `NARRATION_DENSITY_CERTIFICATION_INVALID`, 모든 안전 후보
   소진은 `NARRATION_DENSITY_RECOVERY_EXHAUSTED`로 fail closed한다.
7. 완성 후보는 전체 profile 검증과 atomic entailment를 다시 통과해야 한다.
   후보가 없을 때 문장을 임의 절단하거나 validator를 완화하지 않는다.

의미 finding에 대한 content repair도 전체 후보를 다시 쓰지 않는다. 서버는 failed block key를 persisted surface path로 변환하고, 실패 atomic claim·reason·현재 surface 값·관련 source atom만 제공한다. 모델이 반환한 concrete path operation을 서버가 적용한 뒤 JSON diff와 block hash를 모두 검사한다. 목적 불일치나 Creator Identity fabrication 같은 전역 실패는 반복 생성으로 덮지 않는다.

## 플랫폼별 변환

현재 selectable profile과 자세한 경계는 [플랫폼 방법론 색인](./platforms/README.md)에 있다.

| Profile | 주된 상호작용 | 고유 Preview |
|---|---|---|
| Naver Blog v2 | 검색 의도에 답하는 모바일 스캔 글 | `naver_draft_preview` |
| WordPress Article v2 | excerpt·heading hierarchy를 가진 승인 대상 편집 글 | `wordpress_block_preview` |
| Newsletter v2 | 수신함 제목/프리헤더와 독립 모듈 | `newsletter_campaign_preview` |
| Instagram Carousel v2 | cover promise와 swipe sequence, 카드별 제작·대체 텍스트 | `instagram_carousel_preview` |
| YouTube Shorts v1 | 검색 가능한 질문형 훅과 자기완결 설명 | `youtube_shorts_timeline_preview` |
| Instagram Reels v1 | 소리 없이도 이해되는 visual hook과 저장·공유 흐름 | `instagram_reels_timeline_preview` |
| TikTok Video v1 | 즉시 읽히는 premise와 빠른 problem/payoff 흐름 | `tiktok_video_timeline_preview` |

세 세로 영상은 공통 timed-scene primitive를 재사용하지만 adaptation operations, 첫 장면 목적, cover/caption 맥락, rubric, Preview type이 다르다.

## 시뮬레이션 방법

결정적 시뮬레이션은 synthetic-owned source만 사용한다. 7개 selectable profile을 실제 migration에서 로드하고 실제 adapter로 candidate를 검증한다. 또한 다음 공격·경계 케이스를 실행한다.

- evidence plan 밖 source handle
- 사용자가 지정하지 않은 CTA
- production surface에 사실 참조를 붙이거나 factual surface의 참조를 제거한 경우
- prompt injection marker 선택·반향
- 선택하지 않은 optional surface 생성
- Naver와 short-form 구조 혼용
- 세 영상 플랫폼의 Preview와 adaptation operations 중복

Live canary는 `solar-open2`의 실제 Upstage endpoint를 사용하지만 synthetic source만 보낸다. 각 profile에서 production과 같은 contract repair, atomic-claim evaluator, 최대 두 번의 path-operation content repair와 재평가를 실행한다. API key, raw prompt, raw output은 evidence에 저장하지 않는다. 모델명, finish reason, token usage, byte length, SHA-256, 자동 판정만 남긴다.

`grounded-channel-pipeline.v4`의 실제 실패 형태 회귀는 단일 짧은 문장만 다루지
않는다. 30초 TikTok의 서버 시간 계획 3/14/13초에서 초안 narration이
53/169/169 발화 단위이고 상한이 18/84/78인 세 경로 동시 실패를 재현한다.
회귀는 다음 경계를 각각 확인한다.

- 단위 테스트: source-derived 연속 구간, opaque ID, exact 한-handle
  `atomRefs`, 고정 duration, 다중 slot 비중복 선택
- fail-closed 테스트: 신규 handle, plan·예산 변조, duration drift, 안전 후보
  부재, 범위 밖 Provider 응답
- DB/HTTP/worker 테스트: 두 번째 Provider 응답도 성공 여부와 무관하게 별도
  generation attempt로 영속
- Chromium E2E: 첫 실행의 계약 위반 실패와 attempt 이력을 보존하고, Runs
  화면에서 실제 생성·평가 Provider를 선택해 새 retry run으로 복구한 뒤
  Preview, `block_source_refs`, 자동 평가와 사람 확인 분리를 확인

실행:

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

`--run-label`은 각 live run을 별도 JSON으로 보존한다. CLI와 evidence에는
profile별 판정, issue code, hash/byte/token metadata만 남기고 API key,
raw prompt, raw model output은 남기지 않는다.

일부 profile만 재현할 때:

```bash
node scripts/live-quality-simulation.js \
  --live \
  --prompt-v2 \
  --profiles=naver_blog,instagram_carousel,youtube_shorts \
  --write
```

Live 결과는 자동 canary이며 대상 사용자 품질 평가가 아니다. 같은 `solar-open2`가 생성과 평가를 모두 수행하므로 `LOW_ASSURANCE`다.

## 외부 프로젝트·하네스 비교

외부 프로젝트는 구현 개념을 비교하는 참고 대상이다. 현재 Production Alpha runtime에 새 대형 framework dependency를 추가하지 않았다.

| 프로젝트 | 공식 기능에서 참고한 개념 | OSAU에 채택한 부분 | 그대로 도입하지 않은 이유 |
|---|---|---|---|
| [Inspect AI](https://inspect.aisi.org.uk/) | dataset·solver·scorer로 평가를 합성하고 실행 log를 분석 | synthetic/adversarial corpus, Provider 실행과 scorer 분리, run별 evidence | OSAU의 run은 제품 DB의 snapshot·plan·Artifact·approval과 같은 transaction 안에서 추적되어야 한다. 별도 Python eval log가 제품 상태의 source of truth가 될 수 없다. |
| [Promptfoo](https://www.promptfoo.dev/docs/configuration/guide/) | 선언적 provider/test/assertion matrix, red-team 생성, CI 실행 | profile별 pass/fail matrix, 정확한 issue-code assertion, injection canary, release command | remote red-team 생성의 데이터 경계와 별도 저장소를 추가하지 않고, known-bad 동적 corpus와 자체 network/credential 정책을 release gate에 직접 연결했다. 향후 offline prompt 비교 도구로는 재평가할 수 있다. |
| [Guardrails AI Guard](https://guardrailsai.com/guardrails/docs/concepts/guard) | raw output과 validated output 분리, validator, bounded reask, history | raw Provider response와 normalized candidate 분리, 서버 validator, 1회 contract repair, persisted attempt history | generic reask runtime으로 stale·사람 verification·approval·WordPress draft 정책을 표현할 수 없다. Python runtime dependency 없이 현재 Node worker 경계 안에서 fail closed한다. |
| [DSPy](https://github.com/stanfordnlp/dspy) | signature/module과 metric 기반 optimizer로 prompt·demonstration을 조정하고 assertion으로 계산 제약을 둠 | versioned prompt/profile, 명시적 metric·assertion, 향후 고정 corpus 기반 optimizer 후보 | 대상 사용자 metric과 충분한 training/dev corpus가 없는 상태에서 자동 prompt 최적화를 돌리면 evaluator 편향을 최적화할 위험이 있다. 지금은 validator와 corpus를 먼저 고정하고 수동 version 승격을 유지한다. |

OSAU 자체 harness는 단순한 prompt score runner가 아니다. migration으로 동적 profile을 읽고, 실제 DB/worker/browser/container 경계, `block_source_refs` 기반 exact stale, 자동 검사와 사람 확인의 분리, 승인, Markdown, WordPress draft를 한 release gate에서 검증한다. 외부 도구를 향후 보조 evaluator로 추가하더라도 이 SQL-persisted domain truth와 release gate를 대체하거나 약화할 수 없다.

## 현재 증거와 해석

증거 파일의 원본 JSON이 판정의 source of truth다. 전체 이력과 각 run의 정확한 판정은 [`evidence/quality/README.md`](../evidence/quality/README.md)에 있다.

- `deterministic-simulation.json`: 7/7 profile, 4/4 adversarial, 5/5 cross-profile 통과.
- `live-solar-open2-simulation.json`: 초기 전체 기준선은 2/7로 `INSUFFICIENT`.
- 중간 실패 run은 full-candidate rewrite, 순차 visible validation, correlated timing, 깊이 제한 handle 오염, semantic feedback 부족, evaluator 길이 종료를 각각 드러냈다. 모든 원본 JSON을 별도 보존했다.
- `live-solar-open2-targeted-naver-youtube-semantic-length-pass.json`: semantic feedback과 evaluator budget 수정 뒤 Naver+Shorts 2/2 및 injection 통과.
- `live-solar-open2-targeted-wordpress-carousel-pass.json`: aggregate visible validation 뒤 WordPress+Carousel 2/2 및 injection 통과.
- `live-solar-open2-followup.json`: 2026-07-29T11:47:50.312Z의 앞선 전체 run. selectable profile 7/7, injection 통과.
- `live-solar-open2-current-recheck-20260729-151148.json`과 `live-solar-open2-post-density-fix-20260729-153130.json`: 후속 전체 재검증은 TikTok timing/density repair 결함을 다시 드러내 6/7 `INSUFFICIENT`였다. 이 실패를 앞선 PASS로 상쇄하지 않았다.
- 이어진 targeted run은 숫자 상한 평탄화, 다중 후보, 단계별 문자 예산만으로는 Solar의 한국어 문자 산술을 안정화하지 못함을 보였다. 서버 소유 scene/duration plan, 순수 밀도 전용 최소 prompt, 원문 token 삭제·순서 보존 검사, 수정 블록 전용 entailment 재평가로 근본 경계를 바꿨다.
- `live-solar-open2-tiktok-repair-block-eval-20260729-162253.json`: v3 전용 최소 prompt 방식에서 실제 Solar로 두 원자 49단위 narration을 26단위 한 원자로 줄이고 30단위 상한, duration, source handle, 해당 블록 entailment를 단일 확인했다.
- `live-solar-open2-server-planned-all-seven-20260729-162512.json`: 2026-07-29T16:32:26.942Z에 기록한 v3 전체 run. selectable profile 7/7, injection, 별도 density repair canary가 통과해 `verdict: PASS`였다.
- `production-tiktok-retry-2026-07-30T04-29-40-715Z.json`: LAN production
  browser에서 2026-07-30T03:13:10.177Z의 v3 실패 fingerprint가 그대로임을
  확인하고 새 v4 retry가 성공한 증거다. source readiness `partial`을 숨기지
  않아 output quality는 `warning`이며, draft `schema_failed` 뒤
  `server-certified-narration.v1` schema repair가 attempt 2로 accepted됐다.
  3/14/13초 장면의 발화 단위는 각각 17/62/58로 상한 18/84/78 이내다.
- `live-solar-open2-v4-certified-tiktok-20260730.json`: 첫 v4 actual-Provider
  targeted run. TikTok profile과 injection은 통과했지만 Solar가 exact
  narration path가 아니라 request-document path
  `$.narrationRepairPlan.slots[0]`을 반환해
  `QUALITY_REPAIR_SCOPE_VIOLATION`으로 fail closed했고 전체 판정은
  `INSUFFICIENT`다.
- `live-solar-open2-v4-certified-tiktok-path-contract-20260730.json`: 응답용
  exact path와 허용 candidate ID를 평탄화한 뒤의 targeted 재검증이다.
  Provider가 인증 ID를 직접 선택해 `selectionOrigin: provider_selected`,
  49→26 발화 단위(상한 30), duration·source handle·entailment 보존으로
  `PASS`했다.
- `live-solar-open2-v4-certified-all-seven-20260730.json`: 같은 v4 계약의
  별도 전체 run. selectable profile 7/7, injection, density repair가 모두
  통과해 `PASS`했다. targeted PASS를 전체 PASS로 대신하지 않고 이 파일의
  7개 profile 결과로 판정한다.

해당 v3 전체 run에서 모든 profile의 `findingCodes`는 빈 배열이었다. Naver,
Newsletter, Carousel, Shorts, Reels, TikTok은 각각 1회의 path-scoped content
repair가 필요했고 WordPress와 Carousel은 1회의 contract repair가 필요했다.
별도 density canary는 49→23 발화 단위로 축소하면서 duration과 source handle을
보존했고 수정 블록 entailment finding은 0건이었다. 범위 밖 변경은 허용되지
않았고 최종 validator/evaluator를 다시 통과했다.

이 보존된 결과는 synthetic-owned source에 대한 당시 v3 실제 Provider **기술
canary**다. 현재 v4의 Provider 책임은 문자열 작성이 아니라 서버 인증
`candidateId` 선택으로 더 좁아졌으므로, 그 파일을 v4 live 검증으로
재해석하지 않는다.

2026-07-30의 v4 자동 경계는 `./harness/run.sh full`에서 quick unit 63/63,
build 27/27, PostgreSQL integration 4/4, quality 29/29, Chromium E2E 3/3,
security 6/6으로 통과했다. 이 중 신규 실제 실패 형태 E2E는 첫 실패 run을
불변으로 남기고 새 retry run, accepted schema-repair attempt,
`server-certified-narration.v1` diagnostics, 3/14/13초 Preview, exact
`block_source_refs`, `LOW_ASSURANCE`, `automaticOnly: true`,
`humanVerified: false`, verification/approval 0건을 함께 검사한다. 이는
격리된 자동 회귀이며 production live canary나 대상 사용자 품질 평가를
뜻하지 않는다.

별도의 production LAN evidence에서는 이전 실패 run의 fingerprint와 error를
바꾸지 않은 채 새 retry run과 Artifact를 영속했고 Review Workbench까지
열었다. Runs와 Review의 axe 위반은 0건, 내부 ID 노출은 없었으며 사람 확인이
없어 승인은 올바르게 차단됐다. 결과가 생성에 성공했어도 partial source
readiness 때문에 `qualityStatus: warning`을 유지한다. 자동 평가는
`LOW_ASSURANCE`, `automaticOnly: true`, `humanVerified: false`이고
verification/approval은 각각 0건이다.

v4 live 이력은 첫 targeted 실패를 삭제하지 않는다. 그 실패로 드러난
request-document path 혼동을 output contract에서 제거한 뒤 별도 targeted
run으로 49→26 ID 선택을 확인했고, 다시 별도 전체 run에서 7/7 profile,
injection, density를 확인했다. 세 run 모두 같은 Solar가 생성과 평가를
수행하므로 `LOW_ASSURANCE`, `automaticOnly: true`,
`humanVerified: false`다.

모든 자동 결과는 실제 독자 효용이나 사람 검증을 뜻하지 않는다. 앞선 실패
evidence는 삭제하거나 후속 성공으로 덮어쓰지 않는다. 결정적 통과는 모델
canary 실패를 상쇄하지 않고, 모델 canary 통과도 사람 검증을 대체하지 않는다.

## 범용성 판정 기준

“범용적으로 고품질 재생성 가능”을 기술적으로 주장하려면 최소한 아래를 모두 만족해야 한다.

1. 실제 catalog에서 동적으로 읽은 모든 selectable profile이 결정적 corpus를 통과한다.
2. 공격·partial·unsupported·선택하지 않은 출력·플랫폼 혼용 케이스가 예상 issue code로 실패한다.
3. 실제 Provider canary에서 각 profile의 draft, Preview, 결정적 검사, claim evaluation이 모두 통과한다.
4. repair가 필요한 run은 이전 후보와 실패 path를 보존하고 범위 밖 변경이 0건이다.
5. 서로 다른 source 형태와 길이의 회귀 corpus에서 근거 누락률과 contract failure가 release 기준 이하다.
6. 별도 대상 사용자 연구에서 읽기·제작 가능성·플랫폼 적합성을 확인한다.

보존된 v3 actual-Provider 시뮬레이션은 당시 계약에서 1~4를 충족했다. 현재
v4도 별도 전체 actual-Provider run
`live-solar-open2-v4-certified-all-seven-20260730.json`과 production 실패
형태의 DB/worker/browser retry evidence로 현재 synthetic/adversarial 범위의
1~4를 충족한다. 첫 v4 targeted 실패와 이후 targeted PASS는 원인과 수정
경계를 보여 주지만 전체 통과 판정에는 합산하지 않는다. 5는 서로 다른 실제
source 형태·길이·언어의 운영 corpus가 필요하고, 6은 대상 사용자 연구와
실제 제작물 검수가 필요하다. “범용 고품질”을 실사용 성과 의미로 확장해
주장하지 않는다.

## 실패 시 다음 개선 순서

검사 기대값이나 profile 의미를 낮추지 않는다.

1. 정확한 issue code와 path를 분류한다.
2. 후보가 거의 유효하면 prior-candidate와 validator allowlist를 제공하고 일반 오류는 path-operation만 받아 해당 path를 서버에서 고친다. `NARRATION_DENSITY`는 문자열 operation 대신 서버 인증 후보의 `candidateId`만 받는다.
3. model이 선택할 필요가 없는 type·timing metadata는 profile adapter가 결정적으로 조립한다.
4. 동일 content 구조 실패가 여러 source에서 반복되면 profile의 출력 생성을 `structure plan → surface별 typed generation → deterministic assembly` 단계로 더 나눈다.
5. 단계 분할 후에도 각 surface는 같은 factual/editorial/production 계약과 source allowlist를 통과해야 한다.
6. 의미 품질 실패는 더 많은 재시도보다 source coverage, purpose 범위, claim budget, profile rubric을 먼저 점검한다.
7. 실제 독자 선호 문제는 prompt 하드코딩으로 숨기지 않고 versioned profile 실험과 사용자 연구로 다룬다.

## 운영 시 관찰할 지표

- profile별 first-pass contract success와 bounded-repair success
- issue code 및 affected path 분포
- factual block의 provenance 누락·범위 밖 참조 수
- atomic claim의 supported/contradicted/insufficient 분포
- LOW/HIGH assurance 비율
- held Artifact 비율과 사람 검증까지의 시간
- source 변경당 `block_source_refs` 기반 stale block 수와 과소·과다 invalidation 회귀
- profile별 Preview 검사 실패와 optional surface 선택 위반
- 승인 전 외부 전송 시도 및 WordPress non-draft 거부

이 지표는 품질 문제를 찾기 위한 운영 신호다. 조회수나 전환 성과를 대신하지 않는다.

## 공식 플랫폼 자료

플랫폼 사실과 OSAU 내부 보수 규칙은 플랫폼별 문서에서 분리한다. 공통으로 참고한 공식 자료:

- [Naver Search Advisor 콘텐츠 가이드](https://searchadvisor.naver.com/guide/content-basic)
- [WordPress REST API Posts](https://developer.wordpress.org/rest-api/reference/posts/)
- [Mailchimp preview text 안내](https://mailchimp.com/help/about-preview-text/)
- [Gmail 발신자 가이드](https://support.google.com/mail/answer/81126)
- [YouTube Shorts 편집 안내](https://support.google.com/youtube/answer/13380879)
- [YouTube 3분 Shorts 안내](https://support.google.com/youtube/answer/15424877)
- [Meta Instagram carousel format](https://www.facebook.com/business/ads/carousel-ad-format)
- [Instagram alt text 도움말](https://www.facebook.com/help/instagram/503708446705527/?locale=en_GB)
- [Meta Reels 광고 제작 안내](https://www.facebook.com/business/ads/facebook-instagram-reels-ads)
- [TikTok Creative Guide](https://ads.tiktok.com/business/en/guides/what-is-ad-creative-guide?redirected=1)
- [TikTok Creative Center 제작 팁](https://ads.tiktok.com/business/creativecenter/quicktok/online/Creating_Made_Easier/pc/en)
- [Upstage Solar Open 2](https://www.upstage.ai/blog/en/solar-open-2)
