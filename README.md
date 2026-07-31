# OSAU Production Alpha

원본 콘텐츠를 RSS·전사·공식 YouTube metadata로 수집하고, 선택한 채널만 비동기 생성·검토·승인·내보내기하는 자체 호스팅 콘텐츠 운영 도구입니다.

## 제공 기능

- 불변 원본 스냅샷, 문장 단위 근거, 권리·readiness 기록
- Upstage Solar Open2 등 실제 Model Provider와 비동기 worker 경계
- 채널별 Profile/Preview/검사: Naver Blog, WordPress, Newsletter, Carousel, Shorts, Reels, TikTok
- 사람의 원본 대조와 자동 품질 검사를 분리한 Review Workbench
- `block_source_refs`만 기준으로 하는 정확한 stale·refresh 처리
- 승인된 버전만 Markdown 다운로드, WordPress `draft` 생성

## 실행

Docker Compose가 권장 경로입니다. 먼저 예시 환경 파일을 복사하고 모든 `CHANGE_ME` 값을 바꾸세요.

```bash
cp .env.example .env
# .env에서 POSTGRES_PASSWORD, OSAU_ADMIN_*, SECRET_ENCRYPTION_KEY를 설정
# 실제 생성까지 사용할 경우 UPSTAGE_API_KEY도 설정

docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:3000/ready
```

같은 내부망에서는 `http://<서버 내부 IP>:3000`으로 접속합니다. TLS를 종단하는 일반 운영에서는 `OSAU_COOKIE_SECURE=true`를 유지합니다. 격리된 내부 HTTP 환경에서만 `OSAU_COOKIE_SECURE=false`를 명시하세요.

`OSAU_AUTH_DISABLED=true`는 실제 클라이언트 IP를 보존하는 내부 전용 gateway 또는 host-network 배치에서만 허용합니다. Docker published port의 기본 bridge 환경에서는 로그인 사용이 안전한 기본값입니다.

## 운영 흐름

1. RSS·전사·YouTube 연결과 사용 권리를 등록합니다.
2. Worker가 원본 스냅샷·근거·readiness를 실제 DB에 저장합니다.
3. Planner에서 근거 있는 맥락과 Provider를 확인하고 필요한 채널만 선택합니다.
4. Worker가 채널별 결과물과 자동 검사 기록을 생성합니다.
5. Review에서 사람은 사실 블록을 현재 원본 위치와 직접 대조합니다.
6. 원본이 바뀌면 연결된 `block_source_refs`만 stale 처리하고 refresh 결정을 남깁니다.
7. 승인된 현재 버전만 Markdown 또는 WordPress `draft`로 내보냅니다.

선택하지 않은 채널에는 plan, output, artifact, export가 생성되지 않습니다. 자동 검사는 사람 확인이나 승인을 대신하지 않습니다.

## 상태 확인

```bash
docker compose logs --tail=200 web worker
curl --fail http://127.0.0.1:3000/health
docker compose down
```

`docker compose down`은 PostgreSQL volume을 유지합니다. `down -v`는 운영 데이터를 삭제하므로 사용하지 마세요.

## 검증

```bash
./harness/setup.sh
./harness/run.sh quick

export OSAU_POSTGRES_TEST_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE'
./harness/run.sh full
./harness/run.sh release
```

`full`과 `release`는 지정한 PostgreSQL에 격리 schema만 만들고 제거합니다. `release`는 실제 Docker Compose runtime도 필요합니다. Fixture Provider는 테스트 전용이며 production boundary에서 거부됩니다.

실행 중인 서비스를 읽기 전용으로 캡처하려면 다음을 사용합니다. 생성된 이미지에는 운영 콘텐츠가 포함될 수 있어 기본적으로 Git 제외 대상입니다.

```bash
OSAU_CAPTURE_BASE_URL=http://127.0.0.1:3000 \
npm run capture:design
```

## 보안 경계

- API Key와 WordPress Application Password는 화면·로그·캡처에 표시하지 않습니다.
- 외부 Provider와 WordPress 자격증명은 production에서 HTTPS로만 전송합니다.
- 비공식 Naver·Instagram·TikTok browser automation은 사용하지 않습니다.
- WordPress는 승인된 결과물을 `draft`로만 생성하며 공개 게시하지 않습니다.

추가 설계와 품질 계약은 [PRODUCT_INTENT.md](PRODUCT_INTENT.md), [DESIGN.md](DESIGN.md), [품질 방법론](docs/QUALITY_METHODOLOGY.md), [플랫폼 계약](docs/platforms/README.md)을 참고하세요.
