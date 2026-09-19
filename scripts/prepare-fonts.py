"""Vendor the small Latin subsets so the app works without remote fonts.

Writes into web/fonts, where next/font/local picks the files up.
"""
from pathlib import Path
import re
from urllib.request import Request, urlopen

url = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400..700&family=Manrope:wght@400..800&display=swap'
request = Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'})
css = urlopen(request, timeout=30).read().decode()
folder = Path('web/fonts')
folder.mkdir(parents=True, exist_ok=True)
blocks = re.findall(r'/\* latin \*/\s*(@font-face\s*\{.*?\})', css, re.S)
if not blocks:
    blocks = re.findall(r'@font-face\s*\{.*?\}', css, re.S)
output = []
for index, block in enumerate(blocks):
    source = re.search(r'url\((https://fonts\.gstatic\.com/[^)]+)\)', block)[1]
    family = re.search(r"font-family: '([^']+)'", block)[1].lower().replace(' ', '-')
    weight = re.search(r'font-weight: ([^;]+)', block)[1].replace(' ', '-')
    name = family + '-' + weight + ('.woff2' if '.woff2' in source else '.ttf')
    data = urlopen(source, timeout=30).read()
    (folder / name).write_bytes(data)
    output.append(name)
for family in ['dmsans', 'manrope']:
    license_url = f'https://raw.githubusercontent.com/google/fonts/main/ofl/{family}/OFL.txt'
    (folder / (family + '-OFL.txt')).write_bytes(urlopen(license_url, timeout=30).read())
print(f'Saved {len(output)} font faces locally, with licenses.')
