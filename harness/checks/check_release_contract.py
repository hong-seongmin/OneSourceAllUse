from pathlib import Path
import json, sys

ROOT=Path(__file__).resolve().parents[2]
if not (ROOT/'package.json').is_file():
    print('ERROR package.json missing')
    sys.exit(1)
pkg=json.loads((ROOT/'package.json').read_text(encoding='utf-8'))
required=['build','test:quick','test:known-bad','test:integration','test:e2e','security:check','container:smoke','test:release']
missing=[s for s in required if s not in pkg.get('scripts',{})]
if missing:
    print('ERROR missing release scripts:', ', '.join(missing))
    sys.exit(1)
required_paths=['docker-compose.yml','apps/web','apps/worker','migrations']
missing_paths=[p for p in required_paths if not (ROOT/p).exists()]
if missing_paths:
    print('ERROR missing production paths:', ', '.join(missing_paths))
    sys.exit(1)
print('release contract: PASS')
