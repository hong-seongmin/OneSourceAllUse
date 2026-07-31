# Instagram Reels 방법론

## 목적

`instagram_reels:v1`은 첫 2초의 시각 훅, 소리를 끈 상태의 이해, 피드·프로필 cover crop, 저장·공유를 고려한 순서를 중심으로 만든다. 검색 답변 중심 YouTube Shorts나 전제·댓글 대화 중심 TikTok과 구분한다.

## 공식 출처에서 확인되는 사실

[Meta Reels 광고 안내](https://www.facebook.com/business/ads/facebook-instagram-reels-ads)는 Reels 광고 제작에서 9:16 세로 비율, 오디오, UI 요소와 겹치지 않는 safe zone을 권장한다. 이는 **광고 지침**이며 유기적 Reels의 도달이나 저장·공유를 보장하지 않는다. OSAU는 이 형식 정보를 제작 초안의 보수적 safe-zone 점검에만 사용한다.

## OSAU 보수적 계약

- 설정: `purpose` 필수, `targetSeconds` 15~90(기본 30), `visualStyle` 기본값 `정보 카드`, `includeCaptions` 기본값 `true`.
- 공통 timed contract: factual `title`·`hook`·`ending`·`coverText`, 서버가 계산한 정확한 수의 scene, 선택 상태를 따르는 factual 게시 caption. 첫 scene의 2초 상한을 수용량에 반영한 장면 수는 `max(3, 1 + ceil((max(10,targetSeconds-8)-2)/20))`이며 모델이 임의로 장면을 늘려 같은 주장을 반복할 수 없다.
- 합계는 목표보다 길지 않고 최대 8초 짧을 수 있다(최저 10초). scene은 각각 0초 초과 20초 이하이고 첫 scene은 2초 이하이다.
- 모든 scene에 factual narration/on-screen text와 production visual direction/safe-zone note가 필요하다. 내레이션은 초당 6 발화 단위 이하이다.
- adapter는 `min(targetSeconds, 2 + (sceneCount-1)*20)`을 합계로 삼아 정확한 scene별 시간·발화 예산을 먼저 배분하고 모델의 시간 산술을 이 metadata로 정규화한다.
- 이 계획 뒤에도 밀도가 넘으면 duration과 `atomRefs`를 잠근다. 순수 밀도 repair는 인용 원문에서 단어를 삭제하고 순서를 유지한 3개 후보만 허용하며, 서버가 발화 단위와 추출식 subsequence를 검사한 뒤 선택한 text를 다시 entailment 평가한다.
- 첫 narration이 2초 창을 넘으면 후보에 이미 있는 12 발화 단위 이하 factual surface를 text와 atomRefs 그대로 추출 재사용할 수 있다. 새 문구 생성이나 임의 절단은 하지 않으며 적합한 표면이 없으면 fail closed한다.
- Reels 적응 연산: two-second visual hook, save/share sequence, reels cover crop, UI safe zone, sound-off comprehension.

## Preview와 검사

Persisted Preview는 `instagram_reels_timeline_preview`이며 `timeline`, `safe_zone`, `cover_crop`, `captions`, `sound_off` 모드를 가진다. UI는 피드·프로필 crop 초안, 첫 2초 시각 훅, scene timeline, 저장·공유 마무리와 Reels caption을 별도 렌더링한다.

- `VIDEO_TARGET_DURATION`, `HOOK_WINDOW`, `SPEECH_DENSITY`.
- `CAPTION_SETTING`, `SAFE_ZONE_COMPLETE`.

검사는 텍스트 제작 지시의 존재와 시간 계약을 확인할 뿐, 실제 pixel crop이나 UI overlay 충돌을 측정하지 않는다.

## 실패 경계

시간·장면·밀도 위반, 빠진 safe-zone/visual 지시, 근거 없는 factual 표면, 선택하지 않은 caption은 실패한다. Instagram 비공식 브라우저 자동 업로드나 발행은 수행하지 않는다.

## 검증이 필요한 가설

- 첫 2초의 시각 훅과 sound-off 설계가 대상 시청자의 이해에 실제로 충분한가.
- 저장·공유형 마무리가 특정 계정의 독자 목적과 맞는가.
- cover crop 제작 지시가 실제 피드·프로필 렌더링에서 중요한 정보 손실을 막는가.

실제 제작본의 기기별 crop/safe-zone 검토, 대상 시청자 테스트, 훅·마무리 실험 전에는 이 가설을 품질 사실로 간주하지 않는다.
