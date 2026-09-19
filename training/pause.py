"""Explicit opt-in for archived extraction/training; never enabled by the app."""
import os


def require_experimental_resume():
    if os.environ.get("EVOLVE_ENABLE_EXPERIMENTAL_TRAINING") != "1":
        raise RuntimeError("OASIS extraction, model downloads and decoder training are paused. "
            "Archived experimental workflow only. To deliberately resume a specific command, "
            "set EVOLVE_ENABLE_EXPERIMENTAL_TRAINING=1 for that command. "
            "The app uses training-free scoring; existing artifacts are preserved.")
