# s2-agent-ext-krea2

The ubiquitous language of s2-agent-ext-krea2 — a focused wrapper around the pure-Swift **Krea 2 Turbo** CLI (`swift/krea2-image-director`, command `krea2`): native Swift/MLX, zero Python on the default path. The smallest model-wrapper — 2 subcommands, no gate/manifest/scene. Shares the wrapper architecture (binary auto-build, path-safety guards, drift guard) with flux2 and ltx; see those for the shared vocabulary.

## Language

### The two commands

**krea2**:
The pure-Swift Krea 2 Turbo generator binary (`swift/krea2-image-director`), 2 subcommands. Native Swift MMDiT + VAE + Qwen3 text encoder, flow-matching Euler, 8 steps.
_Avoid_: the model (krea2 is the CLI/binary; Krea 2 Turbo is the model)

**t2i**:
Text → image. The generation subcommand.
_Avoid_: generate, txt2img (it is the krea2 `t2i` subcommand)

**i2i**:
Image → image, SDEditor-style. The restyle subcommand.
_Avoid_: edit, restyle (it is the krea2 `i2i` subcommand)

### The fidelity lever

**strength** (`--strength`):
The i2i source-fidelity lever — low preserves the input image, high follows the prompt. The single knob controlling how much i2i diverges from the source.
_Avoid_: weight, influence (it is the source-fidelity strength specifically)
