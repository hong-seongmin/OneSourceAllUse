# Instagram Carousel 방법론

## 목적

`instagram_carousel:v2`는 사실에 근거한 표지 약속을 여러 장의 순서로 전개하고, 각 장의 시각 제작 방향과 대체 텍스트를 함께 보존한다. 기사 문단을 문자 수에 맞춰 자르는 결과가 아니다.

## 공식 출처에서 확인되는 사실

[Meta의 carousel 형식 안내](https://www.facebook.com/business/ads/carousel-ad-format)는 하나의 carousel 광고에 최대 10개의 이미지나 동영상을 배치할 수 있다고 설명한다. 이는 **광고 형식** 안내이며 모든 유기적 게시물의 성과 규칙은 아니다. [Instagram 대체 텍스트 도움말](https://www.facebook.com/help/instagram/503708446705527/?locale=en_GB)은 게시물 사진의 대체 텍스트를 자동 생성하거나 직접 편집할 수 있음을 설명한다.

## OSAU 보수적 계약

- 설정: `purpose` 필수, `slideCount` 3~10(기본 6), `visualDirection` 기본값 `간결한 정보 카드`.
- 구조: 사실형 `cover`, 정확히 선택한 수의 slides, 사실형 `caption`, 최대 20개의 사실형 hashtags.
- 각 slide는 factual `headline`·`body`와 production `visualDirection`·`altText`를 모두 가진다.
- 적응 연산: 정직한 cover promise, 장마다 하나의 메시지, swipe sequence, 공통 4:5 crop, slide alt text.
- 장 수는 원본의 길이가 아니라 계획 설정이 결정하며, 장마다 논리적으로 다른 단계가 전진해야 한다.

## Preview와 검사

Persisted Preview는 `instagram_carousel_preview`이고 `slide_deck`, `feed_crop`, `profile_grid_cover`, `alt_text` 모드를 가진다. UI는 4:5 crop 초안으로 표지, 장 순서, 제작 지시, 대체 텍스트, 캡션과 해시태그를 렌더링한다.

- `EXACT_SLIDE_COUNT`: 설정한 수와 정확히 일치.
- `ALT_TEXT_COMPLETE`: 모든 장에 비어 있지 않은 제작용 대체 텍스트.
- `SHARED_CROP`: Preview 계약의 4:5 공통 crop.

`SHARED_CROP`은 실제 이미지 파일의 픽셀·중요 요소 위치를 검사하지 않는다. 현재 결과물은 텍스트 및 제작안이지 렌더링된 이미지 세트가 아니다.

## 실패 경계

장 수 불일치, 빠진 제작 지시/대체 텍스트, production 표면에 원본 handle 부착, 사실 표면의 근거 누락, 20개를 넘는 hashtag는 거부한다. Instagram 비공식 브라우저 자동 게시를 수행하지 않는다.

## 검증이 필요한 가설

- 주제와 독자별로 3~10장 중 어느 길이가 이해·완주에 유리한가.
- 표지 약속과 마지막 장의 관계가 저장·공유 행동에 어떤 영향을 주는가.
- 4:5 제작 지시와 현재 alt-text 초안이 실제 이미지 제작 후에도 정확하고 유용한가.

실제 시각물 접근성 검토, 대상 사용자 swipe 과업, 장 수·표지 A/B 비교 없이는 이 가설을 품질 사실로 취급하지 않는다.
