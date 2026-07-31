# Newsletter 방법론

## 목적

`newsletter:v2`는 수신함에서 보이는 제목·프리헤더 조합과, 이미지 없이도 이해할 수 있는 짧은 본문 모듈을 만든다. 웹 기사나 영상 스크립트를 이메일 길이로 자르는 방식이 아니다.

## 공식 출처에서 확인되는 사실

[Mailchimp preview text 안내](https://mailchimp.com/help/about-preview-text/)는 preview text가 많은 이메일 클라이언트에서 제목 다음에 표시되는 짧은 설명이며 제목을 보완할 수 있다고 설명한다. 표시 방식은 이메일 클라이언트마다 다르다. 대량 발송을 실제 운영할 때 필요한 인증·구독 해지 등 전달 요건은 별도이며, 예를 들어 [Gmail 발신자 가이드](https://support.google.com/mail/answer/81126)가 관련 요구사항을 제공한다. OSAU의 현재 artifact 생성은 이메일 발송 성공을 의미하지 않는다.

## OSAU 보수적 계약

- 설정: `purpose` 필수, `cadence` 기본값 `주간`, `includePreamble` 기본값 `true`.
- 구조: 사실형 `subject`, 선택 상태를 따르는 `preheader`, `opening`, 1~8개의 `{heading, body}` 모듈.
- 프리헤더를 켰으면 필수이고 subject와 동일할 수 없다. 껐으면 정확히 `null`이며 block도 만들지 않는다.
- 승인된 CTA만 editorial 표면으로 포함한다.
- 적응 연산: inbox subject/preheader pair, 한 독자 약속, 스캔 가능한 모듈, plain-text 동등성, images-off 가독성.

## Preview와 검사

Persisted Preview는 `newsletter_campaign_preview`이며 `inbox`, `mobile_html`, `desktop_html`, `plain_text`, `images_off` 모드를 가진다. UI는 받은 편지함 행, 본문 모듈, `Plain text·이미지 끔 상태 확인`을 별도로 보여 준다.

- `SUBJECT_PREHEADER_COMPLEMENT`: 두 문자열이 동일하지 않음.
- `PLAIN_TEXT_EQUIVALENCE`: 모든 생성 가시 텍스트를 결합한 plain text가 존재.
- `PREHEADER_SETTING`: 설정과 persisted preheader가 일치.

이 검사는 실제 메일 클라이언트 렌더링, 전달률, 접근성 품질 또는 subject의 설득력을 자동 인증하지 않는다.

## 실패 경계

동일한 subject/preheader, 모듈 1~8 범위 위반, 선택하지 않은 preheader, 근거 없는 factual 표면, 승인되지 않은 CTA는 실패한다. 현재 경계는 초안과 export이며 구독자에게 자동 발송하지 않는다.

## 검증이 필요한 가설

- 어떤 subject/preheader 역할 분담이 대상 구독자의 기대와 실제 본문을 가장 잘 일치시키는가.
- cadence와 독자 세그먼트별 적정 모듈 수·길이는 무엇인가.
- plain-text 결합본이 실제 보조기술 및 images-off 환경에서 충분히 이해되는가.

클라이언트별 렌더링 테스트, 접근성 사람 검토, 대상 구독자 조사나 제목 A/B 비교 전에는 성과를 주장하지 않는다.
