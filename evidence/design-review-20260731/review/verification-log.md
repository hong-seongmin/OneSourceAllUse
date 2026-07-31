# 캡처·검증 실행 로그

이 로그는 화면 캡처 시점에 다시 실행한 읽기/검증 명령의 결과입니다. 캡처 과정은 애플리케이션의 POST/PUT/DELETE를 호출하지 않았습니다.

## 런타임 경계

```text
ss -ltnp '( sport = :3000 )'
LISTEN 0 511 0.0.0.0:3000

curl -sS http://127.0.0.1:3000/ready
{"status":"ready"}

curl -sS http://192.168.50.130:3000/ready
{"status":"ready"}
```

## 하네스·브라우저

```text
./harness/run.sh quick
OSAU harness 'quick': PASS
unit: 63 pass / 0 fail
known-bad: 2 pass / 0 fail

node --test tests/e2e.test.js
tests: 3 pass / 0 fail
desktop inbox accessibility scan: passed
desktop review accessibility scan: passed
mobile inbox accessibility scan: passed
mobile review accessibility scan: passed
```

## 브라우저 캡처

- Browser: Playwright Chromium headless
- Origin: `http://192.168.50.130:3000`
- Locale: `ko-KR`
- Timezone: `Asia/Seoul`
- Color scheme: light
- Desktop viewport: `1440×1100`
- Mobile viewport: `390×844`
- Captures: 21 PNG (13 desktop, 8 mobile)
- Modal captures: RSS, transcript, YouTube metadata `dialog[open]` 실제 상태
- Review fixture: 현재 DB의 Naver Blog Draft artifact, 사람 원본 대조 대기 11건

## 상태 보존 확인

캡처 전후 readiness는 모두 200이었고, source/item/artifact/verification API에 쓰기 요청을 보내지 않았습니다. 화면의 11건 사람 대조 큐와 승인 차단은 캡처 당시 영속 상태 그대로입니다.
