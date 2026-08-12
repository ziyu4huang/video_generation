# pi-agent-ext-flux2

The ubiquitous language of pi-agent-ext-flux2 — an agent-optimized wrapper around the `flux2` pure-Swift/MLX image generator (Flux2 Klein 9B + SAM3.1). Exposes flux2's 18 subcommands through one dispatcher tool so an agent can generate, gate, and chain images without memorizing flags.

## Language

### The wrapper

**flux2**:
The pure-Swift/MLX image generator binary (`swift/flux2-image-director`), 18 subcommands. Flux2 Klein 9B + SAM3.1.
_Avoid_: the model (flux2 is the CLI/binary; Flux2 Klein is the model), the director

**Dispatcher tool**:
The single `flux2({ command, options })` agent tool — one entry point over 18 subcommands with typed per-command parameters. The shape this extension exists to provide.
_Avoid_: command tool, router

**Command**:
One of the 18 subcommands (`t2i · scene · edit · style · angle · swap · expand · upscale · gate · segment · story · models · verify-*`). The first selector into the dispatcher.
_Avoid_: subcommand (ambiguous — see pi-agent), action

### Results & chaining

**Manifest sidecar** (`.manifest.json`):
The structured-result source — every generation's `details` (output path, dimensions, seed, `gate`, `perf`) is parsed from this sidecar flux2 writes.
_Avoid_: output file, metadata (it is the structured-result sidecar specifically)

**Chaining**:
Reusing a generation's `details.output` as the next command's input (`scene → gate → upscale`). The intended composition pattern.
_Avoid_: piping, linking (it is path-reuse composition, not a pipe)

**Binary auto-build**:
The tool resolves `.build/release/flux2`; if missing, streams `swift build -c release` once and caches it.
_Avoid_: build step, compilation (it is on-demand first-run build + cache)

### Quality

**Quality gate** (`flux2 gate`):
The image-quality subcommand auto-run on each generation's output, returning a score in `details.gate`. Named "quality gate" (not bare `gate`) to disambiguate from movie-director's "the gate", which is a human-approval enforcement — opposite meanings, same root word.
_Avoid_: bare gate (collides with movie-director's approval gate), check, score, validator

**pose_dsg**:
The atomic pose validator for complex human poses (hands, limbs, face) — DSG/TIFA atoms + an AbHuman anatomy gate, aggregated in Python. Used instead of the holistic `--style score`, which over-praises.
_Avoid_: pose check, score (it is an atomic DSG-based validator, not a holistic score)

### scene

**scene**:
A subcommand whose refs are global tokens (no identity→region binding), so placement/pose is prompt-driven and reliable-but-probabilistic.
_Avoid_: composition, layout

**scenePipeline**:
The multi-seed scene capability — render the same scene across N seeds, gate each, optionally VLM-verify each, and auto-pick a winner. Formalizes what `scripts/multi-seed-autoselect.sh` did by hand.
_Avoid_: loop, batch render (it is a render/gate/verify/pick-winner pipeline)

**VLM verification**:
Asking a vision-LLM subagent a question about each rendered candidate (via pi-file2md's shared subagent), with `verifyMatch` substrings a winner must contain.
_Avoid_: vision check, image judge (it is a prompted VLM subagent verification)

### Self-improve loop

**Self-improve loop** (`self-improve-flux2.js`):
A bounded propose-only closed loop — generate → judge (pose_dsg / score) → retry on fail → pick best-so-far comparatively.
_Avoid_: optimizer, trainer (it is a propose-only best-effort loop, no learning)

**best-of-n vs reflect** (`--mode`):
The two loop modes. `best-of-n` (default) samples a fresh seed per attempt with bare prompts (measured verdict: seed sampling is the real quality lever on flux2-klein). `reflect` (opt-in) injects failed-atom feedback — retained but not observed to beat best-of-n on flux2-klein.
_Avoid_: sampling vs feedback (name the modes, not the mechanism)

### Integrity

**Path-safety guards**:
All paths validated under repo / output-dir / models-tree roots; flag-like values rejected (anti-argv-injection).
_Avoid_: validation, sanitization (it is root-confinement + injection guard)
