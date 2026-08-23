# character_native.ts Cutout Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap `character_native.ts`'s Phase 2 (per-view segmentation) from calling `flux2 segment` (mask-only) to `flux2 cutout` (real alpha-composited transparent PNG), so `IdentitySpec.json`'s `views[].cutout` field is finally populated instead of hardcoded `null`.

**Architecture:** `flux2 cutout` (shipped 2026-07-31) already does everything Phase 2 needs — SAM3 text segmentation + MLX-tensor alpha compositing — via a single CLI call. This plan replaces the `SegmentFn`/`SegmentResult`/`defaultSegment`/`maskPathFor` machinery in `character_native.ts` with `CutoutFn`/`CutoutResult`/`defaultCutout`/`cutoutPathFor`, removes the now-obsolete `ViewMeta.mask` extension field, and updates the two doc blocks (`character_native.ts`'s module doc, `registry.ts`'s `character_native`/`flux2_image` notes) that described the old limitation.

**Tech Stack:** TypeScript, Bun test, `@repo/pi-agent-ext-flux2`'s `runFlux2` bridge (no new dependencies).

---

### Task 1: Rename `maskPathFor` → `cutoutPathFor`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/character_native.ts:96-101`
- Test: `bun-apps/pi-agent-ext-movie-director/src/character_native.test.ts:16-24`

This is a pure rename + suffix change (`_mask.png` → `_cutout.png`, matching Python's `image-character.py` `_cutout_view` naming now that the Swift side produces a real cutout). Do this rename first, in isolation, before the larger interface changes in Task 2 — keeps the diff for each task reviewable independently.

- [ ] **Step 1: Update the test to expect `cutoutPathFor` / `_cutout.png`**

In `bun-apps/pi-agent-ext-movie-director/src/character_native.test.ts`, replace the `maskPathFor` import and its describe block:

```typescript
import {
  DEFAULT_CUTOUT_SUBJECT,
  DEFAULT_SAM_THRESHOLD,
  cutoutPathFor,
  buildIdentitySpec,
  runCharacterNative,
  writeIdentitySpec,
  type SegmentFn,
} from "./character_native.ts";
```

```typescript
describe("cutoutPathFor — cutout output naming", () => {
  it("appends _cutout before the extension", () => {
    expect(cutoutPathFor("/out/front.png")).toBe("/out/front_cutout.png");
  });

  it("handles nested dirs; output is always .png regardless of source extension (cutout always writes PNG)", () => {
    expect(cutoutPathFor("/a/b/c/right.jpg")).toBe("/a/b/c/right_cutout.png");
  });
});
```

(The `type SegmentFn` import stays for now — Task 2 removes it. `buildIdentitySpec`'s own tests, further down the file, still reference the `mask` field on a `views` fixture; Task 2 updates those too. Leaving both here in Task 1 is intentional — this step touches ONLY the naming tests.)

- [ ] **Step 2: Run the test file to confirm the naming test fails**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/character_native.test.ts -t "cutoutPathFor"`
Expected: FAIL — `cutoutPathFor is not a function` (or similar; the export doesn't exist yet).

- [ ] **Step 3: Rename the function in the implementation**

In `bun-apps/pi-agent-ext-movie-director/src/character_native.ts`, replace:

```typescript
/** Build the mask output path for one view image (mirrors Python's `{stem}_cutout.png` naming, but named `_mask.png` since v1 only produces the intermediate mask — see module doc). */
export function maskPathFor(imagePath: string): string {
  const dir = dirname(imagePath);
  const stem = basename(imagePath, extname(imagePath));
  return join(dir, `${stem}_mask.png`);
}
```

with:

```typescript
/** Build the cutout output path for one view image (mirrors Python's `{stem}_cutout.png` naming — see module doc). */
export function cutoutPathFor(imagePath: string): string {
  const dir = dirname(imagePath);
  const stem = basename(imagePath, extname(imagePath));
  return join(dir, `${stem}_cutout.png`);
}
```

- [ ] **Step 4: Run the naming test to confirm it passes**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/character_native.test.ts -t "cutoutPathFor"`
Expected: PASS (2 tests).

Note: the FULL test file will NOT pass yet — `defaultSegment` still calls the now-deleted `maskPathFor` internally, which is a compile error. That's expected; Task 2 fixes it. Don't run the full suite until Task 2 is complete.

- [ ] **Step 5: Fix the one remaining internal caller so the file at least compiles**

In `character_native.ts`, inside `defaultSegment` (around line 111), change the one call site:

```typescript
      output: maskPathFor(p.image),
```
to:
```typescript
      output: cutoutPathFor(p.image),
```

and the line right after it:
```typescript
  const maskPath = maskPathFor(p.image);
```
to:
```typescript
  const maskPath = cutoutPathFor(p.image);
```

- [ ] **Step 6: Run typecheck to confirm the file compiles**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun run typecheck 2>&1 | grep character_native || echo "no errors in character_native.ts"`
Expected: `no errors in character_native.ts`

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/character_native.ts bun-apps/pi-agent-ext-movie-director/src/character_native.test.ts
git commit -m "refactor(character-native): rename maskPathFor to cutoutPathFor"
```

---

### Task 2: Replace `SegmentFn`/`defaultSegment` with `CutoutFn`/`defaultCutout`, drop `ViewMeta.mask`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/character_native.ts` (full interface + orchestration rewrite)
- Test: `bun-apps/pi-agent-ext-movie-director/src/character_native.test.ts` (full rewrite of the mocked-orchestration tests)

This is the core behavior change. `flux2 cutout` has different failure semantics than `flux2 segment` (see spec §1: `cutout` exits non-zero on zero detections and leaves no metadata sidecar, unlike `segment`), so the whole `SegmentFn` contract — not just its name — changes shape.

- [ ] **Step 1: Rewrite the orchestration tests first (TDD — these will fail against the current implementation)**

In `bun-apps/pi-agent-ext-movie-director/src/character_native.test.ts`, replace the entire file's imports and the `runCharacterNative` describe block. Full replacement content for the file:

```typescript
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CUTOUT_SUBJECT,
  DEFAULT_SAM_THRESHOLD,
  cutoutPathFor,
  buildIdentitySpec,
  runCharacterNative,
  writeIdentitySpec,
  type CutoutFn,
} from "./character_native.ts";
import type { ProfileResult } from "./profile_native.ts";

describe("cutoutPathFor — cutout output naming", () => {
  it("appends _cutout before the extension", () => {
    expect(cutoutPathFor("/out/front.png")).toBe("/out/front_cutout.png");
  });

  it("handles nested dirs; output is always .png regardless of source extension (cutout always writes PNG)", () => {
    expect(cutoutPathFor("/a/b/c/right.jpg")).toBe("/a/b/c/right_cutout.png");
  });
});

describe("buildIdentitySpec — pure IdentitySpec.json builder", () => {
  it("emits schema character-lock.v1 with defaults", () => {
    const spec = buildIdentitySpec("/hero.png", 42, {}, []);
    expect(spec.schema).toBe("character-lock.v1");
    expect(spec.hero).toBe("/hero.png");
    expect(spec.lock).toEqual({
      pipeline: "flux2-klein",
      seed: 42,
      refCount: 3,
      refStrength: 0.8,
      styleAnchor: "",
    });
    expect(spec.shots).toEqual([]);
    expect(spec.views).toEqual([]);
  });

  it("normalizes pipeline 'auto' to 'flux2-klein' (mirrors Python)", () => {
    const spec = buildIdentitySpec("/hero.png", 1, { pipeline: "auto" }, []);
    expect(spec.lock.pipeline).toBe("flux2-klein");
  });

  it("carries loraPath/loraScale only when loraPath is set", () => {
    const withoutLora = buildIdentitySpec("/hero.png", 1, {}, []);
    expect(withoutLora.lock.loraPath).toBeUndefined();

    const withLora = buildIdentitySpec("/hero.png", 1, { loraPath: "/lora.safetensors" }, []);
    expect(withLora.lock.loraPath).toBe("/lora.safetensors");
    expect(withLora.lock.loraScale).toBe(1.0);

    const withLoraScale = buildIdentitySpec("/hero.png", 1, { loraPath: "/lora.safetensors", loraScale: 0.5 }, []);
    expect(withLoraScale.lock.loraScale).toBe(0.5);
  });

  it("carries cfgScale only when explicitly set", () => {
    const without = buildIdentitySpec("/hero.png", 1, {}, []);
    expect(without.lock.cfgScale).toBeUndefined();
    const withCfg = buildIdentitySpec("/hero.png", 1, { cfgScale: 5.0 }, []);
    expect(withCfg.lock.cfgScale).toBe(5.0);
  });

  it("trims styleAnchor", () => {
    const spec = buildIdentitySpec("/hero.png", 1, { styleAnchor: "  soft anime shading  " }, []);
    expect(spec.lock.styleAnchor).toBe("soft anime shading");
  });

  it("carries views[] through unchanged (extension field)", () => {
    const views = [{ view: "front" as const, image: "/f.png", cutout: "/f_cutout.png" }];
    const spec = buildIdentitySpec("/hero.png", 1, {}, views);
    expect(spec.views).toEqual(views);
  });
});

function fakeProfile(views: ("front" | "back" | "side")[]): ProfileResult {
  return {
    views: views.map((v) => ({ view: v, angle: v, path: `/out/${v}.png`, seed: 123, width: 896, height: 1792 })),
    seed: 123,
    width: 896,
    height: 1792,
  };
}

describe("runCharacterNative — the core orchestration (mocked profile + cutout)", () => {
  it("throws when --input is missing", async () => {
    await expect(runCharacterNative({ input: "" })).rejects.toThrow(/--input .* is required/);
  });

  it("runs profile phase then cutout phase per view, assembling views[] with real cutout paths", async () => {
    const cutoutCalls: { image: string; prompt: string; threshold: number }[] = [];
    const cutoutImpl: CutoutFn = async (p) => {
      cutoutCalls.push({ image: p.image, prompt: p.prompt, threshold: p.threshold });
      return { cutoutPath: `${p.image}.cutout.png` };
    };
    const runProfile = async () => fakeProfile(["front", "side", "back"]);

    const result = await runCharacterNative({
      input: "/hero.png",
      _runProfile: runProfile,
      _cutoutImpl: cutoutImpl,
    });

    expect(cutoutCalls).toHaveLength(3);
    expect(cutoutCalls.every((c) => c.prompt === DEFAULT_CUTOUT_SUBJECT)).toBe(true);
    expect(cutoutCalls.every((c) => c.threshold === DEFAULT_SAM_THRESHOLD)).toBe(true);

    expect(result.cutouts).toBe(3);
    expect(result.identitySpec.views).toEqual([
      { view: "front", image: "/out/front.png", cutout: "/out/front.png.cutout.png" },
      { view: "side", image: "/out/side.png", cutout: "/out/side.png.cutout.png" },
      { view: "back", image: "/out/back.png", cutout: "/out/back.png.cutout.png" },
    ]);
    expect(result.identitySpec.hero).toBe("/hero.png");
    expect(result.identitySpec.lock.seed).toBe(123);
  });

  it("leaves cutout null for a view with no detection (mirrors Python's None)", async () => {
    const cutoutImpl: CutoutFn = async () => ({ cutoutPath: null });
    const runProfile = async () => fakeProfile(["front"]);

    const result = await runCharacterNative({ input: "/hero.png", _runProfile: runProfile, _cutoutImpl: cutoutImpl });

    expect(result.cutouts).toBe(0);
    expect(result.identitySpec.views[0]).toEqual({ view: "front", image: "/out/front.png", cutout: null });
  });

  it("populates views[].cutout with a real path when cutoutFn succeeds (the gap this plan closes)", async () => {
    const cutoutImpl: CutoutFn = async () => ({ cutoutPath: "/out/front_cutout.png" });
    const runProfile = async () => fakeProfile(["front"]);

    const result = await runCharacterNative({ input: "/hero.png", _runProfile: runProfile, _cutoutImpl: cutoutImpl });

    expect(result.identitySpec.views[0]?.cutout).toBe("/out/front_cutout.png");
  });

  it("propagates a profile-phase failure (no partial-success mode)", async () => {
    const runProfile = async () => {
      throw new Error("profile: flux2 angle failed");
    };
    await expect(
      runCharacterNative({ input: "/hero.png", _runProfile: runProfile }),
    ).rejects.toThrow(/flux2 angle failed/);
  });

  it("forwards lock params (styleAnchor/refCount/etc) into the IdentitySpec", async () => {
    const cutoutImpl: CutoutFn = async () => ({ cutoutPath: null });
    const runProfile = async () => fakeProfile(["front"]);

    const result = await runCharacterNative({
      input: "/hero.png",
      styleAnchor: "blue palette",
      refCount: 2,
      _runProfile: runProfile,
      _cutoutImpl: cutoutImpl,
    });

    expect(result.identitySpec.lock.styleAnchor).toBe("blue palette");
    expect(result.identitySpec.lock.refCount).toBe(2);
  });
});

describe("writeIdentitySpec — disk write", () => {
  it("writes IdentitySpec.json with trailing newline (mirrors Python's json.dump + f.write('\\n'))", async () => {
    const dir = await mkdtemp(join(tmpdir(), "character-native-"));
    try {
      const spec = buildIdentitySpec("/hero.png", 1, {}, []);
      const path = await writeIdentitySpec(dir, spec);
      expect(path).toBe(join(dir, "IdentitySpec.json"));
      const raw = await readFile(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual(spec);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test file to confirm it fails to compile/run**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/character_native.test.ts`
Expected: FAIL — `CutoutFn` is not exported, `_cutoutImpl` is not a known option on `CharacterOptions`.

- [ ] **Step 3: Rewrite the implementation's Phase 2 section**

In `bun-apps/pi-agent-ext-movie-director/src/character_native.ts`, replace the entire block from the `// ── Phase 2: per-view segmentation (the "cutout" step) ─────────────────────` comment through the end of `defaultSegment` (this spans the `SegmentParams`/`SegmentResult`/`SegmentFn` interfaces, `cutoutPathFor` — already renamed in Task 1 — and `defaultSegment`):

```typescript
// ── Phase 2: per-view cutout (SAM3 segmentation + alpha compositing) ───────

export interface CutoutParams {
  image: string;
  prompt: string;
  threshold: number;
  outputDir?: string;
}
export interface CutoutResult {
  /**
   * True alpha-composited cutout PNG path. `null` covers both "no SAM3
   * detection for this view" and an actual bridge/subprocess failure —
   * `flux2 cutout` exits non-zero for both and leaves no metadata sidecar
   * to distinguish them (unlike `flux2 segment`'s always-0-exit + sidecar
   * JSON), so v1 doesn't try to distinguish either; the view is simply
   * skipped either way, mirroring the prior segment-based behavior of
   * silently continuing without a cutout for that view.
   */
  cutoutPath: string | null;
}
export type CutoutFn = (params: CutoutParams) => Promise<CutoutResult>;

/** Build the cutout output path for one view image (mirrors Python's `{stem}_cutout.png` naming — see module doc). */
export function cutoutPathFor(imagePath: string): string {
  const dir = dirname(imagePath);
  const stem = basename(imagePath, extname(imagePath));
  return join(dir, `${stem}_cutout.png`);
}

/** Default cutout call: native flux2 `cutout` command (SAM3.1 bridge + MLX alpha compositing). No `--trim` (character-sheet views must stay at the profile phase's fixed canvas size) and no `--save-mask` (nothing consumes the debug mask/overlay PNGs it would produce). */
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

- [ ] **Step 4: Update `ViewMeta` to drop `mask`**

Replace:

```typescript
export interface ViewMeta {
  view: ProfileView;
  image: string | null;
  /** Transparent alpha-composited cutout. Always null in v1 — see module doc. */
  cutout: string | null;
  /** EXTENSION field (not in the Python schema): the intermediate SAM3 mask PNG, when produced. */
  mask?: string | null;
}
```

with:

```typescript
export interface ViewMeta {
  view: ProfileView;
  image: string | null;
  /** True alpha-composited cutout PNG path (null = no SAM3 detection for this view, or a bridge failure). */
  cutout: string | null;
}
```

- [ ] **Step 5: Update `CharacterOptions`'s test seam field**

Replace:

```typescript
  /** Test seam: inject a canned segment call so unit tests don't need flux2's `segment`. */
  _segmentImpl?: SegmentFn;
```

with:

```typescript
  /** Test seam: inject a canned cutout call so unit tests don't need flux2's `cutout`. */
  _cutoutImpl?: CutoutFn;
```

- [ ] **Step 6: Update `runCharacterNative`'s Phase 2 loop**

Replace:

```typescript
  const runProfile = opts._runProfile ?? runProfileNative;
  const segmentFn = opts._segmentImpl ?? defaultSegment;
```

with:

```typescript
  const runProfile = opts._runProfile ?? runProfileNative;
  const cutoutFn = opts._cutoutImpl ?? defaultCutout;
```

And replace the Phase 2 comment + loop body:

```typescript
  // Phase 2: per-view SAM3 mask (the intermediate step for the deferred
  // full alpha-cutout — see module doc).
  const subject = opts.cutoutSubject ?? DEFAULT_CUTOUT_SUBJECT;
  const threshold = opts.samThreshold ?? DEFAULT_SAM_THRESHOLD;

  const viewsMeta: ViewMeta[] = [];
  let cutoutCount = 0;
  for (const vo of viewOutputs) {
    const entry: ViewMeta = { view: vo.view, image: vo.path, cutout: null };
    if (vo.path) {
      const seg = await segmentFn({ image: vo.path, prompt: subject, threshold, outputDir: opts.outputDir });
      if (seg.maskPath) {
        entry.mask = seg.maskPath;
        cutoutCount += 1;
      }
    }
    viewsMeta.push(entry);
  }
```

with:

```typescript
  // Phase 2: per-view cutout (SAM3 segmentation + MLX alpha compositing,
  // via flux2's native `cutout` command).
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

- [ ] **Step 7: Rewrite the module doc header**

Replace the module doc comment (lines 1–60, from `/**` through the closing `*/` right before the `import` statements) with:

```typescript
/**
 * character_native.ts — native Bun port of `run.py image character`'s
 * orchestration (`app/commands/image-character.py`, 324 lines).
 *
 * image-character.py's own header/comments say it plainly: this command is
 * "PURE ORCHESTRATION" composing two already-certified primitives —
 *   1. `image profile` multi-view (front/side/back) generation, and
 *   2. Step-1 `cutout` (SAM3 segment → feather → alpha-composited PNG) per
 *      view,
 * then writes a persistent `IdentitySpec.json` (schema `character-lock.v1`)
 * so a later `image storyboard --character <hero>` can reuse the same
 * identity. Zero new MLX/generation code — this module mirrors that shape in
 * Bun: it calls `runProfileNative` (already ported, profile_native.ts) for
 * Phase 1, then flux2's native `cutout` command (Swift-native SAM3.1 bridge +
 * MLX alpha compositing, `swift/flux2-image-director/Sources/
 * Flux2DirectorCLI/CutoutCommand.swift`) per view for Phase 2, then
 * assembles + writes the IdentitySpec.json.
 *
 * PHASE 2 HISTORY: until 2026-08-01, this module called flux2's `segment`
 * command instead, which only produces an intermediate grayscale MASK PNG
 * (no alpha compositing — this package had no image-codec/pixel-buffer
 * library to do the PIL-equivalent compositing Python's `alpha_cutout` does).
 * `views[].cutout` was therefore hardcoded `null` forever, with the mask
 * riding under an undocumented extension field, `views[].mask`. The
 * 2026-07-31 `cutout` Swift-native port
 * (docs/superpowers/specs/2026-07-31-cutout-swift-native-port-design.md)
 * closed that gap by shipping `flux2 cutout` (SAM3 bridge unchanged, new
 * `ImageSave.savePNGRGBA` MLX-tensor compositing); this module was updated
 * (docs/superpowers/specs/2026-08-01-character-native-cutout-wiring-design.md)
 * to call it instead. `views[].mask` is gone — `views[].cutout` now carries
 * the real alpha-composited path, or `null` when SAM3 found no detection for
 * that view (or the bridge itself failed).
 *
 * Other DEFERRED items (documented, not silently dropped):
 *   - `_fill_holes` (interior-hole filling before feathering) — Python always
 *     applies this for character sheets ("A character turnaround silhouette
 *     MUST be solid"); the SAM3 bridge `cutout` calls through has a fixed
 *     feather-only behavior with no hole-filling option (unchanged by the
 *     2026-07-31 port).
 *   - `--self-test` (hero synthesis via ZImagePipeline T2I) — needs the MLX
 *     Python pipeline; out of scope for a Bun-only port. Callers wanting a
 *     self-test must supply their own hero image via `input`.
 *   - Everything profile_native.ts itself defers (prompt-style "detailed",
 *     --chain-ref, --ref-strength, VLM angle/identity verification, the HTML
 *     viewer, the horizontal strip PNG) — inherited unchanged, since Phase 1
 *     delegates straight to `runProfileNative`.
 */
```

- [ ] **Step 8: Run the full test file**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/character_native.test.ts`
Expected: PASS — all tests green (naming, buildIdentitySpec, orchestration, writeIdentitySpec).

- [ ] **Step 9: Run the full package test suite to confirm no other file references the removed exports**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test`
Expected: PASS, 0 failures. (If any other file imports `SegmentFn`/`SegmentResult`/`defaultSegment`/`maskPathFor` from `character_native.ts`, this will surface it as a compile error — grep first if it fails: `grep -rn "SegmentFn\|SegmentResult\|defaultSegment\|maskPathFor" bun-apps/pi-agent-ext-movie-director/src/`.)

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/character_native.ts bun-apps/pi-agent-ext-movie-director/src/character_native.test.ts
git commit -m "feat(character-native): wire Phase 2 to flux2 cutout, drop mask field

views[].cutout now carries a real alpha-composited PNG path instead of
always being null. Closes the gap flagged as a follow-up in the
2026-07-31 cutout Swift-native port."
```

---

### Task 3: Update `registry.ts` notes

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts` (two `notes` strings: `flux2_image` and `character_native`)

No test for this task — it's documentation-only (the `notes` field is never asserted against in tests; confirmed by `grep -rn "notes" bun-apps/pi-agent-ext-movie-director/src/registry.test.ts` returning nothing that checks string content, only that `notes` exists on `GAP`-prefixed entries).

- [ ] **Step 1: Update `flux2_image`'s notes — the cutout cross-reference is now stale**

In `bun-apps/pi-agent-ext-movie-director/src/registry.ts`, find the `flux2_image` entry's `notes` string (the long paragraph ending in `... — not bundled into this port).")`. Locate this exact trailing sentence within it:

```
Also newly relevant: `character_native.ts`'s own notes (below, `character_native` entry) document that its `views[].cutout` is permanently `null` because it \"has no image-codec/pixel-buffer library to do the PIL-equivalent alpha compositing\" — that capability now exists (this command), so wiring `character_native.ts` to call `flux2 cutout` instead of bare `flux2 segment` is a viable, NOT YET DONE follow-up (would change IdentitySpec output shape, needs its own scoping/testing — not bundled into this port).
```

Replace it with:

```
`character_native.ts` was wired to call this command (2026-08-01, see that entry's notes below and docs/superpowers/specs/2026-08-01-character-native-cutout-wiring-design.md) — its `views[].cutout` now carries a real alpha-composited path instead of always being `null`.
```

- [ ] **Step 2: Update `character_native`'s notes — remove the "REAL DELTA" paragraph**

In the same file, find the `character_native` entry's `notes` string. Replace the entire string (currently starting `"Direct Bun implementation (src/character_native.ts) of image-character.py's 3-phase character-sheet build: ..."` through `"... exactly like `segment` already does for every other flux2 caller."`) with:

```
"Direct Bun implementation (src/character_native.ts) of image-character.py's 3-phase character-sheet build: Phase 1 delegates straight to runProfileNative (profile_native.ts, above) for the multi-view sheet; Phase 2 calls flux2's native `cutout` command (SAM3.1 bridge + MLX alpha compositing) once per generated view; Phase 3 assembles + can write IdentitySpec.json (schema character-lock.v1). `views[].cutout` carries a real alpha-composited PNG path, or `null` when SAM3 found no detection for that view — Phase 2 moved off `segment` onto `cutout` (2026-08-01, see docs/superpowers/specs/2026-08-01-character-native-cutout-wiring-design.md and the flux2_image entry's notes above), closing the mask-only gap this module used to document here. Also deferred: Python's `_fill_holes` interior-hole fill (the SAM3 bridge `cutout` calls through has a fixed feather-only behavior, unchanged by the 2026-07-31/2026-08-01 ports) and `--self-test` hero synthesis (needs the MLX ZImagePipeline, Python-only). No run.py, no MLX venv for the orchestration itself — segmentation still bridges through Python via flux2's own `cutout`/`segment` commands (unchanged, pre-existing Swift-native path), exactly like `segment` already does for every other flux2 caller.",
```

- [ ] **Step 3: Run the movie-director test suite once more (registry-adjacent tests, e.g. selector.test.ts, must stay green since routing itself is unchanged — only notes text changed)**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test`
Expected: PASS, 0 failures.

- [ ] **Step 4: Run schema-drift check (registry.ts feeds the GUI's provider-menu sync; confirm no drift)**

Run: `bun run --cwd bun-apps/gui-movie-director check:schema`
Expected: PASS, no drift reported.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts
git commit -m "docs(registry): close the character_native cutout-wiring cross-reference

The 2026-07-31 cutout port's notes flagged wiring character_native.ts as
a NOT YET DONE follow-up; Task 2 of this plan did that wiring, so both
entries' notes are updated to say so instead of still pointing forward."
```

---

### Task 4: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full `pi-agent-ext-movie-director` suite one more time**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test`
Expected: PASS, 0 failures, 0 unexpected skips (compare skip count to the pre-change baseline — this plan doesn't add or remove any `it.skip`).

- [ ] **Step 2: Run the `pi-agent-ext-flux2` suite (unrelated, but `character_native.ts` imports `runFlux2` from it — confirm no cross-package breakage)**

Run: `cd bun-apps/pi-agent-ext-flux2 && bun test`
Expected: PASS, 133 tests (unchanged from before this plan — nothing in this plan touches `pi-agent-ext-flux2`).

- [ ] **Step 3: Grep for any remaining stale references to the removed names anywhere in the repo (not just the movie-director package)**

Run: `grep -rn "SegmentFn\|SegmentResult\|defaultSegment\b\|maskPathFor" --include="*.ts" bun-apps/ 2>/dev/null | grep -v node_modules`
Expected: no output (the grep should match nothing — `SegmentFn`/`SegmentResult`/`defaultSegment`/`maskPathFor` no longer exist anywhere, including in `pi-agent-ext-flux2`'s own unrelated `segment` command naming, which uses different identifiers).

Note: this WILL still match `flux2-image-director`'s own `SegmentCommand.swift` if you broaden the grep to `.swift` files — that's expected and correct, it's a different, still-live command (`flux2 segment` itself is untouched by this plan). The `--include="*.ts"` scope above is deliberate.
