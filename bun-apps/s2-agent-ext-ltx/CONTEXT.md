# s2-agent-ext-ltx

The ubiquitous language of s2-agent-ext-ltx — an agent-optimized wrapper around the `ltx-video` pure-Swift/MLX generator (LTX-2.3 image-to-video on Apple Silicon). One dispatcher tool over 15 commands; the load-bearing distinction is the **native-*** family (pure-Swift/MLX, zero `run.py`) vs the production `i2v` (which bridges `run.py`).

## Language

### The wrapper

**ltx-video**:
The pure-Swift/MLX LTX-2.3 generator binary (`swift/ltx-video-director`), 15 subcommands. Image-to-video on Apple Silicon.
_Avoid_: the model (ltx-video is the CLI/binary; LTX-2.3 is the model), the director

**Dispatcher tool**:
The single `ltx({ command, options })` agent tool — one entry point over 15 subcommands. Same pattern as flux2's dispatcher.
_Avoid_: command tool, router

**Command**:
One of the 15 subcommands. The first selector into the dispatcher.
_Avoid_: subcommand, action

### native-* vs production

**native-* family** (`native-i2v`, `native-t2a`, `native-relay`, `native-ingredients`, `native-restyle`, `native-upscale`):
The pure-Swift/MLX, **zero-`run.py`** path. Distilled transformer only, no VLM prompt expansion.
_Avoid_: experimental commands, swift commands (the defining property is zero-run.py native MLX, not "experimental")

**native-i2v**:
The pure-Swift/MLX image-to-video path — PNG frame sequence + WAV + real `.mp4`; supports First-Last-Frame conditioning, LoRA fusion, custom audio, input-image chaining, auto post-upscale refine.
_Avoid_: the i2v (that is the production pipeline; native-i2v is the zero-run.py path)

**`i2v`** (production):
The production pipeline — ZImage T2I → VLM prompt expansion → LTX I2V — still bridges `run.py` for the VLM/quality-check stages. Higher default quality/duration.
_Avoid_: native-i2v (opposite — native is zero-run.py), the video command

**native-relay**:
Multi-segment prompt-relay video, 100% native — no `run.py`, no ffmpeg. Chains N native-i2v generations via `inputImage` (each segment's last decoded frame feeds the next segment's start), then concatenates.
_Avoid_: stitch, sequence (it is prompt-relay chaining via shared frame state)

### Other commands

**native-t2a**:
Audio-only generation, 100% native — no video, no T2I, no I2V, no `run.py`. Use when the deliverable is just a WAV.
_Avoid_: TTS, audio gen (it is native audio-only generation)

**segment**:
Scene-cut detection on an existing video (HSV-histogram correlation — no VLM, no generation). Returns per-cut start/end/duration.
_Avoid_: split, detect (it is HSV-correlation scene-cut detection)

### Results

**Stdout-regex parsing**:
ltx-video writes **no manifest sidecar** (unlike flux2); results (`details.output`, `details.extraOutputs`) are parsed from the CLI's own stdout prints.
_Avoid_: manifest parsing (there is no manifest), output parsing (it is stdout-regex specifically — the distinguishing constraint vs flux2)

**Tri-state booleans** (`.prefixedNo`):
ArgumentParser-backed flags that emit `--no-x` when set to `false`, not just omission (e.g. `upscale` / `refine`).
_Avoid_: flags, options (they are tri-state inverted booleans)

### Integrity

**Binary auto-build**:
Resolves `.build/release/ltx-video`; if missing, streams `swift build -c release` once, colocates `mlx.metallib` via `setup-metallib.sh`, and caches it.
_Avoid_: build step (it is on-demand first-run build + metallib colocate + cache)

**Path-safety guards**:
All paths validated under repo / output-dir / models-tree roots; flag-like values rejected (anti-argv-injection). Same as flux2.
_Avoid_: validation, sanitization
