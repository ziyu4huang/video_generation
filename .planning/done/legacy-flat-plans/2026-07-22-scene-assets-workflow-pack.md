# scene-assets → workflow-pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `pi-agent-ext-movie-director`'s `scene-assets` saved workflow from a single-file `workflows/scene-assets.js` script into a proper workflow-pack (`workflows/scene-assets/manifest.json` + `index.js`), as a pilot before deciding whether to convert the other three saved workflows.

**Architecture:** The pack's `index.js` is byte-identical to the current `scene-assets.js` — no rewrite needed, since `pi-agent-ext-workflow`'s engine already runs bare-top-level-statement scripts (the style movie-director uses) as-is, with or without an `export default` wrapper. The only real code changes are (1) `extensions/movie-workflows.ts`'s static text-import path, which must point at the new pack location, and (2) `extensions/movie-workflows.test.ts`'s directory scan, which currently only looks at flat `.js` files and would otherwise silently stop testing `scene-assets` once it becomes a directory.

**Tech Stack:** Bun, TypeScript, `@repo/pi-agent-ext-workflow` (`resolveWorkflowScript`, `runWorkflowScript`, `parseWorkflowScript`, `readManifest`), `bun:test`.

---

## Spec reference

Full design: `docs/superpowers/specs/2026-07-22-scene-assets-workflow-pack-design.md`

## Scope note

Only `scene-assets` is converted. `produce-video`, `research-first`, `review-cut` stay as single-file `.js` scripts — out of scope for this plan.

---

### Task 1: Convert `scene-assets.js` into a workflow-pack and fix the extension's import path

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/scene-assets/manifest.json`
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/scene-assets/index.js`
- Delete: `bun-apps/pi-agent-ext-movie-director/workflows/scene-assets.js`
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts:26`

- [ ] **Step 1: Create the pack manifest**

Create `bun-apps/pi-agent-ext-movie-director/workflows/scene-assets/manifest.json`:

```json
{
  "name": "scene-assets",
  "description": "Parallel per-scene asset generation: T2I still → I2V clip (chained for long scenes) → TTS narration. Deterministic via call(\"movie.*\").",
  "entry": "index.js",
  "kind": "workflow-pack",
  "engine": "pi-agent-ext-workflow"
}
```

- [ ] **Step 2: Move the script into the pack as `index.js`, unchanged**

Create `bun-apps/pi-agent-ext-movie-director/workflows/scene-assets/index.js` with the **exact current content** of `bun-apps/pi-agent-ext-movie-director/workflows/scene-assets.js` (do not modify any line — the bare-statement style already runs as-is in a pack):

```js
/**
 * /scene-assets — parallel asset generation per scene.
 *
 * Per scene: T2I still → I2V clip (chained when scene duration > one practical
 * call ~8s) → TTS narration. All scenes run in parallel via parallel().
 * Deterministic steps use call('movie.*'); the only agent() calls are ffmpeg
 * last-frame extractions (tier:small) for I2V continuation.
 *
 * Scene shape (canonical scene_plan): {id, type, description, start_seconds,
 * end_seconds, script_section_id?, shot_language?, narration?, image?, prompt?}
 *   visual prompt  ← scene.prompt  OR scene.description (+ shot_language vocab)
 *   duration       ← scene.durationSeconds OR (end_seconds − start_seconds) OR 8s
 *   narration      ← scene.narration (populated by /produce-video from the script)
 * A simplified {id, prompt, durationSeconds, narration} shape also works.
 */
export const meta = {
  name: 'scene-assets',
  description: 'Parallel per-scene asset generation: T2I still → I2V clip (chained for long scenes) → TTS narration. Deterministic via call("movie.*").',
  phases: [{ title: 'Setup' }, { title: 'Generate' }, { title: 'Report' }],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const projectId = A.projectId
const pipeline = A.pipeline || 'animated-explainer'
const outputDir = A.outputDir
const PRACTICAL_CLIP_SEC = 8 // hardware ceiling per I2V call (see dispatch generate notes)
const FPS = 25

/** Build the visual prompt for a scene from canonical fields + shot vocabulary. */
function visualPrompt(s) {
  if (s.prompt) return s.prompt
  let p = s.description || ''
  const sl = s.shot_language || {}
  const vocab = [
    sl.shot_size, sl.camera_movement, sl.lighting_key, sl.lens_mm ? sl.lens_mm + 'mm' : null,
    sl.depth_of_field ? sl.depth_of_field + ' dof' : null, sl.color_temperature,
  ].filter(Boolean)
  if (vocab.length) p += `. Cinematography: ${vocab.join(', ')}.`
  return p
}

/** Resolve a scene's target duration in seconds (canonical start/end, simplified, or default). */
function sceneDuration(s) {
  if (typeof s.durationSeconds === 'number') return s.durationSeconds
  if (typeof s.end_seconds === 'number' && typeof s.start_seconds === 'number') {
    return Math.max(0.5, s.end_seconds - s.start_seconds)
  }
  return PRACTICAL_CLIP_SEC
}

phase('Setup')
let scenes = Array.isArray(A.scenes) ? A.scenes : null
if (!scenes && projectId) {
  const cp = await call('movie.read-checkpoint', { projectId, pipeline })
  scenes = cp?.checkpoint?.artifacts?.scene_plan?.scenes ?? null
}
if (!scenes || scenes.length === 0) {
  throw new Error('scene-assets: pass args.scenes[] or args.projectId with a completed scene_plan checkpoint')
}
log(`scenes: ${scenes.length}; projectId: ${projectId || '(none)'}`)

phase('Generate')
const results = await parallel(scenes.map((s) => () => generateScene(s)))

phase('Report')
// Build edit_decisions.cuts: one cut per generated clip, consecutive sub-clips
// for chained (multi-call) scenes named cut-<sceneId>-a/b/...
const editCuts = []
for (let i = 0; i < results.length; i++) {
  const r = results[i]
  if (!r || !r.clipPaths || r.clipPaths.length === 0) continue
  if (r.clipPaths.length === 1) {
    editCuts.push({ id: `cut-${scenes[i].id}`, source: r.clipPaths[0], in_seconds: 0, out_seconds: r.durationSeconds, type: 'video' })
  } else {
    let off = 0
    for (let j = 0; j < r.clipPaths.length; j++) {
      const dur = Math.min(PRACTICAL_CLIP_SEC, r.durationSeconds - off)
      editCuts.push({ id: `cut-${scenes[i].id}-${String.fromCharCode(97 + j)}`, source: r.clipPaths[j], in_seconds: 0, out_seconds: dur, type: 'video' })
      off += dur
    }
  }
}
if (projectId) {
  await call('movie.write-checkpoint', {
    projectId, pipeline, stage: 'assets', status: 'completed',
    artifacts: { edit_decisions: { version: '1', render_runtime: 'ffmpeg', cuts: editCuts } },
  })
}
return { scenes: scenes.length, results, editCuts }

async function generateScene(s) {
  // 1. T2I still (or reuse a provided image path)
  let stillPath = s.image
  if (!stillPath) {
    const t2i = await call('movie.generate', {
      capability: 'image_generation', command: 't2i',
      options: { prompt: visualPrompt(s) }, projectId, outputDir,
    })
    stillPath = t2i?.result?.artifacts?.[0]?.path
  }
  if (!stillPath) throw new Error(`scene ${s.id}: T2I produced no still`)

  // 2. I2V — chain multiple calls when the scene is longer than one practical clip
  const targetSec = sceneDuration(s)
  const clipPaths = []
  let frame = stillPath
  let elapsed = 0
  const prompt = visualPrompt(s)
  while (elapsed < targetSec) {
    const chunk = Math.min(PRACTICAL_CLIP_SEC, targetSec - elapsed)
    const i2v = await call('movie.generate', {
      capability: 'video_generation',
      options: { prompt, image: frame, frames: Math.round(chunk * FPS), fps: FPS },
      projectId, outputDir,
    })
    const clipPath = i2v?.result?.artifacts?.[0]?.path
    if (!clipPath) throw new Error(`scene ${s.id}: I2V produced no clip at elapsed=${elapsed}`)
    clipPaths.push(clipPath)
    elapsed += chunk
    if (elapsed < targetSec) {
      // continue motion: feed clip's last frame into the next I2V call
      const lf = await agent(
        `Run: Bash("ffmpeg -y -sseof -1 -i '${clipPath}' -frames:v 1 '${clipPath}.lastframe.png' && test -s '${clipPath}.lastframe.png' && echo ${clipPath}.lastframe.png"). Return the echoed path verbatim, or null on failure.`,
        { tier: 'small', label: `lastframe-${s.id}-${clipPaths.length}` },
      )
      frame = (typeof lf === 'string' ? lf : '').trim() || `${clipPath}.lastframe.png`
    }
  }

  // 3. TTS narration (tracked path — never raw say/edge-tts)
  let narrationPath = null
  if (s.narration) {
    const tts = await call('movie.generate', { capability: 'tts', options: { text: s.narration }, projectId, outputDir })
    narrationPath = tts?.result?.artifacts?.[0]?.path
  }
  return { id: s.id, stillPath, clipPaths, durationSeconds: targetSec, narrationPath }
}
```

- [ ] **Step 3: Delete the old flat-file script**

```bash
git rm bun-apps/pi-agent-ext-movie-director/workflows/scene-assets.js
```

- [ ] **Step 4: Fix the extension's static import path**

In `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts`, change line 26 from:

```ts
import sceneAssetsSrc from "../workflows/scene-assets.js" with { type: "text" };
```

to:

```ts
import sceneAssetsSrc from "../workflows/scene-assets/index.js" with { type: "text" };
```

Nothing else in that file changes — `WORKFLOWS`, `registerCommand`, and `loadSavedWorkflow` all consume `sceneAssetsSrc` the same way regardless of where the text was imported from.

- [ ] **Step 5: Confirm the package still typechecks**

Run: `bun run --cwd bun-apps/pi-agent-ext-movie-director typecheck`
Expected: no errors (exit code 0).

- [ ] **Step 6: Run the existing structural test suite and observe the silent gap**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts )`

Expected: **PASS**, 0 failures — but look at the printed test names. Before this task, there were 4 per-workflow `describe` blocks (`produce-video.js`, `research-first.js`, `review-cut.js`, `scene-assets.js`). Now there are only 3 (`produce-video.js`, `research-first.js`, `review-cut.js`) — `scene-assets` silently dropped out of coverage because `extensions/movie-workflows.test.ts` only scans flat `.js` files (`readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".js") ...)`), and `scene-assets` is now a directory. This is the exact gap Task 2 fixes.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/workflows/scene-assets bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts
git commit -m "$(cat <<'EOF'
refactor(movie-director): convert scene-assets workflow to a workflow-pack

Pilot conversion of the scene-assets saved workflow from a single-file
workflows/scene-assets.js script into a workflow-pack (manifest.json +
index.js), to trial the pack format before converting the other three
saved workflows. The entry script content is unchanged — the engine
already runs bare-top-level-statement scripts as-is in pack form.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Write a failing test that catches the silent coverage gap

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts`

- [ ] **Step 1: Add a hard-coded "all 4 canonical workflows discovered" assertion**

In `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts`, add this test right after the existing `"there is at least one workflow file"` test (do not change the flat-file-only `workflowFiles` scan yet — that's Task 3):

```ts
  test("all 4 canonical saved workflows are discovered", () => {
    const names = workflowFiles.map((f) => f.replace(/\.js$/, "")).sort();
    expect(names).toEqual(["produce-video", "research-first", "review-cut", "scene-assets"]);
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts -t "all 4 canonical" )`

Expected: **FAIL**. The flat-file scan only finds `produce-video`, `research-first`, `review-cut` (`scene-assets` is now a directory, not a `.js` file), so the sorted names array has 3 entries, not 4 — `expect(names).toEqual([...4 items])` fails.

- [ ] **Step 3: Commit the failing test**

```bash
git add bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts
git commit -m "$(cat <<'EOF'
test(movie-director): add failing regression test for pack-directory discovery gap

extensions/movie-workflows.test.ts only scans flat .js files, so
scene-assets (now a workflow-pack directory) silently drops out of
structural coverage. This test pins the expected 4-workflow set so the
gap fails loudly instead of silently.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Make the test file discover workflow-pack directories

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts`

- [ ] **Step 1: Replace the file-scanning logic with a pack-aware discovery function**

Replace the full content of `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts` with:

```ts
/**
 * Structural test for the movie-director saved workflows. Discovers both
 * flat single-file scripts (workflows/<name>.js) and workflow-pack
 * directories (workflows/<name>/manifest.json + entry) under workflows/.
 * For each discovered workflow:
 *   (a) parseWorkflowScript must succeed (valid workflow syntax + meta export)
 *   (b) every call('movie.X', …) reference must resolve to a registered host-fn
 *       (catches typo'd command names before a real run hits "not registered")
 *
 * Deterministic, no GPU, no model. Applies to all saved workflows as they land,
 * regardless of whether they're a flat script or a pack.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowScript, readManifest } from "@repo/pi-agent-ext-workflow";
import { buildMovieHostFnRegistry } from "../src/host-fns.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");

interface DiscoveredWorkflow {
  /** The workflow's name — from manifest.name (pack) or the filename minus .js (flat file). */
  name: string;
  /** The entry script's source text. */
  script: string;
}

/** Discover every workflow under `dir`: pack directories (has manifest.json)
 *  and flat `<name>.js` files. Entries starting with "_" are skipped (helper
 *  scripts like _resume-probe.js, not saved workflows). */
function discoverWorkflows(dir: string): DiscoveredWorkflow[] {
  const out: DiscoveredWorkflow[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("_")) continue;
    const entryPath = join(dir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      if (!existsSync(join(entryPath, "manifest.json"))) continue;
      const manifest = readManifest(entryPath);
      const script = readFileSync(join(entryPath, manifest.entry), "utf8");
      out.push({ name: manifest.name, script });
      continue;
    }
    if (stat.isFile() && entry.endsWith(".js")) {
      out.push({ name: entry.replace(/\.js$/, ""), script: readFileSync(entryPath, "utf8") });
    }
  }
  return out;
}

const workflows = discoverWorkflows(WORKFLOWS_DIR);

describe("movie-director saved workflows (structural)", () => {
  const registry = buildMovieHostFnRegistry();
  const registered = new Set(registry.list());

  test("there is at least one workflow", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  test("all 4 canonical saved workflows are discovered", () => {
    const names = workflows.map((w) => w.name).sort();
    expect(names).toEqual(["produce-video", "research-first", "review-cut", "scene-assets"]);
  });

  for (const wf of workflows) {
    describe(wf.name, () => {
      test("parses as a valid workflow script", () => {
        const { meta } = parseWorkflowScript(wf.script);
        expect(meta.name).toBe(wf.name);
        expect(Array.isArray(meta.phases)).toBe(true);
        expect(meta.phases!.length).toBeGreaterThan(0);
      });

      test("every call('movie.X', …) reference resolves to a registered host-fn", () => {
        // match call('movie.write-checkpoint' or call("movie.generate" etc.
        const refs = [...wf.script.matchAll(/call\(\s*['"]movie\.([a-z0-9-]+)['"]/gi)].map(
          (m) => `movie.${m[1]}`,
        );
        expect(refs.length, `${wf.name} should use at least one movie.* host-fn`).toBeGreaterThan(0);
        const unresolved = refs.filter((r) => !registered.has(r));
        expect(unresolved, `unresolved movie.* refs in ${wf.name}: ${unresolved.join(", ")}`).toEqual([]);
      });
    });
  }
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts )`

Expected: **PASS**. All 4 `describe` blocks are back (`produce-video`, `research-first`, `review-cut`, `scene-assets`), and `"all 4 canonical saved workflows are discovered"` now passes because `discoverWorkflows` finds `scene-assets` via its `manifest.json`.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts
git commit -m "$(cat <<'EOF'
fix(movie-director): discover workflow-pack directories in structural test

extensions/movie-workflows.test.ts previously only scanned flat .js
files under workflows/, so a workflow converted to pack format (folder +
manifest.json) would silently stop being structurally tested. This adds
pack-directory discovery alongside the existing flat-file scan.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add a resolver + dry-run smoke test for the new pack

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts`

- [ ] **Step 1: Add a new describe block exercising the shared pack resolver**

In `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts`, add `resolveWorkflowScript` and `runWorkflowScript` to the existing `@repo/pi-agent-ext-workflow` import:

```ts
import { parseWorkflowScript, readManifest, resolveWorkflowScript, runWorkflowScript } from "@repo/pi-agent-ext-workflow";
```

Then append this new `describe` block at the end of the file (after the closing `});` of `"movie-director saved workflows (structural)"`):

```ts
describe("scene-assets pack resolves via the shared workflow-pack resolver", () => {
  const REPO_ROOT = join(HERE, "..", "..", "..");

  test("resolveWorkflowScript finds it as a package-workflows pack", () => {
    const resolved = resolveWorkflowScript("scene-assets", { cwd: REPO_ROOT });
    expect(resolved.source).toBe("package-workflows");
    expect(resolved.pack?.manifest.name).toBe("scene-assets");
    expect(resolved.pack?.manifest.entry).toBe("index.js");
  });

  test("runWorkflowScript dry-run parses and validates without executing", async () => {
    const receipt = await runWorkflowScript({ name: "scene-assets", cwd: REPO_ROOT, dryRun: true });
    expect(receipt.dryRun).toBe(true);
    expect(receipt.meta.name).toBe("scene-assets");
    expect(receipt.source).toBe("package-workflows");
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts )`

Expected: **PASS** — both new tests green, confirming the pack is resolvable by `pi-agent-ext-workflow`'s shared resolver from the repo root (the same resolution path the `workflow` tool and `pi-agent-cli workflow run` use), and that a dry-run parses/validates it without executing any agent calls.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts
git commit -m "$(cat <<'EOF'
test(movie-director): add resolver + dry-run smoke test for scene-assets pack

Confirms the converted scene-assets pack resolves through
pi-agent-ext-workflow's shared resolveWorkflowScript (source:
"package-workflows") and that a dry-run run via runWorkflowScript
parses/validates the pack without executing any agent calls.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full-package regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full package test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS, 0 failures (compare against the 467-pass / 0-fail / 8-skip baseline recorded in `receipts/workflow-redesign-20260712.md` — an exact match isn't required since the suite has grown since then, but there must be 0 new failures).

- [ ] **Step 2: Run the package typecheck**

Run: `bun run --cwd bun-apps/pi-agent-ext-movie-director typecheck`
Expected: no errors (exit code 0).

- [ ] **Step 3: If everything is green, this plan is complete — no commit needed for this task (verification only).**
