"""Optional static frontend QA; requires tinycss2 and BeautifulSoup, not the app."""
from pathlib import Path
import re
import tinycss2
from bs4 import BeautifulSoup

css = Path('public/style.css').read_text(encoding='utf-8')
rules = tinycss2.parse_stylesheet(css, skip_comments=True, skip_whitespace=True)

def check_tokens(tokens):
    for token in tokens:
        assert token.type != 'error', (token.source_line, token.message)
        for key in ('content', 'arguments'):
            nested = getattr(token, key, None)
            if nested is not None:
                check_tokens(nested)

check_tokens(rules)
html = BeautifulSoup(Path('public/index.html').read_text(encoding='utf-8'), 'html.parser')
ids = [node['id'] for node in html.select('[id]')]
assert len(ids) == len(set(ids)), 'Duplicate HTML IDs'
script = Path('public/app.js').read_text(encoding='utf-8')
dynamic_ids = {'weight-' + name for name in ('joy', 'trust', 'curiosity', 'desire')}
for selector in re.findall(r"\$\('#([a-z0-9-]+)'\)", script):
    assert selector in ids or selector in dynamic_ids, f'Missing element #{selector}'
for node in html.select('input,textarea,select'):
    assert node.get('id') and html.select_one(f'label[for="{node["id"]}"]'), f'Missing label: {node}'
for reference in re.findall(r"url\(['\"]?(/[^)'\"]+)", css):
    assert (Path('public') / reference.lstrip('/')).is_file(), reference
for reference in re.findall(r"url\(['\"]?(/[^)'\"]+)", Path('public/fonts/fonts.css').read_text()):
    assert (Path('public') / reference.lstrip('/')).is_file(), reference
print(f'CSS parsed; {len(ids)} unique markup IDs, form labels, JS selectors and local font assets checked.')
