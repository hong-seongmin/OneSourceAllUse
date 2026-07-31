# WordPress Article 방법론

## 목적

`wordpress_article:v2`는 사이트 독자를 위한 발췌·도입·본문 계층을 만들고, 사람 승인 후 WordPress에 **draft만** 생성할 수 있는 편집 결과물이다. Naver 검색 초안과 달리 발췌, H2/H3 계층, 이미지 대체 텍스트 제작 지침을 계약에 포함한다.

## 공식 출처에서 확인되는 사실

[WordPress REST API Posts 문서](https://developer.wordpress.org/rest-api/reference/posts/)는 post의 `status`에 `draft`를 포함하고 post 생성 endpoint와 필드를 정의한다. 이는 OSAU가 승인 없이 발행해도 된다는 뜻이 아니다.

## OSAU 보수적 계약

- 설정: `purpose` 필수, `angle` 기본값 `실행 가이드`, `includeFaq` 기본값 `false`.
- 구조: 사실형 `title`, `excerpt`, `intro`, 2~10개 섹션. 각 섹션은 `headingLevel` 2 또는 3이며 첫 섹션은 반드시 H2다.
- FAQ와 CTA는 선택·승인 상태를 정확히 따른다.
- `imageAltGuidance`는 필수 production 표면이다. 이미지 자체의 사실 설명을 자동 확정하는 필드가 아니라 제작자가 대체 텍스트를 작성할 때 검토할 지침이다.
- 적응 연산: 편집 발췌, heading hierarchy, 사이트 독자 맥락, draft-only CTA.

사실 표면의 원본 handle과 제작 지시의 무근거 구분을 유지한다. WordPress 자격증명이나 API 사용법을 결과물 본문에 만들지 않는다.

## Preview와 검사

Persisted Preview는 `wordpress_block_preview`다. UI의 `WordPress 블록 편집기 초안`은 발췌, H2/H3 본문, 선택된 FAQ·CTA, 이미지 대체 텍스트 지침을 구분해 보여 준다.

- `ARTICLE_SECTION_COUNT`: 2~10개 섹션.
- `WORDPRESS_HEADING_HIERARCHY`: H2/H3만 사용하고 H2에서 시작.
- `FAQ_SETTING`: FAQ 설정과 결과가 일치.

Markdown은 heading level을 보존한다. 외부 전송은 승인된 article artifact에 한해 WordPress `draft` 생성으로 제한하며 publish는 수행하지 않는다.

## 실패 경계

발췌 누락, 잘못된 heading level, 첫 H3, 근거 없는 factual 표면, 승인되지 않은 CTA, 선택하지 않은 FAQ는 실패한다. API 오류를 로컬 성공으로 표시하거나 draft 생성과 공개 발행을 같은 상태로 표시하지 않는다.

## 검증이 필요한 가설

- 발췌와 도입을 분리한 구조가 특정 사이트 독자의 클릭 후 이해를 높이는가.
- 주제별 최적 H2/H3 깊이와 섹션 수는 무엇인가.
- 현재 image-alt 제작 지침이 실제 편집자의 접근성 작업 시간을 줄이면서 정확성을 보존하는가.

대상 사이트의 편집자 검토, 접근성 점검, 독자 과업 또는 실험이 없으면 이 가설의 효용을 주장하지 않는다.
