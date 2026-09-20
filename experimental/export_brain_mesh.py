"""Export the fsaverage5 pial surface and neural family map for the web brain view.

    python -m pip install nilearn
    python -m experimental.export_brain_mesh

Vertex order is left-then-right, matching worker/assets/glasser-fsaverage5.json and the
20,484-vertex predictions the scoring worker produces, so vertex i here is vertex i there.
The family map is derived from worker/neural_score.py itself, so the surface cannot drift
from the parcels that produce the scores.
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

# Why each family's parcels sit where they do. Every DOI below was checked against
# Crossref; the parcel lists themselves come from worker/neural_score.py, not from here.
EVIDENCE = {
    'auditory_engagement': {
        'anatomy': 'Auditory core (A1), surrounding belt (MBelt, LBelt, PBelt) and parabelt '
                   '(A4, A5) on the superior temporal plane, with adjacent STG and STS parcels.',
        'sources': [
            {'text': 'Moerel, De Martino & Formisano (2014), An anatomical and functional topography of human auditory cortical areas, Front. Neurosci.',
             'doi': '10.3389/fnins.2014.00225'},
        ],
    },
    'language_message': {
        'anatomy': 'Inferior frontal gyrus areas 44 and 45 (Broca\'s region) with 47l and the '
                   'inferior frontal sulcus/junction parcels.',
        'sources': [
            {'text': 'Friederici (2011), The brain basis of language processing: from structure to function, Physiol. Rev.',
             'doi': '10.1152/physrev.00006.2011'},
        ],
    },
    'attention_salience': {
        'anatomy': 'Dorsal frontoparietal attention parcels (IPS, LIP, VIP, FEF, 6a) together with '
                   'salience parcels in anterior insula (AVI, MI, FOP) and mid-cingulate (a24pr, p24pr), '
                   'plus inferior parietal and temporoparietal junction areas.',
        'sources': [
            {'text': 'Corbetta & Shulman (2002), Control of goal-directed and stimulus-driven attention in the brain, Nat. Rev. Neurosci.',
             'doi': '10.1038/nrn755'},
            {'text': 'Seeley et al. (2007), Dissociable intrinsic connectivity networks for salience processing and executive control, J. Neurosci.',
             'doi': '10.1523/JNEUROSCI.5587-06.2007'},
        ],
    },
    'visual_motion': {
        'anatomy': 'The human MT+ motion complex (MT, MST, V4t, FST) with the neighbouring lateral '
                   'occipital parcels (LO1-LO3, V3CD) that Glasser groups with it.',
        'sources': [
            {'text': 'Tootell et al. (1995), Functional analysis of human MT and related visual cortical areas using MRI, J. Neurosci.',
             'doi': '10.1523/JNEUROSCI.15-04-03215.1995'},
        ],
    },
}


def neural_module():
    spec = importlib.util.spec_from_file_location("neural_score", ROOT / "worker/neural_score.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def family_map(scorer):
    """Family per vertex (0 unassigned, 1-4 in FAMILIES order) and parcel per vertex.

    Parcels are numbered 1-N across families in the same order neural_score.parcel_traces
    emits them, and the manifest records each name so the client matches by name, never
    by position.
    """
    labels = np.zeros(DIMENSION, dtype=np.uint8)
    parcel_labels = np.zeros(DIMENSION, dtype=np.uint16)
    groups = scorer.family_parcels(scorer.load_atlas())
    catalogue, number = [], 0
    for index, ((key, *_), parcels) in enumerate(zip(scorer.FAMILIES, groups), start=1):
        for name, indices in parcels.items():
            number += 1
            labels[indices] = index
            parcel_labels[indices] = number
            catalogue.append({"index": number, "name": name, "family": key})
    if not labels.any():
        raise ValueError("No neural family matched any atlas parcel.")
    return labels, parcel_labels, catalogue, groups


def export(output_dir):
    output_dir = Path(output_dir)
    scorer = neural_module()
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
    families, parcel_labels, catalogue, groups = family_map(scorer)
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
        "parcel.u16": parcel_labels.astype("<u2").tobytes(),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        (output_dir / name).write_bytes(payload)

    manifest = {
        "schema": "evolve-brain-mesh-v3",
        "surface": "fsaverage5 pial",
        "parcels": catalogue,
        "vertex_order": "left-then-right",
        "vertexCount": len(positions),
        "faceCount": len(faces),
        "families": [{"index": index, "key": key, "name": name, "short": short, "color": color,
                      "reliability": reliability, "vertexCount": int((families == index).sum()),
                      "parcels": sorted(groups[index - 1]), **EVIDENCE[key]}
                     for index, (key, name, short, color, reliability, _patterns)
                     in enumerate(scorer.FAMILIES, start=1)],
        "files": {name: {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
                  for name, payload in files.items()},
        "source": {
            "mesh": "FreeSurfer fsaverage5 pial surface and sulcal depth, as distributed with nilearn",
            "citation": "https://doi.org/10.1006/nimg.1998.0396",
            "license": "FreeSurfer Software License; see LICENSE-freesurfer.txt",
            "modifications": "Hemispheres concatenated left-then-right, axes reordered to Y-up, centred on the bounding box, scaled by 1/100, written as little-endian binary.",
        },
        "atlas": {
            "name": "Glasser 2016 parcellation, grouped into neural families",
            "source": "worker/assets/glasser-fsaverage5.json via worker/neural_score.py",
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
