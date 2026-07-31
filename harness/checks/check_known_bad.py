from pathlib import Path
import json, sys

ROOT = Path(__file__).resolve().parents[2]
dirpath = ROOT / 'harness' / 'known-bad'
files = sorted(dirpath.glob('*.json'))
required_ids = {
  'false-green-evidence','channel-copy','dead-end-transcript',
  'persona-fabrication','silent-stale-multi-atom','fixture-provider-production'
}
seen=set()
for p in files:
    data=json.loads(p.read_text(encoding='utf-8'))
    case_id=data.get('id')
    codes=data.get('expectedIssueCodes') or data.get('expected_issue_codes')
    if not case_id or not isinstance(codes,list) or not codes:
        print(f'ERROR malformed known-bad: {p.name}')
        sys.exit(1)
    if p.stem != case_id:
        print(f'ERROR filename/id mismatch: {p.name} != {case_id}')
        sys.exit(1)
    if len(codes) != len(set(codes)):
        print(f'ERROR duplicate expected issue code: {p.name}')
        sys.exit(1)
    seen.add(case_id)
missing=required_ids-seen
if missing:
    print('ERROR missing known-bad:', ', '.join(sorted(missing)))
    sys.exit(1)
print(f'known-bad contract: PASS ({len(files)} cases)')
