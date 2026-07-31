#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v python3 >/dev/null || { echo 'ERROR: python3 is required.' >&2; exit 1; }
command -v node >/dev/null || { echo 'ERROR: Node.js is required.' >&2; exit 1; }
command -v codex >/dev/null || { echo 'ERROR: Codex CLI is required.' >&2; exit 1; }

if [[ ! -d .harness-venv ]]; then
  python3 -m venv .harness-venv
fi
source .harness-venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r harness/requirements.txt
python -m playwright install chromium

chmod +x harness/run.sh harness/setup.sh
./harness/run.sh quick

echo
echo 'Harness ready.'
echo 'Run Codex with:'
echo '  codex --yolo "$(cat CODEX_COMMAND_KO.md)"'
