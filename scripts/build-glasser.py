"""Build the small atlas used by Percept; downloads annotations, never model weights."""
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request

import nibabel.freesurfer.io as fs
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FILES = [('lh', 5528816, '46a102b59b2fb1bb4bd62d51bf02e975'), ('rh', 5528819, '75e96b331940227bbcb07c1c791c2463')]
parcels, sources = {}, []
with tempfile.TemporaryDirectory() as tmp:
    for hemi, file_id, md5 in FILES:
        url = f'https://ndownloader.figshare.com/files/{file_id}'
        raw = urllib.request.urlopen(url, timeout=60).read()
        assert hashlib.md5(raw).hexdigest() == md5
        path = Path(tmp) / f'{hemi}.annot'
        path.write_bytes(raw)
        labels, _, names = fs.read_annot(path)
        for index, encoded in enumerate(names):
            name = encoded.decode()[2:].replace('_ROI', '')
            if not name or '?' in name: continue
            vertices = np.where(labels[:10242] == index)[0] + (10242 if hemi == 'rh' else 0)
            parcels.setdefault(name, []).extend(vertices.tolist())
        sources.append({'url': url, 'md5': md5, 'sha256': hashlib.sha256(raw).hexdigest()})
assert len(parcels) == 180 and all(parcels.values())
artifact = {'schema': 'glasser-fsaverage5-v1', 'dimension': 20484, 'vertex_order': 'left-then-right',
    'projection': 'Mills 2016 HCP-MMP1.0 on fsaverage; keep vertex IDs <10242 in each hemisphere',
    'source': 'https://doi.org/10.6084/m9.figshare.3498446.v2', 'license': 'CC BY 4.0',
    'citation': 'Glasser et al. 2016, https://doi.org/10.1038/nature18933',
    'files': sources, 'parcels': dict(sorted(parcels.items()))}
path = ROOT / 'worker/assets/glasser-fsaverage5.json'
raw = (json.dumps(artifact, separators=(',', ':')) + '\n').encode()
path.write_bytes(raw)
path.with_suffix('.sha256').write_text(hashlib.sha256(raw).hexdigest()+'\n')
print(json.dumps({'parcels': len(parcels), 'vertices': sum(map(len,parcels.values())), 'bytes': len(raw)}))
