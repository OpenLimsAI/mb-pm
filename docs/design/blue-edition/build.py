"""Package a self-contained, offline-capable HTML design draft. No service access."""
from pathlib import Path

root = Path(__file__).resolve().parent
html = (root / 'shell.html').read_text(encoding='utf-8')
for marker, name in [('STYLES', 'styles.css'), ('CORE', 'core.js'), ('EXTRA', 'extra-views.js')]:
    html = html.replace(f'/*__{marker}__*/', (root / name).read_text(encoding='utf-8'))
html = html.replace('/*__START__*/', 'initialize();')
(root / 'index.html').write_text(html, encoding='utf-8')
print(f'Created standalone design draft: {root / "index.html"}')
