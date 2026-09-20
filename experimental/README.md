# Paused decoder experiments

OASIS extraction, fitted-decoder training and local model downloads remain stopped. Existing feature caches, partial model weights, training data and pilot results are preserved under ignored `data/` directories. The pilot did not beat a constant baseline; see [training history](../training/README.md).

The active application now uses [neural scoring](../worker/README.md), which needs no fitted decoder or OASIS reference. The previous OASIS-reference percentile/spatial-correlation scorer, Yeo assets and reference-building code have been deleted. Historical run JSON remains readable; its recorded scores are not relabeled.

Archived training/download commands still require deliberate per-command `EVOLVE_ENABLE_EXPERIMENTAL_TRAINING=1`. Automatic training after extraction remains disabled. Do not resume those jobs as part of application setup or verification.
