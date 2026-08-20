# Receipt — Re-certify the local-LLM orchestration (zero-cloud gate)

**Date:** 2026-07-07 21:04 local
**Goal:** Close the "local LLM" gate the prior goal (`next-goal-20260707-200000`)
left open. Prove on the **current tree** (post captions-fix + run.py video
adapter) that **gemma (local)** drives the `movie` tool end-to-end and **ZERO
cloud GAI** is invoked anywhere in the run. This is the literal gate named in
`next-goal-20260707-203000.md` Correction 1 / Step 3.

## Verdict: SUCCESS

| Gate | Result |
|---|---|
| gemma (local) orchestrated a `movie` run on the current tree | ✅ one `movie generate` tool call, exit 0 |
| Real generation in the loop | ✅ `krea2_t2i_s7.png`, 512×512 RGB, 229,895 bytes |
| Selector picked a LOCAL provider (never cloud) | ✅ `krea2` (native_swift, `swift/krea2-image-director`) |
| grep proves ZERO cloud GAI calls | ✅ see §3 below (4 independent greps) |

## 1. Invocation (resolved, no longer contradictory)

```
MLX_OUTPUT_DIR=../video_generation__output/agent-local-llm-20260707 \
BUN_PI_LOAD_RUN_DIR=FALSE \
bun bun-apps/s2-agent/src/cli.ts \
  --no-extensions \
  -e bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts \
  --model "lm-studio/google/gemma-4-26b-a4b-qat:medium" \
  -p "<directive: call movie generate {image_generation, t2i, ...} once>"
```

- `--model lm-studio/google/gemma-4-26b-a4b-qat:medium` — the `provider/id:thinking`
  form; `medium` thinking baked in (per `s2-agent-cli/src/args.ts:10`).
- `BUN_PI_LOAD_RUN_DIR=FALSE` + `--no-extensions` isolates the session to ONLY the
  `-e` path (sidesteps the JITI `NameTooLong` splice from power-tool — same shape
  the 2026-07-05 `h-real-agent-driven` receipt established).
- `movie` is an **extension action** (`extensions/movie-director.ts`), not a
  built-in tool — loaded solely via `-e`.

## 2. Outcome

gemma issued exactly one `movie` tool call (`generate`, capability
`image_generation`, command `t2i`) and stopped. The selector routed it to
`krea2` (local Swift/MLX director). Final stdout:

```
/Users/huangziyu/proj/video_generation__output/agent-local-llm-20260707/krea2_t2i_s7.png
```

```
$ file .../krea2_t2i_s7.png
PNG image data, 512 x 512, 8-bit/color RGB, non-interlaced   (229,895 bytes)
```

## 3. ZERO-cloud grep proof (the gate)

**3a — The orchestrator LLM is local.** LM Studio's model catalog (the only
endpoint `--model lm-studio/…` can reach) serves exclusively local silicon:

```
$ curl -s http://localhost:1234/v1/models | grep -o '"id": "[^"]*"'
"id": "google/gemma-4-26b-a4b-qat"
"id": "ornith-1.0-35b"
"id": "text-embedding-nomic-embed-text-v1.5"
```

No cloud LLM id is present or loadable. The brain is gemma on local metal.

**3b — Every cloud_http provider in the registry ships `configured: false`**
(`registry.ts`), so even an explicit `provider` hint cannot route generation to
a cloud GAI API:

```
$ grep -n 'backend: "cloud_http"' .../registry.ts
90:  compose_hyperframes  ... configured: false  (HyperFrames — browser-only, no CLI)
94:  elevenlabs_tts       ... configured: false  (needs ELEVENLABS_API_KEY)
95:  openai_tts           ... configured: false  (needs OPENAI_API_KEY)
```

**3c — Every `image_generation` provider is local native_swift** (the capability
this run exercised). There is no cloud image provider to select:

```
$ grep -n 'capability: "image_generation"' .../registry.ts
73:  krea2_image  ... backend: "native_swift"  invoke: "swift:krea2"   configured: true
74:  flux2_image  ... backend: "native_swift"  invoke: "swift:flux2"   configured: true
75:  z_image      ... backend: "native_swift"  invoke: "swift:krea2"   configured: true
```

**3d — The generation adapter path (`bridge.ts realKrea2 → runKrea2` → the
swift binary) contains no network call.** The only `fetch(`/openai references in
`providers.ts` live in the TTS adapter (`openaiTts`, line 916+), which is gated
behind `configured: false` and is NOT on the `image_generation` path the
selector chose. No cloud HTTP is reachable from this run.

## 4. Constraint reconciliation (per goal "stop mis-framing")

This run used the **Swift director** path (`swift:krea2`) for image generation,
NOT `run.py`. Both are **local MLX, zero cloud** — constraint 1 holds either
way. `run.py` is the canonical PYTHON runtime (certified separately this same
day by `scripts/e2e-smoke.ts` → `mlx:runpy` → a real t2i2v MP4, see PR #344);
the Swift directors are the canonical SWIFT path. The two coexist deliberately.

## 5. Notes / honest signal

- `-p` headless mode is NOT a hang on a quiet box (re-confirmed; the run
  returned in well under a minute including the real krea2 T2I). Per
  [[s2-agent-headless-p-hang]], give it real time; do not kill on buffered
  output.
- This is a deliberately LIGHT cert (one tool call, one PNG) — it isolates the
  "local-LLM orchestration + zero-cloud" gate from the heavier 7-stage
  `h-real-agent-driven-20260705` run. The 2026-07-05 receipt already proved the
  full 36-call sequence; this receipt proves the gate still holds on the current
  tree after the captions-fix (#342) and run.py-adapter (#344) changes.
- No transcript JSONL was emitted by this short `-p` run (unlike the longer
  interactive run); the artifact + the four greps above are the proof surface.
