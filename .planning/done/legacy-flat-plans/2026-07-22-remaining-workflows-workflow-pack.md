# Convert Remaining Saved Workflows to Workflow-Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `pi-agent-ext-movie-director`'s three remaining single-file saved workflows (`research-first`, `review-cut`, `produce-video`) into workflow-packs, applying the exact recipe already validated and merged for `scene-assets` (PR #750).

**Architecture:** Each conversion is byte-identical-content + a manifest, exactly like the `scene-assets` pilot: create `workflows/<name>/manifest.json` + `workflows/<name>/index.js` (unchanged script body), delete the old flat `workflows/<name>.js`, and fix the one static import line in `extensions/movie-workflows.ts` that points at it. Unlike the pilot, **no test-coverage gap needs fixing this time** — `extensions/movie-workflows.test.ts`'s `discoverWorkflows()` (added during the pilot) already discovers pack directories generically, and its `"all 4 canonical saved workflows are discovered"` assertion already expects all 4 by name regardless of which are flat files vs packs. The only test file change needed is generalizing the pilot's scene-assets-only resolver/dry-run smoke test into a loop over all 4 names, now that all 4 are packs.

**Tech Stack:** Bun, TypeScript, `@repo/pi-agent-ext-workflow` (`resolveWorkflowScript`, `runWorkflowScript`, `parseWorkflowScript`, `readManifest` — all already used in this test file), `bun:test`.

---

## Prior art

This plan repeats the pattern from `docs/superpowers/specs/2026-07-22-scene-assets-workflow-pack-design.md` and `docs/superpowers/plans/2026-07-22-scene-assets-workflow-pack.md` (merged to main via PR #750). Key facts already established there, reused here without re-verifying:
- A pack's entry script needs no rewrite — the bare-top-level-statement style (no `export default`) that all these scripts already use runs as-is in pack form.
- Checked-in packs (under `bun-apps/<pkg>/workflows/`) need no `agents/` dir and no ephemeral `inputs/outputs/intermediate/runs/` dirs — those redirect automatically to `.pi/workflows/.state/<pack-id>/`.
- `extensions/movie-workflows.ts`'s static `import ... with { type: "text" }` pattern must point at the pack's `index.js`, one line per workflow.
- A pre-existing, unrelated `tsc` quirk (`TS1192: Module "..." has no default export`) already appears on all 4 of these static text imports regardless of flat-file vs. pack-directory format — this is NOT a regression to chase in this plan; verified independently during the pilot via a throwaway `git worktree` at the pre-pilot commit.

## Scope

All three remaining workflows (`research-first`, `review-cut`, `produce-video`) are converted. After this plan, all 4 saved workflows are workflow-packs and no flat `workflows/*.js` saved-workflow scripts remain (the helper script `workflows/_resume-probe.js` is untouched — it's not a saved workflow, and `discoverWorkflows`/`movie-workflows.ts` both already skip/ignore it by convention).

---

### Task 1: Convert `research-first.js` into a workflow-pack

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/research-first/manifest.json`
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/research-first/index.js`
- Delete: `bun-apps/pi-agent-ext-movie-director/workflows/research-first.js`
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts:27`

- [ ] **Step 1: Create the pack manifest**

Create `bun-apps/pi-agent-ext-movie-director/workflows/research-first/manifest.json`:

```json
{
  "name": "research-first",
  "description": "Web research (parallel angles) + adversarial cross-check → proposal_packet for the movie pipeline.",
  "entry": "index.js",
  "kind": "workflow-pack",
  "engine": "pi-agent-ext-workflow"
}
```

- [ ] **Step 2: Move the script into the pack as `index.js`, unchanged**

Create `bun-apps/pi-agent-ext-movie-director/workflows/research-first/index.js` with the EXACT current content of `bun-apps/pi-agent-ext-movie-director/workflows/research-first.js` (copy verbatim, do not modify a single line):

```js
/**
 * /research-first — research a concept across the web (parallel angles),
 * cross-check with verify(), then synthesize a proposal_packet. Writes the
 * proposal checkpoint when projectId is given. Uses web_search (the run is
 * given web tools by movie-workflows.ts, like /deep-research).
 */
export const meta = {
  name: 'research-first',
  description: 'Web research (parallel angles) + adversarial cross-check → proposal_packet for the movie pipeline.',
  phases: [{ title: 'Research' }, { title: 'Cross-check' }, { title: 'Proposal' }, { title: 'Checkpoint' }],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const concept = String(A.concept || A._ || '').trim()
if (!concept) throw new Error('research-first: pass args.concept=<the idea>')
const projectId = A.projectId
const pipeline = A.pipeline || 'animated-explainer'

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    angle: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings'],
}

phase('Research')
const angles = Array.isArray(A.angles) && A.angles.length
  ? A.angles
  : ['visual style references', 'subject matter background', 'audience and tone', 'comparable examples']
const raw = await parallel(angles.map((ang) => () =>
  agent(
    `Research the video concept "${concept}" focused on: ${ang}. Use web_search with 2-3 varied-query angles. ` +
    `Return concise bullet findings plus the source URLs you actually used.`,
    { tier: 'medium', schema: FINDINGS_SCHEMA, label: `research-${String(ang).slice(0, 20)}` },
  ),
))

phase('Cross-check')
const verified = await verify(
  { concept, angles: raw },
  { reviewers: 3, threshold: 0.66, lens: `For the concept "${concept}": are the findings on-topic and the sources real/non-duplicated? Default real=false if a finding is off-topic or a source looks fabricated.` },
)
log(`cross-check: trustworthy=${verified?.real} (${verified?.realCount}/${verified?.total})`)

phase('Proposal')
const proposal = await agent(
  `Synthesize a production proposal for a SHORT video about: ${concept}.\n` +
  `Use these verified research findings (trustworthy=${verified?.real}):\n${JSON.stringify(raw)}\n` +
  `Return: title, logline, target_duration_seconds, visual_style, tone, and key_scenes (3-5 items; each with id, prompt, durationSeconds, narration).`,
  {
    tier: 'big',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        logline: { type: 'string' },
        target_duration_seconds: { type: 'number' },
        visual_style: { type: 'string' },
        tone: { type: 'string' },
        key_scenes: { type: 'array', items: { type: 'object' } },
      },
      required: ['title', 'logline', 'key_scenes'],
    },
    label: 'synthesize-proposal',
  },
)

phase('Checkpoint')
if (projectId) {
  await call('movie.write-checkpoint', {
    projectId, pipeline, stage: 'proposal', status: 'completed',
    artifacts: { proposal_packet: proposal },
  })
  log(`wrote proposal checkpoint for ${projectId}`)
}
return proposal
```

- [ ] **Step 3: Delete the old flat-file script**

```bash
git rm bun-apps/pi-agent-ext-movie-director/workflows/research-first.js
```

- [ ] **Step 4: Fix the extension's static import path**

In `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts`, change line 27 from:

```ts
import researchFirstSrc from "../workflows/research-first.js" with { type: "text" };
```

to:

```ts
import researchFirstSrc from "../workflows/research-first/index.js" with { type: "text" };
```

Nothing else in that file changes.

- [ ] **Step 5: Run the structural test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts )`
Expected: PASS, 0 failures. Unlike the original scene-assets pilot, this should NOT introduce any new failures — `discoverWorkflows()` already handles pack directories generically, so `research-first` is found under its new location with zero test-file changes needed.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/workflows/research-first bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts
git commit -m "$(cat <<'EOF'
refactor(movie-director): convert research-first workflow to a workflow-pack

Second of three remaining conversions applying the scene-assets pilot's
recipe (PR #750). Entry script content is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Convert `review-cut.js` into a workflow-pack

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/review-cut/manifest.json`
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/review-cut/index.js`
- Delete: `bun-apps/pi-agent-ext-movie-director/workflows/review-cut.js`
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts:28`

- [ ] **Step 1: Create the pack manifest**

Create `bun-apps/pi-agent-ext-movie-director/workflows/review-cut/manifest.json`:

```json
{
  "name": "review-cut",
  "description": "Adversarial review of a composed cut: movie.final-review probe + verify() against the script. Gates publish.",
  "entry": "index.js",
  "kind": "workflow-pack",
  "engine": "pi-agent-ext-workflow"
}
```

- [ ] **Step 2: Move the script into the pack as `index.js`, unchanged**

Create `bun-apps/pi-agent-ext-movie-director/workflows/review-cut/index.js` with the EXACT current content of `bun-apps/pi-agent-ext-movie-director/workflows/review-cut.js` (copy verbatim):

```js
/**
 * /review-cut — adversarial review of a composed cut. Runs the deterministic
 * movie.final-review probe, then verify() the cut against the script intent.
 * verdict pass/fail gates publish. Uses verify() (known signature from the
 * kcard sample); judgePanel is an optional alternative.
 */
export const meta = {
  name: 'review-cut',
  description: 'Adversarial review of a composed cut: movie.final-review probe + verify() against the script. Gates publish.',
  phases: [{ title: 'Probes' }, { title: 'Adversarial review' }, { title: 'Verdict' }],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const mp4Path = String(A.mp4Path || '')
if (!mp4Path) throw new Error('review-cut: pass args.mp4Path=<path to composed mp4>')
const script = A.script
const projectId = A.projectId
const pipeline = A.pipeline || 'animated-explainer'
const transcriptPath = A.transcriptPath
const narration = A.narration // 'voiced' | 'none' | undefined

phase('Probes')
const fr = await call('movie.final-review', {
  mp4Path,
  ...(transcriptPath ? { transcriptPath } : {}),
  ...(narration ? { narration } : {}),
})
log(`final-review verdict: ${fr?.verdict}`)

phase('Adversarial review')
const verified = await verify(
  { mp4Path, script, finalReview: fr },
  {
    reviewers: 3,
    threshold: 0.66,
    lens: `Does this cut fulfill the script's intent? Watch for: frozen-frame padding, narration/visual mismatch, pacing problems, missing scenes. The deterministic final-review verdict was "${fr?.verdict}". Default real=false (i.e. the cut is bad) if you spot any of those problems.`,
  },
)
log(`adversarial: cut-ok=${verified?.real} (${verified?.realCount}/${verified?.total})`)

phase('Verdict')
const pass = fr?.verdict === 'pass' && verified?.real === true
const result = { verdict: pass ? 'pass' : 'fail', finalReview: fr, adversarial: verified }
if (projectId) {
  await call('movie.write-checkpoint', { projectId, pipeline, stage: 'compose', status: 'completed', review: result })
}
return result
```

- [ ] **Step 3: Delete the old flat-file script**

```bash
git rm bun-apps/pi-agent-ext-movie-director/workflows/review-cut.js
```

- [ ] **Step 4: Fix the extension's static import path**

In `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts`, change line 28 from:

```ts
import reviewCutSrc from "../workflows/review-cut.js" with { type: "text" };
```

to:

```ts
import reviewCutSrc from "../workflows/review-cut/index.js" with { type: "text" };
```

- [ ] **Step 5: Run the structural test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts )`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/workflows/review-cut bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts
git commit -m "$(cat <<'EOF'
refactor(movie-director): convert review-cut workflow to a workflow-pack

Third of three remaining conversions applying the scene-assets pilot's
recipe (PR #750). Entry script content is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Convert `produce-video.js` into a workflow-pack

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/produce-video/manifest.json`
- Create: `bun-apps/pi-agent-ext-movie-director/workflows/produce-video/index.js`
- Delete: `bun-apps/pi-agent-ext-movie-director/workflows/produce-video.js`
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts:29`

- [ ] **Step 1: Create the pack manifest**

Create `bun-apps/pi-agent-ext-movie-director/workflows/produce-video/manifest.json`:

```json
{
  "name": "produce-video",
  "description": "Full movie pipeline (idea→publish) as a journaled-resumable workflow. Composes /research-first, /scene-assets, /review-cut.",
  "entry": "index.js",
  "kind": "workflow-pack",
  "engine": "pi-agent-ext-workflow"
}
```

- [ ] **Step 2: Move the script into the pack as `index.js`, unchanged**

Create `bun-apps/pi-agent-ext-movie-director/workflows/produce-video/index.js` with the EXACT current content of `bun-apps/pi-agent-ext-movie-director/workflows/produce-video.js` (copy verbatim):

```js
/**
 * /produce-video — the full movie pipeline as one journaled-resumable workflow:
 * init → idea → research/proposal → script → scene_plan → assets → edit →
 * compose → publish. Composes /research-first, /scene-assets, /review-cut via
 * the workflow() global (resolved by movie-workflows.ts' loadSavedWorkflow).
 *
 * Scene/narration join: the scene_plan schema has NO narration field —
 * narration lives in the script's sections, linked by script_section_id. So
 * this workflow merges each scene's narration from its script section BEFORE
 * calling /scene-assets (which reads scene.narration for TTS).
 */
export const meta = {
  name: 'produce-video',
  description: 'Full movie pipeline (idea→publish) as a journaled-resumable workflow. Composes /research-first, /scene-assets, /review-cut.',
  phases: [
    { title: 'Init' }, { title: 'Idea' }, { title: 'Research+Proposal' },
    { title: 'Script' }, { title: 'Scene plan' }, { title: 'Assets' },
    { title: 'Edit' }, { title: 'Compose' }, { title: 'Publish' },
  ],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const concept = String(A.concept || A._ || '').trim()
if (!concept) throw new Error('produce-video: pass args.concept=<the idea>')
const pipeline = A.pipeline || 'animated-explainer'
const projectId = A.projectId || `wf-${concept.slice(0, 24).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`

phase('Init')
await call('movie.init-project', { projectId, pipeline })
log(`project: ${projectId} (${pipeline})`)

phase('Idea')
const idea = await agent(
  `Draft a one-paragraph idea brief for a short video about: ${concept}.`,
  { tier: 'medium', schema: { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'] }, label: 'idea-brief' },
)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'idea', status: 'in_progress', artifacts: { idea_brief: idea } })

phase('Research+Proposal')
const proposal = await workflow('research-first', { concept, projectId, pipeline })

phase('Script')
const script = await agent(
  `Write a production script for a short video about: ${concept}.\nProposal:\n${JSON.stringify(proposal)}\n` +
  `Return: sections[] (each {id, narration, durationSeconds}), top-level narration ('voiced'|'none'), and total_duration_seconds.`,
  {
    tier: 'big',
    schema: {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { type: 'object' } },
        narration: { type: 'string' },
        total_duration_seconds: { type: 'number' },
      },
      required: ['sections'],
    },
    label: 'write-script',
  },
)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'script', status: 'completed', artifacts: { script } })

phase('Scene plan')
const sectionById = new Map((script.sections || []).map((s) => [String(s.id), s]))
const scenePlan = await agent(
  `Break this script into scenes (one per section). Each scene MUST have: id, type ("generated"|"animation"|"broll"), ` +
  `description (a concrete visual prompt), start_seconds, end_seconds, and script_section_id (the matching section id).\n` +
  `Optionally add shot_language {shot_size, camera_movement, lighting_key} for richer visuals.\nScript:\n${JSON.stringify(script)}`,
  {
    tier: 'medium',
    schema: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' },
              start_seconds: { type: 'number' }, end_seconds: { type: 'number' }, script_section_id: { type: 'string' },
            },
            required: ['id', 'type', 'description', 'start_seconds', 'end_seconds'],
          },
        },
      },
      required: ['scenes'],
    },
    label: 'scene-plan',
  },
)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'scene_plan', status: 'completed', artifacts: { scene_plan: scenePlan } })

phase('Assets')
// Merge each scene's narration from its linked script section (scene_plan has no narration field).
const scenesWithNarration = scenePlan.scenes.map((sc) => {
  const sec = sc.script_section_id ? sectionById.get(String(sc.script_section_id)) : null
  return { ...sc, narration: sec?.narration ?? null }
})
await workflow('scene-assets', { projectId, pipeline, scenes: scenesWithNarration })

phase('Edit')
const cp = await call('movie.read-checkpoint', { projectId, pipeline, stage: 'assets' })
const editDecisions = cp?.checkpoint?.artifacts?.edit_decisions
if (!editDecisions || !Array.isArray(editDecisions.cuts)) throw new Error('assets stage produced no edit_decisions')
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'edit', status: 'completed', artifacts: { edit_decisions: editDecisions } })

phase('Compose')
const composed = await call('movie.compose-motion', {
  projectId,
  editDecisions,
  narrativeDurationSeconds: script.total_duration_seconds,
})
const mp4Path = composed?.outputPath || composed?.path || composed?.render_report?.outputPath
if (!mp4Path) throw new Error(`compose-motion produced no mp4 path: ${JSON.stringify(composed)}`)

phase('Publish')
const review = await workflow('review-cut', { mp4Path, script, projectId, pipeline, narration: script.narration })
if (review.verdict !== 'pass') throw new Error(`review-cut rejected the cut: ${JSON.stringify(review)}`)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'publish', status: 'completed' })

const cost = await call('movie.cost-snapshot', { projectId })
return { projectId, pipeline, mp4Path, review, cost }
```

Note: this script calls `workflow('research-first', …)` and `workflow('scene-assets', …)` and `workflow('review-cut', …)` — these resolve by NAME through `movie-workflows.ts`'s `loadSavedWorkflow` (backed by the `scripts` record built from the `WORKFLOWS` array's `source` text), not by file path. Since Tasks 1-2 (and the already-merged scene-assets pilot) already updated those `source` values to come from each pack's `index.js`, these nested calls need no changes here.

- [ ] **Step 3: Delete the old flat-file script**

```bash
git rm bun-apps/pi-agent-ext-movie-director/workflows/produce-video.js
```

- [ ] **Step 4: Fix the extension's static import path**

In `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts`, change line 29 from:

```ts
import produceVideoSrc from "../workflows/produce-video.js" with { type: "text" };
```

to:

```ts
import produceVideoSrc from "../workflows/produce-video/index.js" with { type: "text" };
```

- [ ] **Step 5: Run the structural test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts )`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/workflows/produce-video bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.ts
git commit -m "$(cat <<'EOF'
refactor(movie-director): convert produce-video workflow to a workflow-pack

Last of the three remaining conversions applying the scene-assets
pilot's recipe (PR #750). Entry script content is unchanged. Its nested
workflow('research-first'|'scene-assets'|'review-cut', …) calls resolve
by name through movie-workflows.ts's loadSavedWorkflow, unaffected by
this file-location change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Generalize the resolver + dry-run smoke test to cover all 4 packs

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts`

- [ ] **Step 1: Replace the scene-assets-only smoke-test block with a loop over all 4 names**

In `bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts`, replace this existing block (currently the last `describe` in the file):

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

with this (covers all 4, now that all 4 are packs):

```ts
describe("saved workflows resolve via the shared workflow-pack resolver", () => {
  const REPO_ROOT = join(HERE, "..", "..", "..");

  for (const name of ["produce-video", "research-first", "review-cut", "scene-assets"]) {
    describe(name, () => {
      test("resolveWorkflowScript finds it as a package-workflows pack", () => {
        const resolved = resolveWorkflowScript(name, { cwd: REPO_ROOT });
        expect(resolved.source).toBe("package-workflows");
        expect(resolved.pack?.manifest.name).toBe(name);
        expect(resolved.pack?.manifest.entry).toBe("index.js");
      });

      test("runWorkflowScript dry-run parses and validates without executing", async () => {
        const receipt = await runWorkflowScript({ name, cwd: REPO_ROOT, dryRun: true });
        expect(receipt.dryRun).toBe(true);
        expect(receipt.meta.name).toBe(name);
        expect(receipt.source).toBe("package-workflows");
      });
    });
  }
});
```

No other part of the file changes — the imports (`resolveWorkflowScript`, `runWorkflowScript`, etc.) are already present from the pilot.

- [ ] **Step 2: Run the test and confirm it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-workflows.test.ts )`
Expected: PASS. 4 workflows × 2 structural tests + 4 workflows × 2 resolver/dry-run tests + 2 top-level tests = 18 tests total, all green.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/extensions/movie-workflows.test.ts
git commit -m "$(cat <<'EOF'
test(movie-director): generalize resolver + dry-run smoke test to all 4 packs

Now that research-first, review-cut, and produce-video are also
workflow-packs, generalize what was a scene-assets-only smoke test into
a loop over all 4 saved workflow names.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full-package regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full package test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS, 0 failures. Compare against the pre-this-plan baseline (702 pass / 8 skip / 0 fail, established after the scene-assets pilot merged) — expect additional passing tests from Task 4's expanded smoke-test loop (6 more: 3 newly-covered workflows × 2 resolver/dry-run tests), no fewer, no failures.

- [ ] **Step 2: Run the package typecheck**

Run: `bun run --cwd bun-apps/pi-agent-ext-movie-director typecheck`
Expected: the SAME pre-existing error set as before this plan started (the `TS1192`/cross-package noise already independently verified as unrelated to workflow-pack conversion) — just with `workflows/research-first` → `workflows/research-first/index`, `workflows/review-cut` → `workflows/review-cut/index`, and `workflows/produce-video` → `workflows/produce-video/index` in the three newly-affected error lines' module-path text. No new error categories, no fewer errors, no new files affected.

- [ ] **Step 3: If everything is green, this plan is complete — no commit needed for this task (verification only).**

## Self-review

**Spec coverage:** All 3 remaining workflows converted (Tasks 1-3), smoke test generalized (Task 4), full regression verified (Task 5). No requirement from the user's "convert the other three workflows too" is left uncovered.

**Placeholder scan:** No TBD/TODO; every code block is the actual file content to write, copied verbatim from the current repo state.

**Type consistency:** `DiscoveredWorkflow`, `discoverWorkflows`, `resolveWorkflowScript`, `runWorkflowScript`, `readManifest` — all reused exactly as already defined in `extensions/movie-workflows.test.ts` from the merged pilot; no new types introduced, no renaming.
