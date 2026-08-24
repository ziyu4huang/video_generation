# s2-agent-ext-krea2

Pi extension that wraps the pure-Swift **Krea 2 Turbo** CLI (`swift/krea2-image-director`, command name `krea2`) as ONE agent-optimized tool. Native Swift/MLX on Apple Silicon — **zero Python** on the default path.

The `krea2` CLI has two subcommands:

- **`t2i`** — text → image (native Swift MMDiT + VAE + Qwen3 text encoder, flow-matching Euler, 8 steps).
- **`i2i`** — image → image (SDEditor-style; `--strength` is the source-fidelity lever: low preserves the input, high follows the prompt).

The tool:
- resolves / auto-builds the Swift binary (+ colocates `mlx.metallib`),
- validates every image path against allowed roots (anti argv-injection — see [[argv-injection-positional-paths]]),
- streams progress and honors abort,
- parses the `[krea2] saved <abspath>` line into structured `details` (output path, dims, seed) so the agent can chain `t2i → i2i`.

Sister package `s2-agent-flux2` follows the same architecture for the larger Flux2 Klein CLI (18 subcommands). Krea 2's surface is tiny (2 subcommands, no gate/manifest/scene), so this is a focused, simplified port — not a copy.

## Load (source mode)

```bash
bun bun-apps/s2-agent/src/cli.ts -e bun-apps/s2-agent-ext-krea2/extensions/krea2.ts -p "generate a red apple on a wooden table with krea2 t2i"
```

To make pi load it permanently, add it to the run-dir manifest (the source of truth in this fork — see [[s2-agent-extensions-source-of-truth-run-dir]]):

```jsonc
// bun-apps/s2-agent/src/run-dir/manifest.json
{
  "extensions": [
    // …
    "s2-agent-ext-krea2/extensions/krea2.ts"
  ]
}
```

## Bundle

```bash
( cd bun-apps/s2-agent-ext-krea2 && bun scripts/build-bundle.ts )
# → dist/pi-extensions/s2-agent-ext-krea2.bundle.js
```

## Environment overrides

| Var | Purpose |
|---|---|
| `KREA2_BIN` | explicit path to a prebuilt `krea2` binary (skips build) |
| `KREA2_REPO_ROOT` | repo root override (needed in bundle mode) |
| `MLX_OUTPUT_DIR` | default output dir (default: `<repo>/../video_generation__output`) |

## Drift guard

```bash
( cd bun-apps/s2-agent-ext-krea2 && bun scripts/check-flags.ts )
```

Asserts every flag `krea2 t2i --help` / `krea2 i2i --help` declares is modeled in `src/commands.ts` (or allow-listed). Run after editing `commands.ts` or a `krea2` CLI change.
