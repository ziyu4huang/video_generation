# Kokoro TTS Swift-Native Port — Design Spec

## Context

`run.py tts` (`python/mlx-movie-director/app/commands/tts.py`) supports two engines:

- `--engine edge-tts` (default) — Microsoft's cloud neural TTS. **Already fully
  ported off Python** (`tts_native.ts`, via the `msedge-tts` npm package,
  registered in `registry.ts` as `edge_tts`). No Python involved at all on
  this path anymore.
- `--engine mlx` — local Kokoro-82M synthesis via the `mlx-audio` Python
  package. **Not ported, and currently unreachable from TS at all** —
  `runpy_tts.ts` doesn't even expose an `engine` option, so this path has no
  caller today. It is the one remaining genuine local-MLX-compute surface in
  `run.py tts`, and per this repo's standing rule (Python is dev-only, every
  production CLI surface must end up Swift-native — see
  `project_ltx_swift_native_port` memory), it's a real gap even though
  nothing currently calls it.

Narration in this repo is routinely generated in **Traditional Chinese**
(`edge_tts`'s own example voices in `tts.py` include `zh-TW-HsiaoChenNeural`/
`zh-TW-YunJheNeural`/`zh-TW-HsiaoYuNeural`), so a Kokoro port that only
covers English would not be usable for the repo's actual narration use case.

### Why this is a wiring job, not a from-scratch port

Unlike the MusicGen port (`swift/musicgen-director`, PR #922 — a genuine
from-scratch Swift/MLX transformer port, numerically verified layer-by-layer
against the Python reference), Kokoro does **not** need to be built from
scratch. `musicgen-director` already depends on
[`Blaizzy/mlx-audio-swift`](https://github.com/Blaizzy/mlx-audio-swift)
(pinned `exact: "0.1.3"`) for its `MLXAudioCodecs` (EnCodec) product. That
same package ships a separate `MLXAudioTTS` product containing a **complete**
Kokoro implementation:

```
Sources/MLXAudioTTS/Models/StyleTTS2/Kokoro/
  KokoroModel.swift
  KokoroConfig.swift
  KokoroDecoder.swift
  KokoroModules.swift
  KokoroMultilingualProcessor.swift
```

Its public API (per the package's own `Kokoro/README.md`):

```swift
let model = try await TTS.loadModel(modelRepo: "mlx-community/Kokoro-82M-bf16")
let audio = try await model.generate(text: "Hello from Kokoro!", voice: "af_heart")
```

The model repo id (`mlx-community/Kokoro-82M-bf16`) and voice-id scheme
(`af_*`/`am_*`/`zf_*`/`zm_*`/...) match `tts.py`'s `_DEFAULT_MLX_MODEL` and
`_MLX_VOICE_PREFIXES` exactly. This port is CLI + Bun-bridge wiring around an
already-implemented, already-numerically-shaped model — not a new transformer
port.

## Scope

**In scope:**
- A new `kokoro-tts` executable target inside the existing
  `swift/musicgen-director` Swift package (shares its already-resolved
  `mlx-audio-swift` dependency — no new package, no second SPM resolution).
- English (`af_*`/`am_*`) **and** Mandarin Chinese (`zf_*`/`zm_*`) voices,
  both verified end-to-end with real generated audio in tests — not just
  config wiring. Chinese routes through `KokoroMultilingualProcessor`'s ByT5
  neural G2P path (~1.2s cold start, ~20MB model, per the package's own
  README) — this must be confirmed to actually download/load and produce
  audio, not just assumed to work from the config shape.
- TS-side native adapter (`kokoro_tts_native.ts`, mirroring `music_native.ts`'s
  `ensureBinary()`/spawn pattern) + `registry.ts` entry + `bridge.ts` wiring.
- An **opt-in-only** selection mechanism (see Selector Impact below) so this
  new provider never becomes the default pick for a bare `{capability:"tts"}`
  request — it is only reachable via an explicit `provider:"kokoro"` hint or
  a matching `command`. `say`/`edge-tts`'s existing behavior is unchanged.

**Out of scope (deferred, not silently dropped):**
- Non-English/non-Chinese languages (Spanish, French, Italian, Portuguese,
  Hindi, Japanese) — Kokoro/mlx-audio-swift supports them, but they're not
  part of this repo's current narration use case. `edge-tts` already covers
  these if ever needed.
- Streaming generation (`model.generateStream`) — this port uses the
  synchronous one-shot `generate()` call only, matching the existing
  `edge_tts`/`say` call shape (one text in, one audio file out).
- `--rate` semantics: Python's `_parse_rate_to_speed` converts edge-tts's
  signed-percentage rate string into a Kokoro speed multiplier. This port
  exposes a plain `--speed` float directly (Kokoro's native parameter) rather
  than reimplementing the percentage-string convention — callers wanting
  edge-tts-style `+15%` input convert it themselves (1 line of arithmetic),
  documented in the CLI's `--help`.

## Design

### 1. Swift side — `swift/musicgen-director`

**`Package.swift` changes:**
- Add the `MLXAudioTTS` product to the existing `mlx-audio-swift` dependency
  (already pinned `exact: "0.1.3"` for `MLXAudioCodecs`). This transitively
  pulls in `mlx-swift-lm`, `swift-huggingface`, and `swift-transformers` —
  all declared by `mlx-audio-swift`'s own `Package.swift`, not something this
  repo needs to pin or vendor itself.
- Add a new product: `.executable(name: "kokoro-tts", targets: ["KokoroTTSCLI"])`.
  Same package, second CLI binary — mirrors how `ltx-video-director` hosts
  both its main LTX CLI and the Whisper transcribe path in one package rather
  than spinning up a dedicated package per model.

**New target `KokoroTTSCLI`** (`Sources/KokoroTTSCLI/`):
- One subcommand: `kokoro-tts generate --text <TEXT> --voice <VOICE> [--speed <FLOAT>] [--model-repo <ID>] --output <PATH>`.
- `--voice` required, no default — the TS caller always passes one explicitly
  (mirrors `musicgen generate`'s explicit `--prompt` requirement).
- `--model-repo` defaults to `mlx-community/Kokoro-82M-bf16`.
- `--speed` defaults to `1.0`.
- Implementation: `TTS.loadModel(modelRepo:)` → `model.generate(text:voice:)`
  → write the returned Float32 samples to a WAV file at `--output` (24kHz,
  per Kokoro's known output rate — confirmed against the package's own
  `KokoroConfig.swift` during implementation, not assumed).
- Exit codes: `0` on success with a non-empty file written, `1` on any
  failure (model load failure, generation failure, empty output) — mirrors
  `musicgen generate`'s and `tts_native.ts`'s "0-exit-but-nothing-written is
  NOT success" convention (enforced on the TS side by checking the file after
  the process exits, same as `music_native.ts`'s `runMusicNative`).

**Tests** (`Tests/`, alongside `MusicGenDirectorTests` — a new
`KokoroTTSCLITests` target or folded into the existing one, decided at
implementation time based on which keeps the test target boundaries clean):
- Real generation for an English voice (`af_heart` or `am_michael`) — assert
  non-empty output, correct sample rate, plausible duration for the input
  text length.
- Real generation for a Chinese voice (`zf_xiaobei` or `zm_yunjian`) — same
  assertions. This is the test that actually proves the ByT5 G2P path works,
  not just that the Swift compiles.

### 2. TS side — `bun-apps/pi-agent-ext-movie-director`

**New file `kokoro_tts_native.ts`** (mirrors `music_native.ts`):
```typescript
export interface KokoroTtsOptions {
  text: string;
  voice: string;
  speed?: number;
  modelRepo?: string;
}

export interface KokoroTtsDetails {
  ok: boolean;
  command: "kokoro-tts";
  exitCode: number;
  output: string | null;
  sizeBytes: number | null;
  voice: string | null;
  stdout: string;
}
```
- `buildKokoroTtsArgs(opts, output)` — argv builder (`generate --text ... --voice ... --output ...`, `--speed`/`--model-repo` only when explicitly set).
- `defaultSpawn` — `ensureBinary()` (reuse the existing `musicgen_binary.ts`
  helper, extended to also resolve/build `kokoro-tts` from the same package,
  OR a small sibling `kokoro_binary.ts` if `ensureBinary()`'s signature turns
  out to be MusicGen-specific — decided at implementation time by reading
  `musicgen_binary.ts` first) with `cwd: resolveRepoRoot()`.
- `runKokoroTtsNative(input)` — same ok-determination convention as
  `runMusicNative`: exit 0 AND output file exists with nonzero size.

**`registry.ts`** — new entry in the `tts` capability group:
```typescript
{
  name: "kokoro_tts",
  capability: "tts",
  provider: "kokoro",
  backend: "native_swift",
  invoke: "bun:kokoro-tts",
  configured: true,
  optIn: true,
  notes: "swift/musicgen-director's kokoro-tts binary — local Kokoro-82M TTS via mlx-audio-swift's MLXAudioTTS product (Models/StyleTTS2/Kokoro), no Python. Genuinely offline (unlike edge_tts) and higher quality than say_tts, but NOT the default: optIn:true keeps it out of selectProvider's bare backend-rank fallback (see selector.ts) — reachable only via an explicit provider:\"kokoro\" hint. English (af_*/am_*) and Mandarin (zf_*/zm_*) voices verified; other Kokoro-supported languages deferred to edge-tts. See docs/superpowers/specs/2026-08-01-kokoro-tts-swift-native-port-design.md.",
}
```

**`bridge.ts`** — new `realKokoroTtsNative`, mirroring `realMusicNative`:
```typescript
async function realKokoroTtsNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as KokoroTtsOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "tts_kokoro.wav");
  const { runKokoroTtsNative } = await import("./kokoro_tts_native.ts");
  const out = await runKokoroTtsNative({ options: opts, output });
  return adaptRunPyTts(req, { ...out.details, exitCode: out.details.ok ? 0 : 1, aborted: false, stdout: "" }, out.summary, out.stderrTail, env);
}
```
registered under `"bun:kokoro-tts"` in the `invoke` dispatch map, reusing
`adaptRunPyTts` (structurally compatible `Details` shape, same pattern
`realTtsNative`/`realMusicNative` already use to reuse an existing adapter).

### 3. Selector impact — `selector.ts`

**The load-bearing finding this design is built around:** `BACKEND_RANK`
(`native_swift`=0, `ffmpeg`=1, `macos_native`=2, `cloud_http`=3) ranks
*across* backend tiers, not just within one. `runpy_image`'s existing
"declared-after-the-real-native-providers, same tier, loses the tie" trick
(used to keep it out of `image_generation`'s default pick) **does not
transfer here** — `tts` currently has no other configured `native_swift`
entry, so a bare `backend:"native_swift", configured:true` Kokoro entry would
unconditionally win ties over `say`/`edge-tts` for any caller that doesn't
pass an explicit `provider` hint, changing today's default behavior for
every existing bare-`tts`-capability caller.

To keep this genuinely opt-in (the explicit design decision — see the
brainstorming conversation this spec was written from), `ProviderEntry` gets
a new optional field:

```typescript
/** When true, this entry is excluded from the backend-rank bare-fallback
 *  (selectProvider's final sort) — only reachable via an explicit `provider`
 *  hint or a `commands[]` match. Lets a genuinely-better native provider
 *  ship without silently becoming every existing bare caller's new default. */
optIn?: boolean;
```

`selectProvider`'s final fallback (today's line ~128-132) filters `optIn`
entries out of the candidate array before the `BACKEND_RANK` sort:

```typescript
return [...configured]
  .filter((p) => !p.optIn)
  .sort((a, b) => BACKEND_RANK[a.backend] - BACKEND_RANK[b.backend])[0]!;
```

If the filtered array is empty (all remaining configured candidates are
`optIn`), fall back to the unfiltered sort — an opt-in-only capability must
still be selectable by *something* when it's the only configured option, this
just isn't a case `tts` hits today (say/edge-tts are always configured).

The module's header comment (the numbered override-precedence list) gets a
new line documenting this as part of tier 3's definition — same discipline
the header already uses for the other three tiers.

**Explicit-hint and command-routing paths are unaffected** — `optIn:true`
only changes the bare-fallback behavior; `provider:"kokoro"` and any future
`commands[]` match still reach it exactly like any other entry.

### 4. Testing

- `kokoro_tts_native.test.ts` — argv-builder unit tests (injected fake spawn,
  no real binary needed), ok/failure determination tests (exit 0 + file
  exists+nonzero vs. exit 0 + missing file vs. nonzero exit).
- `selector.test.ts` — new cases: (a) a bare `{capability:"tts"}` call with no
  hint still returns today's pick (`say` or the edge-tts opportunistic
  upgrade, unchanged), even with the `kokoro_tts` entry present in the
  registry; (b) `{capability:"tts", provider:"kokoro"}` returns the
  `kokoro_tts` entry.
- `bridge.test.ts` (or wherever `realMusicNative`-style adapters are tested
  today) — `realKokoroTtsNative` wiring smoke test with an injected spawn.

## Out of scope (deferred, documented)

- Non-English/non-Chinese Kokoro languages (es/fr/it/pt/hi/ja) — `edge-tts`
  already covers these.
- Streaming (`generateStream`) — one-shot `generate()` only.
- `--rate` percentage-string compatibility — plain `--speed` float instead.
- Voice pre-warming (`KokoroMultilingualProcessor.prepare(for:)`) — first
  call per language pays the cold-start cost; no separate warm-up command in
  this port.
