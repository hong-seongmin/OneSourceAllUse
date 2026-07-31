# 화면 인벤토리

모든 항목은 `data/capture-manifest.json`의 파일·라우트·viewport와 대응합니다. `fullPage: true`인 화면은 세로 전체를 포함하고, 대화상자 캡처는 실제 `dialog[open]` 상태의 1440×1100 viewport입니다.

## 데스크톱

| 파일 | 화면/상태 | 검수 대상 |
|---|---|---|
| `screens/desktop/01_inbox.png` | 원본 인박스 · 45건 | 검색·원본/상태 필터, readiness, 수집 재시도, 다음 작업, 연결 관리 |
| `screens/desktop/01_inbox_rss_dialog.png` | RSS 원본 연결 대화상자 | 이름·RSS 주소·권리 상태·실제 저장 후 동기화 경계 |
| `screens/desktop/01_inbox_transcript_dialog.png` | 전사 원본 업로드 대화상자 | 파일/붙여넣기 선택, 본문 제한, 권리 상태 |
| `screens/desktop/01_inbox_youtube_dialog.png` | YouTube metadata 대화상자 | 공식 metadata 수집 경계와 전사 누락 안내 |
| `screens/desktop/02_source_detail.png` | 원본 상세 | 스냅샷 버전, readiness 경고, 정규화 원문, 위치·결과물 링크, Creator Identity 근거 |
| `screens/desktop/03_planner.png` | 계획 만들기 | 원본 자동 맥락, Solar 기본 Provider, 독립 평가 Provider, 7개 채널 프로필, 선택하지 않은 출력 비생성 안내 |
| `screens/desktop/04_runs.png` | 실행 기록 | run/step 상태, 결과물 상태, 실패·재시도, export 기록 |
| `screens/desktop/05_settings.png` | 설정 | Solar Provider와 키 비노출, 채널 카탈로그 활성화, Identity/Voice/Audience 버전 입력 |
| `screens/desktop/06_review_preview.png` | Review Workbench · 미리보기 | Source/Evidence · Artifact · Preview/Checks 구조, 선택 블록 동기화, 채널 미리보기 |
| `screens/desktop/07_review_checks_queue.png` | Review Workbench · 검사 | 자동 품질 결과와 사람 확인 분리, 사람 원본 대조 0/11, 대기 큐, 승인 차단 |
| `screens/desktop/08_review_versions.png` | Review Workbench · 버전 | 불변 artifact 버전, 승인 이력, export 이력 |
| `screens/desktop/09_review_run.png` | Review Workbench · 실행 | Pipeline/Prompt/Evaluator/보증 경계와 현재 생성 실행 |
| `screens/desktop/10_review_source_focus.png` | Review Workbench · 블록 선택 | 선택된 사실 블록과 현재 원본 위치 강조 |

## 모바일

| 파일 | 화면/상태 | 검수 대상 |
|---|---|---|
| `screens/mobile/01_inbox.png` | 원본 인박스 | 좁은 화면에서 필터와 고밀도 운영 표면의 읽기/스크롤 |
| `screens/mobile/02_source_detail.png` | 원본 상세 | readiness와 원문/근거 연결의 세로 흐름 |
| `screens/mobile/03_planner.png` | 계획 만들기 | 채널 카드의 단일 열 전환과 터치 입력 |
| `screens/mobile/04_runs.png` | 실행 기록 | run/output/export 표면의 세로 흐름 |
| `screens/mobile/05_settings.png` | 설정 | Provider·카탈로그·Identity 폼의 세로 그룹화 |
| `screens/mobile/06_review_source.png` | Review · 원본 탭 | Source 탭과 현재 스냅샷 근거 |
| `screens/mobile/07_review_edit.png` | Review · 편집 탭 | 채널별 artifact block 선택·상태 표시 |
| `screens/mobile/08_review_check_queue.png` | Review · 검토/검사 | 44px 터치 컨트롤, 사람 대조 큐, 자동 검사와 승인 sticky 경계 |
