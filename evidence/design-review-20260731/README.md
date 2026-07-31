# OSAU 전체 화면 디자인 검수 패키지

이 폴더는 실행 중인 Production Alpha를 브라우저에서 직접 열어 캡처한 화면과 검수 문서입니다. 정적 목업이나 fixture 화면이 아니라 현재 PostgreSQL에 저장된 원본·계획·결과물을 대상으로 했습니다.

## 빠른 확인

- 서비스 주소: `http://192.168.50.130:3000`
- 바인딩: `0.0.0.0:3000`
- readiness: `GET /ready` → `200 {"status":"ready"}`
- 캡처 기준 시각: `2026-07-31` (매니페스트의 UTC 시각 참조)
- 데스크톱: `1440×1100`, 모바일: `390×844`
- 결과물: PNG 21장, 전체 페이지 캡처(대화상자 3장은 viewport 캡처), 매니페스트 1개, 검수 문서 3개

## 폴더 구조

```text
screens/desktop/   데스크톱 전체 화면과 실제 입력 대화상자
screens/mobile/    모바일 반응형 화면과 Review 탭 상태
data/capture-manifest.json
review/design-review.md
review/screen-inventory.md
review/acceptance-checklist.md
review/verification-log.md
```

## 대표 검수 순서

1. `screens/desktop/01_inbox.png`에서 원본 큐와 다음 작업을 확인합니다.
2. `screens/desktop/02_source_detail.png`에서 원본 스냅샷·readiness·연결 블록을 확인합니다.
3. `screens/desktop/03_planner.png`에서 원본 기반 공통 맥락과 실제 채널 프로필을 확인합니다.
4. `screens/desktop/06_review_preview.png` → `07_review_checks_queue.png`에서 Review Workbench, 자동 검사, 사람 원본 대조 11건, 승인 차단을 확인합니다.
5. `screens/mobile/08_review_check_queue.png`에서 모바일 탭·대조 큐·sticky 승인 경계를 확인합니다.
6. 문서의 체크리스트에 실제 검수 의견을 기록합니다. 캡처 파일 자체는 수정하지 않습니다.

## 캡처 범위의 경계

- 로그인 화면은 현재 내부 네트워크 운영 모드에서 `/login`이 인박스로 리디렉션되므로 캡처하지 않았습니다. 이 패키지는 인증 이후 운영 화면을 대상으로 합니다.
- 실제 외부 WordPress 전송·Naver/YouTube 플랫폼 렌더링은 외부 자격증명과 플랫폼 계정이 필요한 별도 live canary입니다. Review 화면에는 승인 경계와 초안 export 컨트롤이 포함되어 있습니다.
- 모든 화면의 내부 UUID와 API Key는 사용자 표면에 표시되지 않으며, 캡처에도 API Key를 포함하지 않습니다. 현재 운영 계정 표시(`admin@osau.internal`)는 내부 네트워크용 상태 정보입니다.

## 재현 방법

저장소 루트에서 웹 서버가 실행 중인 상태로 Playwright Chromium으로 캡처했습니다. 이 캡처 작업은 DB를 변경하지 않습니다. 정확한 파일·라우트·viewport·상태와 런타임/하네스 결과는 `data/capture-manifest.json`과 `review/verification-log.md`가 단일 증거 목록입니다.
