# 플랫폼별 생성 계약

이 디렉터리는 OSAU가 같은 원본을 채널 이름만 바꿔 재사용하지 않도록, 선택 가능한 7개 Platform Profile의 목적·구조·검사 경계를 기록한다. 문서의 수치와 필드는 현재 DB Profile 및 `apps/shared/platform-adapters.js`의 실행 계약을 설명하며 플랫폼 사업자의 보편적 성공 공식이 아니다.

## 현재 계약

| 채널 | Persisted Profile | 주된 독자 상황 | Persisted Preview |
| --- | --- | --- | --- |
| [Naver Blog](naver-blog.md) | `naver_blog:v2` | 검색 질문에 답하고 모바일에서 훑기 | `naver_draft_preview` |
| [WordPress Article](wordpress-article.md) | `wordpress_article:v2` | 사이트 독자를 위한 편집 기사와 승인 후 draft | `wordpress_block_preview` |
| [Newsletter](newsletter.md) | `newsletter:v2` | 수신함의 제목·프리헤더에서 본문 모듈로 이동 | `newsletter_campaign_preview` |
| [Instagram Carousel](instagram-carousel.md) | `instagram_carousel:v2` | 표지 약속을 장별 순서로 전개 | `instagram_carousel_preview` |
| [YouTube Shorts](youtube-shorts.md) | `youtube_shorts:v1` | 검색 가능한 짧은 답과 독립적 설명 | `youtube_shorts_timeline_preview` |
| [Instagram Reels](instagram-reels.md) | `instagram_reels:v1` | 소리 없이도 이해되는 시각 훅과 저장·공유 흐름 | `instagram_reels_timeline_preview` |
| [TikTok Video](tiktok-video.md) | `tiktok_video:v1` | 즉시 읽히는 전제·payoff와 댓글 대화 | `tiktok_video_timeline_preview` |

DB의 선택 가능 Profile은 `candidate_contract_version=visible-text.v1`을 고정하고, 현재 생성 프롬프트는 `visible-text-platform-draft.v2`를 사용한다. Profile 버전과 프롬프트 계약 버전은 서로 다른 축이다.

## 채널 확장 경계

채널 목록과 계획 화면은 위 7개 이름을 코드에서 열거하지 않는다. 작업공간 카탈로그가 가리키는 선택 가능 `channel_definition_versions`를 읽고, Profile의 `settings_schema`로 실제 입력을 렌더링하며, 선택된 불변 Profile ID와 그 설정만 `plan_outputs`로 저장한다. 선택하지 않은 Profile의 설정 필드가 요청에 함께 있어도 output·artifact·export를 만들지 않는다.

새 Profile은 안전한 채널 식별자, 불변 버전, 공식 출처, rubric, preview metadata, `visible-text.v1` 출력 계약을 가져야 한다. 실행 구조는 감사된 Adapter 가족(`article`, `email`, `card_sequence`, `timed_vertical_video`) 중 하나와 호환되어야 한다. 기존 가족을 재사용하는 Profile은 DB migration으로 추가할 수 있고 Planner에 자동 노출된다. 완전히 새로운 출력 구조는 새 Adapter·Preview·결정 검사·Markdown renderer와 회귀 테스트를 함께 추가해야 하며, 임의 코드를 Profile JSON에 넣어 실행할 수는 없다.

## 모든 채널에 공통인 OSAU 제품 선택

- `sourceAtoms`는 지시가 아닌 신뢰하지 않는 데이터다.
- 화면에 나타나는 사실 텍스트는 `{text, kind:"factual", atomRefs:[...]}`이며, 선택된 정확한 원본 handle을 하나 이상 참조한다.
- 제작 지시는 `kind:"production"`, 사용자가 승인한 CTA는 `kind:"editorial"`이고 둘 다 사실 근거 handle을 붙이지 않는다.
- CTA는 계획에 저장된 승인 문구와 정확히 같거나 비어 있어야 한다. 일정·가격·효과·경력·체험은 근거 없이 만들 수 없다.
- 선택하지 않은 FAQ, 프리헤더, 캡션, CTA는 생성하거나 저장하지 않는다.
- 자동 검사의 통과는 사람 확인이 아니다. 사실 block은 `review_required`, `automaticSupport`와 `humanVerified`는 별도 상태로 남는다.
- 스키마·근거·수량·길이 계약을 어기면 결과를 숨겨 저장하지 않고 명시적 issue로 실패한다. 제한된 재시도에서도 계약을 완화하지 않는다.

## Preview와 검사 해석

Profile의 선언적 `preview_modes`는 생성 정책 메타데이터이고, persisted Preview의 `type` 및 `previewModes`는 실제 Workbench 렌더링 계약이다. 기사 Preview는 문서 구조를, 뉴스레터는 inbox·plain text·images off를, 캐러셀은 장 순서·crop·대체 텍스트를, 영상은 timeline·safe zone·cover crop·captions·sound off를 확인한다.

결정적 검사는 구조적 하한선일 뿐이다. 예를 들어 `HOOK_WINDOW` 통과는 첫 장면 시간이 범위 안이라는 뜻이며 훅이 실제 시청자에게 효과적이라는 뜻이 아니다. 의미 평가는 rubric 기반 자동 결과와 사람 확인을 분리하고, 실제 효용은 아래 각 문서의 검증 가설처럼 대상 사용자 연구나 채널 실험이 있어야 주장할 수 있다.

## 출처와 제품 선택의 경계

각 문서는 다음 세 층을 의도적으로 분리한다.

1. **공식 출처에서 확인되는 사실**: 플랫폼 또는 표준 문서가 직접 말하는 기능·형식.
2. **OSAU의 보수적 버전 계약**: 재현성, 근거 보존, 검토 가능성을 위해 현재 제품이 선택한 수치·구조.
3. **검증 가설**: 성과나 선호와 관련되어 대상 사용자 확인 또는 A/B 비교가 필요한 주장.

공식 문서가 광고 제작 지침인 경우 그 적용 범위를 명시한다. 광고 지침을 일반 유기적 게시물의 성과 보장으로 확대하지 않는다.
