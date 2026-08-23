# character_native.ts Cutout Wiring — Design

## Context

`character_native.ts` (`bun-apps/pi-agent-ext-movie-director/src/character_native.ts`) is a native
Bun port of `run.py image character`'s orchestration: Phase 1 generates a multi-view character
sheet (delegates to `profile_native.ts`), Phase 2 segments each view, Phase 3 builds
`IdentitySpec.json` (schema `character-lock.v1`).

When this module was written (2026-07-13), the only Swift-native segmentation primitive was
`flux2 segment` — a SAM3.1 bridge that produces a standalone grayscale **mask** PNG, not a true
alpha-composited transparent cutout (the compositing step needs an image-codec/pixel-buffer
library this package didn't have). So `views[].cutout` was hardcoded to `null` forever, with the
mask riding under an undocumented-in-Python extension field, `views[].mask`.

That gap has since closed: the 2026-07-31 `cutout` Swift-native port
(`docs/superpowers/specs/2026-07-31-cutout-swift-native-port-design.md`) shipped `flux2 cutout`,
which reuses the same SAM3 bridge but adds real MLX-tensor alpha compositing
(`ImageSave.savePNGRGBA`), producing an actual transparent RGBA PNG. That port's own registry
notes flagged wiring `character_native.ts` onto it as a deferred, not-yet-done follow-up — this
spec is that follow-up.

## Scope

**In scope:**
- Swap Phase 2's per-view call from `flux2 segment` to `flux2 cutout`.
- `views[].cutout` becomes the real thing: a path to a true alpha-composited PNG, or `null` when
  SAM3 found no detections for that view.
- Remove the now-obsolete `views[].mask` extension field and its supporting code/tests.
- Update `character_native.ts`'s module doc and `registry.ts`'s `character_native` entry notes to
  reflect the closed gap.

**Out of scope:**
- `--trim` (bbox-crop) — deliberately NOT passed. Character-sheet views must stay at the profile
  phase's fixed canvas size (width/height come from `runProfileNative`'s ratio preset) so a later
  `image storyboard --character <hero>` consumer can rely on consistent view dimensions. Trimming
  would produce a different size per view depending on how much of the frame the subject fills.
- `--save-mask` — NOT passed. With `mask` dropped (see below), there's no consumer for the debug
  mask/overlay PNGs `--save-mask` would produce; skipping it avoids two extra file writes per view
  for no benefit.
- `_fill_holes` interior-hole filling — already noted as a pre-existing deferred item in the
  Python-parity list (the SAM3 bridge's fixed feather-only behavior, unchanged by the 2026-07-31
  port); stays deferred.
- `--self-test` hero synthesis — already deferred (needs the MLX Python T2I pipeline); unaffected
  by this change.

## Design

### 1. Interface rename: `SegmentFn` → `CutoutFn`

`flux2 cutout` has different failure semantics than `flux2 segment`:

| | `flux2 segment` | `flux2 cutout` |
|---|---|---|
| Zero detections | exits 0, writes `<output>.json` sidecar with `count: 0` | `throw ExitCode(2)` (non-zero exit), no sidecar left behind (temp file cleaned via `defer`) |
| Metadata sidecar | always writes `<output>.json` (`count`, `best_score`, `best_box`) | none — reads its own temp sidecar internally, then deletes it |

The current `defaultSegment` reads `${maskPath}.json` after every call to distinguish "0 detections"
from "N detections" and surface `bestScore`. `flux2 cutout` gives no such file to read, so that
pattern doesn't carry over. The replacement is simpler: treat `runFlux2`'s own `details.ok` as the
sole signal — `true` means the output PNG exists and is a real cutout, `false` covers both actual
subprocess failures AND the zero-detections case (both already surface a diagnostic to stdout via
the Swift command itself, so nothing is silently lost — just not captured structurally in
`CutoutResult` anymore, since nothing downstream ever consumed `count`/`bestScore` beyond a
same-iteration null-check).

```typescript
export interface CutoutParams {
  image: string;
  prompt: string;
  threshold: number;
  outputDir?: string;
}
export interface CutoutResult {
  /** True alpha-composited cutout PNG path (null = no detection or a bridge failure). */
  cutoutPath: string | null;
}
export type CutoutFn = (params: CutoutParams) => Promise<CutoutResult>;
```

### 2. `cutoutPathFor` replaces `maskPathFor`

Naming now matches Python exactly (`image-character.py`'s own `_cutout_view` writes
`{stem}_cutout.png`) since the output really is a cutout:

```typescript
export function cutoutPathFor(imagePath: string): string {
  const dir = dirname(imagePath);
  const stem = basename(imagePath, extname(imagePath));
  return join(dir, `${stem}_cutout.png`);
}
```

### 3. `defaultCutout` replaces `defaultSegment`

```typescript
export const defaultCutout: CutoutFn = async (p) => {
  const outputPath = cutoutPathFor(p.image);
  const out = await runFlux2({
    command: "cutout",
    options: {
      input: p.image,
      subject: p.prompt,
      samThreshold: p.threshold,
      output: outputPath,
    },
    outputDir: p.outputDir,
  });
  if (!out.details.ok) {
    return { cutoutPath: null };
  }
  return { cutoutPath: outputPath };
};
```

No `--trim`, no `--save-mask` (see Out of Scope).

### 4. `ViewMeta` drops `mask`

```typescript
export interface ViewMeta {
  view: ProfileView;
  image: string | null;
  /** True alpha-composited cutout (null = no SAM3 detection for this view, or a bridge failure). */
  cutout: string | null;
}
```

### 5. `runCharacterNative` Phase 2 loop

```typescript
const subject = opts.cutoutSubject ?? DEFAULT_CUTOUT_SUBJECT;
const threshold = opts.samThreshold ?? DEFAULT_SAM_THRESHOLD;

const viewsMeta: ViewMeta[] = [];
let cutoutCount = 0;
for (const vo of viewOutputs) {
  const entry: ViewMeta = { view: vo.view, image: vo.path, cutout: null };
  if (vo.path) {
    const result = await cutoutFn({ image: vo.path, prompt: subject, threshold, outputDir: opts.outputDir });
    if (result.cutoutPath) {
      entry.cutout = result.cutoutPath;
      cutoutCount += 1;
    }
  }
  viewsMeta.push(entry);
}
```

`CharacterOptions._segmentImpl` (the test seam) is renamed `_cutoutImpl: CutoutFn`.

### 6. Module doc

The "PHASE 2 SCOPE NOTE" block (lines 17–59 of the current file) — the long explanation of why
`cutout` is always `null` — is replaced with a short paragraph: Phase 2 now calls flux2's native
`cutout` command (2026-07-31 port), producing a true alpha-composited transparent PNG per view;
the prior mask-only limitation and its extension field are gone. The "Other DEFERRED items" list
keeps the still-true entries (`_fill_holes`, `--self-test`, inherited `profile_native.ts` deferrals)
minus anything that referenced the now-removed compositing gap.

### 7. `registry.ts`

`character_native`'s notes currently contain a "REAL DELTA from the Python" paragraph describing
the mask-only limitation. Replace it with a short note: as of 2026-08-01, Phase 2 calls `flux2
cutout` instead of `flux2 segment`, closing that gap — `views[].cutout` now matches Python's
alpha-composited semantics. Cross-reference the cutout port's design doc.

## Testing

- `character_native.test.ts`: rename `maskPathFor` describe block to `cutoutPathFor` (assert
  `_cutout.png` suffix, not `_mask.png`); update the mocked-orchestration tests to use `CutoutFn`
  fixtures returning `{ cutoutPath }` instead of `{ maskPath, count, bestScore }`; update the
  "no detection" test to assert `cutout: null` with `mask` no longer present in the expected
  object; the "always sets cutout to null in v1" test is deleted outright (that's precisely the
  behavior this change reverses — replaced by a test asserting `cutout` IS populated when
  `cutoutFn` returns a path).
- `bun test` (`pi-agent-ext-movie-director`) must stay fully green.
- No new E2E comparison script needed — `compare_cutout_e2e.py` (2026-07-31) already validates
  `flux2 cutout` itself against the Python reference; this change is pure call-site wiring with no
  new pixel logic, so a unit-level mock test is sufficient (same level of coverage the current
  Phase-2 tests already use).

## Out of scope (explicitly, not silently dropped)

- Any change to Phase 1 (`profile_native.ts`) or Phase 3 (`buildIdentitySpec`) — untouched.
- `image storyboard --character <hero>`'s consumption of `IdentitySpec.json` — this spec only
  changes what `views[].cutout` contains, not how (or whether) any downstream consumer reads it;
  no downstream consumer currently exists in this repo to update.
