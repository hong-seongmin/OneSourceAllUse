# OSAU 최소 하네스

이 폴더는 Git, Dev Container, 백업 래퍼, Codex Hook 없이 동작한다.

## 처음 한 번

```bash
./harness/setup.sh
```

## 개발 중

```bash
./harness/run.sh quick
```

## DB·브라우저 기능 이후

```bash
./harness/run.sh full
```

## 기술 완료 판정

```bash
./harness/run.sh release
```

`quick`은 계약·디자인·known-bad 파일을 검사한다. `full`과 `release`는 Codex가 실제 애플리케이션 명령을 `package.json`에 구현한 뒤 그것들을 실행한다. 초기에는 release가 실패하는 것이 정상이다.
