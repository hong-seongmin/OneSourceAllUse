#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-quick}"

if [[ ! -x .harness-venv/bin/python ]]; then
  echo 'ERROR: run ./harness/setup.sh first.' >&2
  exit 1
fi
PY="$ROOT/.harness-venv/bin/python"

run_quick() {
  "$PY" harness/checks/check_contract.py
  "$PY" harness/checks/check_design.py
  "$PY" harness/checks/check_known_bad.py
  if [[ -f package.json ]]; then
    run_script_if_declared test:quick
  fi
}

run_script_if_declared() {
  local name="$1"
  if [[ ! -f package.json ]]; then
    echo "ERROR: package.json is missing; required script: $name" >&2
    return 1
  fi
  if ! node -e "const p=require('./package.json'); process.exit(p.scripts?.['$name']?0:1)"; then
    echo "ERROR: package.json script '$name' is required." >&2
    return 1
  fi
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$name"
  else
    npm run "$name"
  fi
}

run_postgres_integration() {
  if [[ -z "${OSAU_POSTGRES_TEST_URL:-}" ]]; then
    echo 'ERROR: OSAU_POSTGRES_TEST_URL is required for full/release PostgreSQL integration.' >&2
    return 1
  fi
  (
    export OSAU_REQUIRE_POSTGRES=1
    run_script_if_declared test:integration
  )
}

run_release_container_smoke() {
  (
    export OSAU_REQUIRE_DOCKER=1
    run_script_if_declared container:smoke
  )
}

case "$MODE" in
  quick)
    run_quick
    ;;
  full)
    run_quick
    run_script_if_declared build
    run_postgres_integration
    run_script_if_declared test:quality
    run_script_if_declared test:e2e
    run_script_if_declared security:check
    ;;
  release)
    run_quick
    "$PY" harness/checks/check_release_contract.py
    run_script_if_declared build
    run_postgres_integration
    run_script_if_declared test:quality
    run_script_if_declared test:e2e
    run_script_if_declared security:check
    run_release_container_smoke
    run_script_if_declared test:release
    ;;
  *)
    echo 'Usage: ./harness/run.sh quick|full|release' >&2
    exit 2
    ;;
esac

echo "OSAU harness '$MODE': PASS"
