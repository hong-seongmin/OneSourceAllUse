# OSAU 구현·검증 보고서 · 2026-07-31

## 구현 결과

- 사용자 표면의 상태·readiness·권리·연결 유형·실행 유형·블록 유형을 `apps/web/presentation.js`에서 한국어 표시명과 의미 토큰으로 분리했습니다. 내부 enum, snake_case, Pipeline/Prompt/Evaluator 식별자는 기본 UI에서 보이지 않습니다.
- 사용 권리는 RSS·전사·YouTube 연결 모두에서 빈 필수 선택값으로 시작하고, 서버도 `RIGHTS_STATUS_REQUIRED`로 누락을 거부합니다.
- 인박스·실행 기록은 1000px 이하에서 실제 DB 행을 semantic card layout으로 렌더해 가로 700px 테이블과 세로 글자 버튼을 없앴습니다. 각 카드에는 원래의 테이블 헤더를 `data-label`로 제공해 의미를 유지합니다.
- Planner는 활성 Platform Profile의 선언형 `primary_mode`에서 형태 힌트를 만들고, 채널을 직접 선택한 뒤에만 해당 설정을 활성화합니다. 선택 수와 생성 범위를 sticky submit bar에 표시하며, 선택하지 않은 채널은 기존 서버 경계에서도 plan/output/artifact/export를 만들지 않습니다.
- Review의 승인 영역에는 사람 원본 대조 세그먼트와 `완료/전체`가 함께 표시됩니다. 모바일에서는 15% 미만 높이의 fixed approval bar만 남기고, 하단 padding/scroll padding으로 대조 큐를 가리지 않습니다.
- 전체 재생성은 별도 실제 dialog에서 새 버전의 사람 대조 재기록을 확인해야 하며, `requestRegeneration` 도메인 경계도 `HUMAN_VERIFICATION_RESET_CONFIRMATION_REQUIRED` 없이는 큐 작업을 만들지 않습니다. 현 버전은 변경하지 않고 base version과 audit detail을 영속합니다.
- `scripts/capture-design-review.js`는 실행 중인 내부 서비스를 Playwright로 읽기 전용 캡처합니다. 21개 PNG, 활성 nav/tab, dialog, viewport, SHA-256을 동일 스키마에 기록하고 중복 해시면 실패합니다.

## 실제 실행

```bash
# 내부 네트워크 서비스 (Compose 배포)
docker compose up --build -d
curl --fail http://127.0.0.1:3000/ready

# 검수 캡처 — 기존 결과물을 덮어쓰지 않는 새 폴더를 지정합니다.
OSAU_CAPTURE_BASE_URL=http://127.0.0.1:3000 \
OSAU_CAPTURE_OUTPUT=evidence/design-review-YYYYMMDDHHMMSS \
npm run capture:design

# 실제 PostgreSQL 통합 / release
export OSAU_POSTGRES_TEST_URL='postgresql://…/osau_test'
./harness/run.sh full
./harness/run.sh release
```

## 사용자 흐름

1. RSS·전사·공식 YouTube metadata 연결을 실제 DB에 등록하고 worker queue에 넣습니다.
2. RSS/전사/metadata worker가 불변 스냅샷·segments·atoms·readiness를 영속합니다.
3. Planner에서 현재 스냅샷과 근거 있는 identity/voice/audience, 실제 Solar Provider, 선택한 채널만 확정합니다.
4. 비동기 생성은 채널별 persisted output/artifact/version/block/source ref를 만들고 자동 검사를 별도 상태로 저장합니다.
5. Review에서 사람은 각 factual block의 현재 원본 위치를 직접 대조·기록합니다. 자동 결과는 이를 대체하지 않습니다.
6. 정확한 `block_source_refs` 관계만으로 원본 변경 영향을 계산하고 stale/refresh 결정을 저장합니다.
7. 전제 충족 뒤에만 승인합니다. 승인 버전은 Markdown 다운로드와 WordPress `draft` 생성만 허용합니다.

## 데이터·마이그레이션

핵심 system of record는 migrations의 `sources`, `source_sync_states`, `source_items`, immutable `source_snapshots`, `source_segments`, `content_atoms`, versioned creator/audience/provider records, `plans`, `plan_outputs`, `runs`, `artifacts`, immutable `artifact_versions`, `artifact_blocks`, `block_source_refs`, `verifications`, `approvals`, `exports`, `outbox_events`, `domain_events`입니다. PostgreSQL 테스트는 임의 이름의 isolated schema만 생성한 뒤 제거합니다.

## 실행 결과

| 명령 | 결과 |
| --- | --- |
| `./harness/run.sh quick` | PASS — 계약, DESIGN, 동적 known-bad 15건, unit 65건 |
| `npm run build` | PASS — runtime module 28개 |
| `OSAU_POSTGRES_TEST_URL=<running service DB> ./harness/run.sh full` | 코드/실제 PostgreSQL 4건/품질/브라우저/보안 단계 PASS |
| `npm run security:check` | PASS 6/6 |
| `npm run test:release` | PASS 4/4 |
| `npm run capture:design` | PASS — 21 unique screens, complete manifest |
| `OSAU_REQUIRE_DOCKER=1 npm run container:smoke` | FAIL — Docker CLI/daemon/Compose runtime absent |

## 보안·접근성·브라우저·컨테이너

- 보안: session/CSRF/SSRF/credential transport/fixture isolation/approval/WordPress draft 경계 6건이 통과했습니다.
- 접근성: E2E axe-core desktop inbox·desktop review·mobile inbox·mobile review scans가 통과했고, keyboard tab behavior와 mobile touch target·card geometry·approval bar height를 확인합니다. 수동 contrast token test는 interactive border 3:1, disabled approval text 4.5:1 이상을 계산합니다.
- 브라우저: 내부 네트워크에서 실제 ingestion→generation→approval→WordPress draft→freshness→recovery E2E를 통과했습니다.
- 컨테이너: Compose 선언과 PGlite restart persistence contract는 통과했으나, 이 실행 환경에는 실제 Docker runtime이 없어 mandatory release smoke는 실행할 수 없습니다.

## 외부 live canary와 위험

- 필요한 canary: 운영 Upstage Solar Open2 API 호출, 운영 WordPress application password로 draft 생성, 실제 Naver/YouTube RSS·oEmbed 네트워크 동작. Naver/Instagram/TikTok 비공식 browser automation은 허용하지 않습니다.
- 남은 제품 위험: live Provider 비용·rate limit과 external source format 변화, 운영 WordPress credential rotation, 실제 사용자 대상 usability 검증은 코드 하네스로 대체할 수 없습니다.
- 남은 환경 차단: Docker CLI/daemon/Compose를 제공하고 `OSAU_POSTGRES_TEST_URL`을 설정한 뒤 `./harness/run.sh release`를 재실행해야 합니다. 하네스·known-bad·release assertion은 변경하지 않았습니다.

## 최종 판정

`BLOCKED_EXTERNAL_INPUT` — release의 실제 Docker Compose smoke만 현재 실행 환경의 Docker runtime 부재로 차단됩니다. 그 외 코드, PostgreSQL, security, browser, evidence checks는 통과했습니다.
