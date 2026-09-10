# t01 — adjudication + pin-proof smokes

- Extract per-leg model from prior receipts' sessionFiles
  (model_change + per-message model set) → `output/spwf-ab/prior-attribution.json`.
- Two pin-proof smoke legs on the pinned deploy (g88611db):
  `--provider zai --model glm-5.3` and `--provider lm-studio --model
  google/gemma-4-12b`; receipt's recorded model MUST equal the pin.

Acceptance: effort dir committed; prior-attribution table exists; both
smoke legs' recorded model == pin.
