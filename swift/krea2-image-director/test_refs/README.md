# test_refs — parity oracles (regenerable, NOT all committed)

These safetensors are **torch/python oracle tensors** consumed by the
`Krea2ImageDirectorTests` parity suite. They are produced by small random-weight
configs (block-math checks, not the real 12B weights), so anyone can regenerate
them locally with the matching `scripts/dump_*_reference.py`.

Large oracles (e.g. `dit/full_dit.safetensors`, 2.5 MB) are **deliberately not
committed** to keep the repo lean. Parity tests detect a missing oracle and
`XCTSkip` (pointing here) rather than fail.

## Regenerate

From repo root (uses the MLX venv, no torch/CUDA needed):

```bash
../video_generation__venv/bin/python swift/krea2-image-director/scripts/dump_dit_reference.py
../video_generation__venv/bin/python swift/krea2-image-director/scripts/dump_vae_reference.py
../video_generation__venv/bin/python swift/krea2-image-director/scripts/dump_rope_reference.py
```

Then `swift test --package-path swift/krea2-image-director` runs the parity
checks against the freshly generated tensors.
