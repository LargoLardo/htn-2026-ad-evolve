"""Attention map: predicted eye gaze over a still ad, via DeepGaze IIE.

This is the commodity half of the pair. It answers "where do people look",
which several vendors already sell. It exists so it can be differenced against
the impact map, which answers "what actually moves the response".

Output is a heatmap PNG plus an NxN grid of mean density per cell. The grid
geometry must match lib/grid.mjs exactly or the two maps cannot be subtracted.
"""
import argparse
import contextlib
import json
import sys

import numpy as np
import torch
from PIL import Image

# DeepGaze IIE is the spatial saliency model. Not III, which needs a fixation
# history we do not have, and not MSDB, which needs a dataset id and a
# pixels-per-degree figure that is meaningless for an ad viewed at any size.
from deepgaze_pytorch import DeepGazeIIE

# MIT1003 was collected at 1024x768. The model is scale-sensitive, so the long
# edge is matched to that rather than feeding arbitrary ad dimensions.
TRAINING_LONG_EDGE = 1024


def js_round(value):
    """Match JavaScript's Math.round so cell edges agree with lib/grid.mjs.

    Python's round() is banker's rounding: round(0.5) is 0, round(1.5) is 2.
    JavaScript rounds half up. On a grid boundary that lands exactly on .5 the
    two disagree by a pixel, the cells stop lining up, and the gap map silently
    compares different regions.
    """
    return int(np.floor(value + 0.5))


def cells(width, height, n):
    """Integer cell rectangles, identical to cells() in lib/grid.mjs."""
    edge = lambda index, total: js_round(index * total / n)
    out = []
    for row in range(n):
        for col in range(n):
            x, y = edge(col, width), edge(row, height)
            out.append(dict(row=row, col=col, index=row * n + col, x=x, y=y,
                            w=edge(col + 1, width) - x, h=edge(row + 1, height) - y))
    return out


def load_image(path):
    image = Image.open(path).convert("RGB")
    scale = TRAINING_LONG_EDGE / max(image.size)
    if scale < 1.0:
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)
    return np.array(image)


def saliency(image, device, model=None):
    """Return a normalised 0-1 density the same size as the input image."""
    # EfficientNet prints "Loaded pretrained weights..." straight to stdout, which
    # corrupts the JSON this script exists to emit. Everything the model says goes
    # to stderr; stdout carries the result and nothing else.
    if model is None:
        with contextlib.redirect_stdout(sys.stderr):
            model = DeepGazeIIE(pretrained=True).to(device).eval()
    tensor = torch.tensor(image.transpose(2, 0, 1)[np.newaxis], dtype=torch.float32, device=device)

    # Uniform centerbias, deliberately.
    #
    # The published centerbias is a prior learned from people free-viewing
    # natural photographs in a lab, and it is not distributed in the repo or its
    # releases. Applying it to an ad would bake in a pull toward the middle that
    # the ad's own composition has not earned. Zeros in log space is a uniform
    # prior, so the map stays purely content-driven. Swap a real centerbias in
    # here if one is ever obtained.
    centerbias = torch.zeros((1, image.shape[0], image.shape[1]), dtype=torch.float32, device=device)

    with torch.no_grad():
        log_density = model(tensor, centerbias)

    # The model returns a LOG density. Exponentiating is not optional; skipping
    # it produces a map that looks plausible and is wrong.
    density = torch.exp(log_density)[0, 0].cpu().numpy().astype(np.float64)
    span = density.max() - density.min()
    return np.zeros_like(density) if span < 1e-12 else (density - density.min()) / span


def to_grid(density, n):
    height, width = density.shape
    return [float(density[c["y"]:c["y"] + c["h"], c["x"]:c["x"] + c["w"]].mean()) for c in cells(width, height, n)]


def write_heatmap(density, path):
    """White pixels with density in the ALPHA channel.

    A greyscale PNG has no alpha, and CSS mask-image masks on alpha by default,
    so a grey ramp masks at 100% everywhere and tints the whole ad. Putting the
    density in alpha makes the file work both as a CSS mask and as a plain <img>
    overlay, without depending on mask-mode: luminance, which Safari handles
    inconsistently.
    """
    alpha = (np.clip(density, 0, 1) * 255).astype(np.uint8)
    rgba = np.dstack([np.full_like(alpha, 255)] * 3 + [alpha])
    Image.fromarray(rgba, mode="RGBA").save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--grid", type=int, default=3)
    parser.add_argument("--heatmap", help="Optional greyscale PNG output path.")
    args = parser.parse_args()

    # Matches MAX_GRID in lib/grid.mjs. The attention grid is only a sampling
    # resolution for a continuous density and costs no GPU, so it runs finer
    # than the old occlusion grid ever did.
    if not 2 <= args.grid <= 16:
        raise SystemExit("--grid must be between 2 and 16")

    # CPU rather than MPS on Apple silicon, deliberately.
    #
    # DeepGaze IIE carries float64 buffers, and MPS cannot hold float64, so
    # .to("mps") raises before inference starts. Casting them to float32 would
    # silently reduce the precision of the finalizer that normalises the log
    # density, so the honest fallback is CPU. One 1024px image takes seconds,
    # and this runs once per ad rather than once per occluded cell.
    device = "cuda" if torch.cuda.is_available() else "cpu"
    image = load_image(args.image)
    density = saliency(image, device)
    if args.heatmap:
        write_heatmap(density, args.heatmap)

    json.dump({
        "source": "deepgaze-iie",
        "device": device,
        "grid": args.grid,
        "width": int(density.shape[1]),
        "height": int(density.shape[0]),
        "centerbias": "uniform",
        "map": to_grid(density, args.grid),
        "provenance": "DeepGaze IIE predicted fixation density with a uniform centerbias. Predicted gaze, not measured eye tracking.",
    }, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
