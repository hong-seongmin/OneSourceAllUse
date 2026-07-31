from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
required = [
    'AGENTS.md', 'PRODUCT_INTENT.md', 'DESIGN.md',
    'docs/PRD_BASELINE.md', 'tasks/PRODUCTION_BUILD.md',
    'CODEX_COMMAND_KO.md', 'harness/README_KO.md'
]
missing = [p for p in required if not (ROOT / p).is_file()]
if missing:
    print('ERROR missing required contract files:', ', '.join(missing))
    sys.exit(1)

agents = (ROOT / 'AGENTS.md').read_text(encoding='utf-8')
truth = (ROOT / 'PRODUCT_INTENT.md').read_text(encoding='utf-8')
for phrase in ['Do not perform Git operations', 'known-bad', 'human verification']:
    if phrase.lower() not in agents.lower():
        print(f'ERROR AGENTS.md missing contract phrase: {phrase}')
        sys.exit(1)
for phrase in ['Provenance and verification are separate', 'source update', 'Fixture providers']:
    if phrase.lower() not in truth.lower():
        print(f'ERROR PRODUCT_INTENT.md missing truth: {phrase}')
        sys.exit(1)
print('contract: PASS')
