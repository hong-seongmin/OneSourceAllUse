# TikTok Video 방법론

## 목적

`tiktok_video:v1`은 첫 3초 안에 영상의 전제와 payoff를 읽히게 하고, 빠른 문제→설명→payoff 흐름과 댓글 대화형 마무리를 만든다. YouTube Shorts의 검색 답변, Instagram Reels의 cover·저장·공유 흐름과 같은 구조가 아니다.

## 공식 출처에서 확인되는 사실

[TikTok for Business Creative Guide](https://ads.tiktok.com/business/en/guides/what-is-ad-creative-guide?redirected=1)는 TikTok 광고 creative의 세로형·플랫폼 친화적 제작과 hook/body/close 구조를 안내한다. [TikTok Creative Center 제작 안내](https://ads.tiktok.com/business/creativecenter/quicktok/online/Creating_Made_Easier/pc/en)는 UI에 가리지 않는 safe zone 등 제작 고려사항을 제공한다. 둘 다 **광고·비즈니스 제작 지침**이며 유기적 영상의 성과 보장이 아니다.

## OSAU 보수적 계약

- 설정: `purpose` 필수, `targetSeconds` 15~180(기본 30), `visualStyle` 기본값 `정보 카드`, `includeCaptions` 기본값 `true`.
- 공통 timed contract: factual `title`·`hook`·`ending`·`coverText`, 서버가 계산한 정확한 수의 scene, 선택 상태를 따르는 factual caption. 첫 scene의 3초 상한을 수용량에 반영한 장면 수는 `max(3, 1 + ceil((max(10,targetSeconds-8)-3)/20))`이며 모델이 임의로 장면을 늘려 같은 주장을 반복할 수 없다.
- 총시간은 `max(10, targetSeconds-8)`~`targetSeconds`, 각 scene은 0초 초과 20초 이하, 첫 scene은 3초 이하이다.
- scene마다 factual narration/on-screen text와 production visual direction/safe-zone note를 분리한다. 내레이션은 초당 6 발화 단위 이하이다.
- adapter는 `min(targetSeconds, 3 + (sceneCount-1)*20)`을 합계로 삼아 정확한 scene별 시간·발화 예산을 먼저 배분하고 모델의 시간 산술을 이 metadata로 정규화한다.
- 이 계획 뒤에도 밀도가 넘으면 duration과 `atomRefs`를 잠근다. 순수 밀도 repair는 인용 원문에서 단어를 삭제하고 순서를 유지한 3개 후보만 허용하며, 서버가 발화 단위와 추출식 subsequence를 검사한 뒤 선택한 text를 다시 entailment 평가한다.
- 첫 narration이 3초 창을 넘으면 후보에 이미 있는 18 발화 단위 이하 factual surface를 text와 atomRefs 그대로 추출 재사용할 수 있다. 새 문구 생성이나 임의 절단은 하지 않으며 적합한 표면이 없으면 fail closed한다.
- TikTok 적응 연산: three-second native hook, fast problem/payoff, TikTok cover, UI safe zone, comment-conversation CTA 맥락. 다만 현재 candidate에는 별도 CTA 필드가 없고 `ending`은 factual 표면이므로, 승인·근거 없는 댓글 요청을 새로 만들 수 없다.

## Preview와 검사

Persisted Preview는 `tiktok_video_timeline_preview`이며 `timeline`, `safe_zone`, `cover_crop`, `captions`, `sound_off` 모드를 가진다. UI는 For You·댓글 대화 맥락, 첫 3초 전제/payoff, scene timeline, 댓글 대화 마무리와 cover/caption을 렌더링한다.

- `VIDEO_TARGET_DURATION`, `HOOK_WINDOW`, `SPEECH_DENSITY`.
- `CAPTION_SETTING`, `SAFE_ZONE_COMPLETE`.

이 검사는 실제 TikTok UI의 pixel 영역, 영상의 자연스러움, 댓글 반응을 자동 확인하지 않는다.

## 실패 경계

장면·시간·밀도 위반, 제작 지시 누락, 근거 없는 factual 표면, 미선택 caption, 근거 없는 자격·체험·효과는 실패한다. TikTok 비공식 브라우저 자동 게시를 수행하지 않으며 Preview를 업로드 성공으로 표시하지 않는다.

## 검증이 필요한 가설

- 3초 전제/payoff가 대상 사용자에게 충분히 명확하면서 과장되지 않는가.
- 문제→payoff 순서와 댓글 대화 마무리가 특정 주제·계정의 실제 상호작용에 적합한가.
- 현재 발화 밀도와 safe-zone 지시가 실제 촬영·편집 결과에서 자연스러운가.

실제 제작본 검수, 대상 사용자 이해 테스트, 훅·순서·마무리 A/B 비교 없이는 성과나 범용 고품질을 주장하지 않는다.
