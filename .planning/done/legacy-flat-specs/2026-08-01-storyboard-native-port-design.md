# storyboard Swift/Bun-native Port — Design

## Context

`image-storyboard.py` (`python/mlx-movie-director/app/commands/image-storyboard.py`, 730
lines) is `run.py image storyboard`'s entry point: story → scene list → per-shot generation →
contact-sheet storyboard. It is the last non-permanent Python-only command remaining in
`runpy_image`'s `commands[]` list — the other two, `purify` (SeedVR2 diffusion, confirmed
PyTorch/torch-MPS-only, see `project_attention_backends_mps`) and `multicouple` (genuine
latent-couple MLX/GPU compute), are documented as PERMANENTLY Python-only.

`story_native.ts`'s own module doc already flagged this gap explicitly (2026-07-13): "`story
shots` is NOT ported here... delegates the actual generation to `image storyboard`, which still
runs on run.py (no Swift equivalent yet, see runpy_image.ts)."

The command's own docstring states its generation "reuses the tested `execute_generation` core
(the same path t2i uses) — no new MLX generation code" — i.e. it is pure orchestration composing
primitives, all of which are now Swift-native:
- Recurring-character shots without `--kontext-lock`: soft character-lock (flux2-klein +
  reference image + partial denoise).
- Recurring-character shots with `--kontext-lock`: true in-context Kontext (shipped
  2026-07-29, `docs/superpowers/specs/2026-07-29-kontext-swift-native-port-design.md`).
- Independent shots: plain Z-Image T2I.

Two supporting modules hold the deterministic (non-generation) logic:
- `app/planning/scene_spec.py` (151 lines) — pure dataclasses (`SceneSpec`, `ShotLanguage`) +
  `plan_storyboard()`, a deterministic scene→shot mapper. No I/O.
- `app/planning/shot_prompt_builder.py` (188 lines) — pure string composition: assembles the
  5-layer (Subject/Motion/Scene/Framing/Camera) shot prompt from a `SceneSpec`.
- `app/planning/gemma_brain.py` (162 lines) — `decompose_story()`, a plain LM Studio HTTP call
  (prompt template + tolerant JSON parse), no MLX compute. Same shape as `story_angles.py`, which
  `story_native.ts` already ported.

## Scope

**In scope (the core generation line):**
- `--story` (gemma decomposition via LM Studio HTTP) / `--scenes` (JSON file) / no-input
  (deterministic 3-beat fixture) scene sourcing — same three-way fallback as Python.
- Scene → shot planning (`scene_spec.py` + `shot_prompt_builder.py`, ported 1:1, pure logic).
- Per-shot generation routing: independent / locked / kontext, calling the already-native
  `krea2_image` t2i / `flux2_image` edit / `flux2_image` kontext commands respectively.
- Contact sheet assembly via ffmpeg's `tile` filter (no new image-codec dependency).
- `storyboard.json` manifest output, matching the Python payload shape closely enough for any
  future consumer to read either interchangeably (see Design §6).
- `registry.ts`: new `storyboard_native` entry; `storyboard` removed from `runpy_image`'s
  `commands[]`.

**Out of scope (deferred, documented — not silently dropped):**
- `--judge` closed loop: `run.py caption --style score` per frame, VLM identity verification
  (`_vlm_verify_identity`), and weak-identity auto-regeneration. This needs its own VLM
  multi-image JSON parsing discipline (hardened separately in the Python for a #366 flakiness
  fix) and is a distinct, sizeable chunk of work — left on the `runpy_image` fallback path, the
  same treatment `workflow_hybrid` gives its face-detail/post-process stages.
- Kontext batch-loading optimization: the Python defers all kontext-lock shots in an arc into
  ONE `Flux1Kontext` load (the ~31GB load is the expensive part). The Swift `flux2 kontext` CLI
  has no multi-prompt-per-invocation mode — each `runFlux2` call is a fresh subprocess, so this
  port calls `kontext` once per shot (N loads instead of 1). This is a **performance** delta, not
  a functional one; batching would require new Swift CLI surface and is deferred.
- The soft character-lock's `denoise_strength=0.85` partial-redraw knob: `flux2 edit` has no
  SDEdit-style denoise-strength field (verified against `commands.ts` — `edit` only takes
  `GEN_FIELDS_NO_STRICT_GATE`, no `denoiseStrength`). This port uses `edit` with the hero as the
  sole reference (pure multi-ref conditioning, same identity-lock mechanism `profile_native.ts`/
  `character_native.ts` already rely on) and documents the missing partial-denoise knob as a
  known delta — same treatment `twosubject_native.ts` gives its own missing `cfg-scale` forward.
- `--decompose-model` / `--identity-judge-model` fine-tuning knobs — irrelevant without the judge
  loop; deferred alongside it.

## Design

### 1. New module: `storyboard_native.ts`

Same shape as `character_native.ts` / `twosubject_native.ts` / `story_native.ts`: a pure Bun
orchestration module with no MLX/Python dependency, calling `lmstudio.ts` for decomposition and
the already-native `krea2`/`flux2` bridges for generation.

```typescript
export interface ShotLanguage {
  lensMm?: number;
  depthOfField?: string;
  shotSize?: string;
  cameraMovement?: string;
  lightingKey?: string;
  colorTemperature?: string;
}

export interface SceneSpec {
  id: string;
  subject: string;
  scene: string;
  motion?: string;
  framing?: string;
  shotLanguage?: ShotLanguage;
  textureKeywords?: string[];
  characterId?: string | null;
  heroMoment?: boolean;
  type?: string;
}

export interface Shot {
  sceneId: string;
  characterId: string | null;
  heroMoment: boolean;
  prompt: string;
}

export interface Storyboard {
  shots: Shot[];
  recurringCharacters: string[];
}
```

### 2. Scene sourcing (`_load_scenes` equivalent)

```typescript
export async function loadScenes(opts: {
  scenes?: string;       // path to JSON file
  story?: string;        // free-form story text
  numPanels?: number;
  styleHint?: string;
  decomposeModel?: string;
}): Promise<SceneSpec[]> {
  if (opts.scenes) {
    const raw = JSON.parse(await Bun.file(opts.scenes).text());
    if (!Array.isArray(raw)) throw new Error(`--scenes JSON must be a list, got ${typeof raw}`);
    return raw.map(sceneFromDict);
  }
  if (opts.story) {
    try {
      const scenes = await decomposeStory(opts.story, {
        numPanels: opts.numPanels ?? 4,
        styleHint: opts.styleHint,
        model: opts.decomposeModel,
      });
      if (scenes.length) return scenes;
    } catch {
      // fall through to the deterministic fixture, same as Python
    }
  }
  return deterministicFixture();
}
```

`decomposeStory` is a 1:1 port of `gemma_brain.py`'s `decompose_story()`: build the
Story2Board-shaped prompt, call `lmStudioJsonCall` (the same primitive `story_native.ts` uses),
tolerant-parse the response (strip `<think>` blocks + ```json fences, find the first `[ … ]` —
the exact discipline `story_native.ts`'s module doc already documents and follows). Ported into
`storyboard_native.ts` directly (not shared with `story_native.ts` — the two decompositions
produce different JSON shapes: story angles vs. `SceneSpec[]`).

`deterministicFixture()` is a byte-for-byte port of Python's `_deterministic_fixture()` (the
3-beat detective-noir storyboard).

### 3. Scene → shot planning (`plan_storyboard` + `build_shot_prompt` equivalents)

Ported 1:1 from `scene_spec.py`'s `plan_storyboard()` (deterministic: builds `Shot[]` from
`SceneSpec[]`, computes `recurringCharacters` as any `characterId` appearing on 2+ scenes) and
`shot_prompt_builder.py`'s `build_shot_prompt()` (pure string assembly: Subject + Motion + Scene
+ Framing/Camera layers + texture keywords + style hint, in the same layer order as the Python).
Both are pure functions — no I/O, no MLX — ported line-for-line, not reinterpreted.

### 4. Shot routing + generation

```typescript
export type ShotRoute = "kontext" | "locked" | "independent";

export function shotRoute(shot: Shot, recurringIds: Set<string>, kontextLock: boolean): ShotRoute {
  if (shot.characterId != null && recurringIds.has(shot.characterId)) {
    return kontextLock ? "kontext" : "locked";
  }
  return "independent";
}
```

Generation per route (via the existing `krea2`/`flux2` bridge functions — no new subprocess
plumbing, same pattern `character_native.ts` uses for `cutoutFn`):

- `independent` → `krea2_image` `t2i` (`{ prompt: shot.prompt, seed, width, height, steps }`).
- `locked` → `flux2_image` `edit` (`{ prompt: shot.prompt, images: [hero], seed, width, height,
  steps }`) — hero as the sole reference, pure multi-ref conditioning (no denoise-strength knob;
  see Scope).
- `kontext` → `flux2_image` `kontext` (`{ input: hero, prompt: shot.prompt, seed, width, height,
  steps }`) — one call per shot (no batching; see Scope).

`seed` is locked across the whole arc at `777` by default (matching Python's `RunConfig` default),
overridable via an option. `width`/`height`/`steps` default to `640`/`960`/`9` (matching Python's
`_build_run_config` defaults for the non-kontext path); `kontext` shots default to `1024`/`1024`
plus `kontext`'s own step/guidance defaults, matching the Python's `_kontext_batch` defaults.

### 5. Contact sheet

```typescript
export async function buildContactSheet(imagePaths: string[], outPath: string, cols = 3): Promise<void> {
  // ffmpeg: scale each input to a common width, tile into a `cols`-wide grid.
  // Reuses the ffmpeg-shell pattern already established in compose_motion.ts —
  // no new image-codec/pixel-buffer dependency for this package.
}
```

Implementation shells `ffmpeg` with per-input `scale=480:-1` + a `tile=${cols}x${rows}` filter
graph (rows computed the same way Python's `_build_contact_sheet` does:
`ceil(n / cols)`), writing one PNG. Exact filter-graph construction is an implementation detail
for the plan, not fixed here — the constraint is "ffmpeg only, no PIL-equivalent dependency."

### 6. `runStoryboardNative` — the entry point

```typescript
export interface StoryboardOptions {
  scenes?: string;
  story?: string;
  numPanels?: number;
  styleHint?: string;
  character?: string;       // hero image path
  kontextLock?: boolean;
  seed?: number;
  outputDir?: string;
  // test seams, same pattern as character_native.ts's _cutoutImpl:
  _decomposeImpl?: typeof decomposeStory;
  _t2iImpl?: (params: { prompt: string; seed: number; width: number; height: number; steps: number }) => Promise<{ path: string | null }>;
  _editImpl?: (params: { prompt: string; images: string[]; seed: number; width: number; height: number; steps: number }) => Promise<{ path: string | null }>;
  _kontextImpl?: (params: { input: string; prompt: string; seed: number; width: number; height: number; steps: number }) => Promise<{ path: string | null }>;
}

export interface StoryboardResult {
  outDir: string;
  storyboardJson: string;
  contactSheet: string;
  hero: string | null;
  kontextLock: boolean;
  recurringCharacters: string[];
  frames: Array<{
    sceneId: string;
    characterId: string | null;
    heroMoment: boolean;
    characterLocked: boolean;
    kontextLocked: boolean;
    prompt: string;
    image: string | null;   // null when generation failed for that shot
  }>;
}
```

Orchestration: `loadScenes` → `planStoryboard` → for each shot, route + generate (sequential, one
subprocess call at a time — no new concurrency model introduced) → `buildContactSheet` → write
`storyboard.json` (same field names as the Python payload, minus the judge-only fields
`identity`/`identity_weak`/`caption`/etc. which don't exist without `--judge`) → return
`StoryboardResult`.

A shot whose generation call fails (`path: null` from the impl) does **not** abort the whole run
— the frame's `image` is recorded as `null` and orchestration continues, matching the resilience
`character_native.ts`'s Phase 2 loop already established for per-view cutout failures. (Python's
`_gen` raises `RuntimeError` on a missing frame, hard-failing the whole storyboard — this is a
deliberate deviation, documented in the module doc, matching this package's established
graceful-degradation convention rather than the Python's fail-fast one.)

### 7. `registry.ts`

New entry:

```typescript
{
  name: "storyboard_native",
  capability: "image_generation",
  provider: "storyboard-native",
  backend: "native_swift",
  invoke: "bun:storyboard-native",
  configured: true,
  commands: ["storyboard"],
  notes: "Direct Bun implementation (src/storyboard_native.ts) of image-storyboard.py's core generation line: scene decomposition (LM Studio HTTP, same gemma-brain pattern as story_native.ts) → scene_spec/shot_prompt_builder planning (ported 1:1, pure logic) → per-shot routing onto krea2 t2i (independent) / flux2 edit (locked, hero as sole multi-ref — no denoise-strength knob, a documented delta from Python's SDEdit soft-lock) / flux2 kontext (kontext-lock, one call per shot — no batched single-model-load like Python's arc-level Kontext batching) → ffmpeg-tiled contact sheet. Deferred to runpy_image (documented, not silently dropped): the --judge closed loop (caption score + VLM identity verification + weak-frame regeneration), see docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md.",
}
```

`runpy_image`'s `commands[]` drops `"storyboard"`, leaving `["purify", "multicouple"]`. Both
entries' notes get the same treatment prior ports used: a short "moved off this adapter" sentence
on `runpy_image`'s notes, cross-referencing this spec; a fuller explanation on the new entry's
notes covering the routing mechanism, the `edit`-vs-denoise-strength delta, the no-batching delta,
and the deferred `--judge` loop.

## Testing

- `storyboard_native.test.ts`: unit tests for `shotRoute` (all 3 branches × recurring/non-recurring
  × kontextLock on/off), `planStoryboard`'s `recurringCharacters` computation, `buildShotPrompt`'s
  layer assembly, `loadScenes`'s three-way fallback (mocked `decomposeStory`), and
  `runStoryboardNative`'s orchestration with mocked `_t2iImpl`/`_editImpl`/`_kontextImpl` — same
  mock-seam pattern `character_native.test.ts` already uses for `_cutoutImpl`.
- `bun test` (`pi-agent-ext-movie-director`) must stay fully green.
- No new Python-vs-Swift numerical comparison script needed — this port has zero new pixel/tensor
  logic (pure orchestration over already-verified primitives: `krea2` t2i, `flux2` edit/kontext,
  each independently numerically verified by their own prior ports).

## Out of scope (explicitly, not silently dropped)

- `--judge` closed loop (caption score + identity verification + weak-frame regeneration) — see
  Scope above.
- Kontext batch-loading (one model load per arc) — see Scope above.
- `denoise_strength` on the soft character-lock — see Scope above.
- Any change to `character_native.ts`, `profile_native.ts`, `twosubject_native.ts`, or the
  `flux2`/`krea2` Swift directors themselves — this spec only adds a new orchestration module and
  a registry entry.
