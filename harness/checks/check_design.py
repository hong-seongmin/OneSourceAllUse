from pathlib import Path
import re, sys, yaml

ROOT = Path(__file__).resolve().parents[2]
text = (ROOT / 'DESIGN.md').read_text(encoding='utf-8')
match = re.match(r'^---\n(.*?)\n---\n', text, re.S)
if not match:
    print('ERROR DESIGN.md requires YAML frontmatter')
    sys.exit(1)
data = yaml.safe_load(match.group(1))
colors = data.get('colors', {})
required = ['canvas','surface','ink','ink-secondary','accent','accent-on-soft','accent-soft','success','warning','danger','agent']
missing = [k for k in required if k not in colors]
if missing:
    print('ERROR missing design colors:', ', '.join(missing))
    sys.exit(1)

def lum(hexcolor):
    v = hexcolor.lstrip('#')
    rgb = [int(v[i:i+2], 16) / 255 for i in (0,2,4)]
    def f(c): return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
    r,g,b = map(f,rgb)
    return 0.2126*r + 0.7152*g + 0.0722*b

def contrast(a,b):
    l1,l2=sorted([lum(a),lum(b)], reverse=True)
    return (l1+0.05)/(l2+0.05)
checks = [
    ('white/accent','#FFFFFF',colors['accent']),
    ('accent-on-soft/accent-soft',colors['accent-on-soft'],colors['accent-soft']),
    ('ink-secondary/surface',colors['ink-secondary'],colors['surface']),
]
for name,a,b in checks:
    ratio=contrast(a,b)
    if ratio < 4.5:
        print(f'ERROR contrast {name}={ratio:.2f}')
        sys.exit(1)
print('design: PASS')
