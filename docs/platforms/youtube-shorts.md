# YouTube Shorts 방법론

## 목적

`youtube_shorts:v1`은 검색 가능한 제목과 첫 2초 훅으로 시작해, 외부 맥락 없이도 이해되는 짧은 설명과 다음 탐색으로 이어지는 마무리를 만든다. Reels의 저장·공유 시퀀스나 TikTok의 댓글 대화 시퀀스와 목적이 다르다.

## 공식 출처에서 확인되는 사실

[YouTube의 3분 Shorts 안내](https://support.google.com/youtube/answer/15424877)는 2024년 10월 15일 이후 업로드된 세로 또는 정사각형 동영상이 최대 3분일 때 Shorts로 분류될 수 있다고 설명한다. [Shorts 편집 도움말](https://support.google.com/youtube/answer/13380879)은 Shorts 제작 화면의 텍스트·타임라인·보이스오버 등 편집 기능을 설명한다. 이 사실은 OSAU의 2초 훅이나 장면 밀도가 성과를 보장한다는 뜻이 아니다.

## OSAU 보수적 계약

- 설정: `purpose` 필수, `targetSeconds` 15~180(기본 45), `visualStyle` 기본값 `정보 카드`, `includeCaptions` 기본값 `true`.
- 구조: factual `title`·`hook`, 서버가 계산한 정확한 수의 timed scene, factual `ending`·`coverText`, 선택 상태를 따르는 factual 게시 caption. 첫 scene의 2초 상한을 수용량에 반영한 장면 수는 `max(3, 1 + ceil((max(10,targetSeconds-8)-2)/20))`이며 모델이 임의로 장면을 늘려 같은 주장을 반복할 수 없다.
- scene: 0초 초과 20초 이하의 시간, factual `narration`·`onScreenText`, production `visualDirection`·`safeZoneNote`.
- 합계: `max(10, targetSeconds-8)` 이상 `targetSeconds` 이하. 첫 scene은 2초 이하, 내레이션은 초당 6 발화 단위 이하.
- adapter는 `min(targetSeconds, 2 + (sceneCount-1)*20)`을 합계로 삼아 정확한 scene별 시간·발화 예산을 먼저 배분하고 모델의 시간 산술을 이 metadata로 정규화한다.
- 이 계획 뒤에도 밀도가 넘으면 duration과 `atomRefs`를 잠근다. 순수 밀도 repair는 인용 원문에서 단어를 삭제하고 순서를 유지한 3개 후보만 허용하며, 서버가 발화 단위와 추출식 subsequence를 검사한 뒤 선택한 text를 다시 entailment 평가한다.
- 첫 narration이 2초 창을 넘으면 adapter는 후보에 이미 있는 factual hook/on-screen/cover/title/ending 중 12 발화 단위 이하 표면을 text와 atomRefs 그대로 추출 재사용할 수 있다. 새 문구를 만들거나 문자열을 자르지 않으며, 적합한 기존 표면도 없으면 실패한다.
- 적응 연산: two-second searchable hook, self-contained explanation, YouTube title, caption timeline, long-form discovery CTA 맥락. 다만 현재 candidate에는 별도 CTA 필드가 없고 `ending`은 factual 표면이므로, 승인·근거 없는 요청 문구를 새로 만들 수 없다.

9:16은 OSAU의 일관된 세로 Preview 선택이다. 공식 Shorts 분류가 정사각형도 허용한다는 사실과 구분한다.

## Preview와 검사

Persisted Preview는 `youtube_shorts_timeline_preview`이며 `timeline`, `safe_zone`, `cover_crop`, `captions`, `sound_off` 모드를 가진다. UI는 검색·재생 맥락의 제목, 첫 2초 검색 훅, 시간별 화면/자막/내레이션, 독립적 결론, 커버와 설명을 렌더링한다.

- `VIDEO_TARGET_DURATION`, `HOOK_WINDOW`, `SPEECH_DENSITY`.
- `CAPTION_SETTING`: 미선택 caption을 생성하지 않음.
- `SAFE_ZONE_COMPLETE`: 모든 scene에 제작 지시 존재.

## 실패 경계

장면 수·시간 합계·첫 장면·발화 밀도 위반, 빠진 safe-zone 지시, 근거 없는 factual 표면, 미선택 caption, 승인되지 않은 CTA는 실패한다. Preview는 실제 영상, 음성 합성, 업로드 또는 YouTube 재생 테스트가 아니다.

## 검증이 필요한 가설

- 검색형 2초 훅이 대상 질문에서 이해와 유지에 실제로 유리한가.
- 같은 근거에서 제목·화면 텍스트·내레이션의 역할 분담이 중복을 줄이는가.
- 8초 허용 오차와 초당 6 발화 단위가 한국어 화자의 자연스러운 속도를 보수적으로 대변하는가.

실제 촬영본의 자막·safe-zone 확인, 대상 시청자 이해 테스트, 훅·길이 실험 전에는 효용을 주장하지 않는다.
