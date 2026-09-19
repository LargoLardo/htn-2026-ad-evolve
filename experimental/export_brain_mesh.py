"""Export the fsaverage5 pial surface and Percept family map for the web brain view.

    python -m pip install nilearn
    python -m experimental.export_brain_mesh

Vertex order is left-then-right, matching worker/assets/glasser-fsaverage5.json and the
20,484-vertex predictions Percept scores, so vertex i here is vertex i there. The family
map is derived from worker/percept_score.py itself, so the surface cannot drift from the
parcels that produce the scores.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from nilearn.datasets import fetch_surf_fsaverage
from nilearn.surface import load_surf_data, load_surf_mesh

ROOT = Path(__file__).resolve().parents[1]
HEMISPHERE_VERTICES = 10242
DIMENSION = 20484


def percept_module():
    spec = importlib.util.spec_from_file_location("percept_score", ROOT / "worker/percept_score.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def family_map(percept):
    """One family per vertex: 0 for unassigned cortex, 1-4 in FAMILIES order."""
    labels = np.zeros(DIMENSION, dtype=np.uint8)
    groups = percept.family_parcels(percept.load_atlas())
    for index, parcels in enumerate(groups, start=1):
        for indices in parcels.values():
            labels[indices] = index
    if not labels.any():
        raise ValueError("No Percept family matched any atlas parcel.")
    return labels


def export(output_dir):
    output_dir = Path(output_dir)
    percept = percept_module()
    fsaverage = fetch_surf_fsaverage("fsaverage5")
    left_coordinates, left_faces = load_surf_mesh(fsaverage["pial_left"])
    right_coordinates, right_faces = load_surf_mesh(fsaverage["pial_right"])
    if len(left_coordinates) != HEMISPHERE_VERTICES or len(right_coordinates) != HEMISPHERE_VERTICES:
        raise ValueError("Expected 10,242 vertices per fsaverage5 hemisphere.")

    coordinates = np.vstack([left_coordinates, right_coordinates]).astype(np.float64)
    faces = np.vstack([left_faces, right_faces + HEMISPHERE_VERTICES]).astype(np.uint32)
    sulcal_depth = np.concatenate([
        load_surf_data(fsaverage["sulc_left"]),
        load_surf_data(fsaverage["sulc_right"]),
    ]).astype(np.float32)
    families = family_map(percept)
    if len(coordinates) != DIMENSION or len(sulcal_depth) != DIMENSION:
        raise ValueError("Mesh, curvature and prediction dimensions disagree.")
    if not np.isfinite(coordinates).all() or not np.isfinite(sulcal_depth).all():
        raise ValueError("Nonfinite mesh data.")
    if faces.max() >= DIMENSION:
        raise ValueError("Face index outside the vertex range.")

    # Modification: FreeSurfer RAS (x right, y anterior, z superior) becomes three.js
    # Y-up, then the mesh is centred on its bounding box and scaled from millimetres.
    oriented = np.column_stack([coordinates[:, 0], coordinates[:, 2], -coordinates[:, 1]])
    centre = (oriented.max(axis=0) + oriented.min(axis=0)) / 2
    positions = ((oriented - centre) / 100).astype("<f4")

    files = {
        "positions.f32": positions.tobytes(),
        "indices.u32": faces.astype("<u4").tobytes(),
        "sulc.f32": sulcal_depth.astype("<f4").tobytes(),
        "family.u8": families.tobytes(),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        (output_dir / name).write_bytes(payload)

    manifest = {
        "schema": "evolve-brain-mesh-v2",
        "surface": "fsaverage5 pial",
        "vertex_order": "left-then-right",
        "vertexCount": len(positions),
        "faceCount": len(faces),
        "families": [{"index": index, "key": key, "name": name, "color": color}
                     for index, (key, name, _short, color, _reliability, _patterns)
                     in enumerate(percept.FAMILIES, start=1)],
        "files": {name: {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
                  for name, payload in files.items()},
        "source": {
            "mesh": "FreeSurfer fsaverage5 pial surface and sulcal depth, as distributed with nilearn",
            "citation": "https://doi.org/10.1006/nimg.1998.0396",
            "license": "FreeSurfer Software License; see LICENSE-freesurfer.txt",
            "modifications": "Hemispheres concatenated left-then-right, axes reordered to Y-up, centred on the bounding box, scaled by 1/100, written as little-endian binary.",
        },
        "atlas": {
            "name": "Glasser 2016 parcellation, grouped into Percept families",
            "source": "worker/assets/glasser-fsaverage5.json via worker/percept_score.py",
            "attribution": "worker/assets/ATTRIBUTION.md",
        },
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    covered = int((families > 0).sum())
    print(json.dumps({"path": str(output_dir), "vertices": len(positions), "faces": len(faces),
                      "familyVertices": covered}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "web/public/brain")
    export(parser.parse_args().output)
