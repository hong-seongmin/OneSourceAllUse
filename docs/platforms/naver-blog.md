# Naver Blog 방법론

## 목적

`naver_blog:v2`는 선택된 원본으로 검색 질문에 직접 답하고, 모바일에서 제목과 섹션을 훑어볼 수 있는 **게시 전 초안**을 만든다. WordPress 기사나 영상 원고를 길이만 바꾼 결과가 아니다.

## 공식 출처에서 확인되는 사실

[Naver Search Advisor 콘텐츠 기본 가이드](https://searchadvisor.naver.com/guide/content-basic)는 검색엔진과 사용자가 콘텐츠를 이해할 수 있도록 사이트 콘텐츠를 구성하는 공식 지침을 제공한다. 이 가이드는 OSAU의 정확한 섹션 수, FAQ 사용, 제목 문형 또는 성과를 보장하지 않는다.

## OSAU 보수적 계약

- 설정: `purpose` 필수, `keyword` 선택, `readingTone` 기본값 `정보형`, `includeFaq` 기본값 `false`.
- 구조: 사실형 `title`, `intro`, 2~8개의 `{heading, body}`. FAQ를 선택했을 때만 한 개 이상의 `{question, answer}`를 만들고, 선택하지 않으면 정확히 빈 배열이다.
- CTA: 승인 문구가 있을 때만 editorial block으로 정확히 복제한다.
- 태그: 최대 20개이며 각 태그도 선택된 원본 handle을 가진 사실 표면이다.
- 적응 연산: 검색 의도형 제목, 모바일 스캔 섹션, 근거 연결 takeaway, Naver 게시가 아닌 draft 경계를 사용한다.

모든 제목·도입·섹션·FAQ·태그는 factual visible-text object다. 선택된 근거 계획 밖의 handle, 빈 `atomRefs`, 제작 지시를 사실 표면으로 바꾸는 출력은 거부한다.

## Preview와 검사

Persisted Preview는 `naver_draft_preview`이며 UI에서는 `Naver 모바일 문서 초안`으로 제목, 도입, 섹션, 선택된 FAQ·CTA, 태그를 렌더링한다. 결정적 검사는 다음과 같다.

- `ARTICLE_SECTION_COUNT`: 2~8개 섹션.
- `NAVER_SEARCH_STRUCTURE`: Naver용 기사 adapter를 통과했는지 확인하는 구조 표시.
- `FAQ_SETTING`: 설정과 실제 FAQ 존재 여부가 일치.

`NAVER_SEARCH_STRUCTURE`는 검색 순위나 독자 만족을 측정하지 않는다.

## 실패 경계

섹션 수 위반, 근거 없는 factual 표면, 허용되지 않은 CTA, 선택하지 않은 FAQ 생성, 20개를 넘는 태그, Profile에 없는 설정은 명시적으로 실패한다. OSAU는 Naver에 비공식 브라우저 자동 게시를 하지 않으며 이 결과는 draft/export 경계에 머문다.

## 검증이 필요한 가설

- 설정 keyword를 제목과 초반 구조에 자연스럽게 반영하면 대상 검색자의 과업 완료율이 높아지는가.
- 2~8개 범위 안에서 어떤 섹션 깊이와 문단 길이가 실제 모바일 독자의 이해와 이탈에 유리한가.
- FAQ와 태그가 주제별로 발견성이나 후속 행동에 기여하는가.

이 가설은 검색 콘솔 지표, 대상 독자 과업 테스트, 제목·구조 A/B 비교 전에는 품질 사실로 간주하지 않는다.
