# movie-director gating hygiene (Spec B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make co-firing tool "sibling groups" impossible to break silently — de-duplicate movie-director's gating, add a repo-wide drift guard, and delete the dead `cost` prototype.

**Architecture:** `tool-gate` groups tools into co-firing families by *fingerprint equality* over their owner-declared `gating` (sorted keywords + sorted `requires.nouns`/`.verbs`). Membership is maintained by copy-paste, so an edit to one member silently ejects it from its family. This plan (a) collapses movie's two copies into one shared object, (b) adds a test-time guard that flags any two distinct fingerprint groups sharing more than half the smaller group's keywords, and (c) removes dead scaffolding. The guard reuses `tool-gate`'s own `gateGatingKey` so the guard's notion of a group can never drift from the runtime's.

**Tech Stack:** TypeScript, Bun (`bun test`), TypeBox. Bun workspace root is `bun-apps/`.

**Spec:** `.planning/specs/2026-08-10-movie-director-gating-hygiene-design.md`

**Shell rule:** never top-level `cd` (blocked by `no-cd-drift.sh`). Use `( cd <dir> && … )`.

---

## Baseline first

Before Task 1, record the pre-change baseline so the known-unrelated red can be
compared item-by-item at the end.

- [ ] **Step 1: Capture the baseline**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test 2>&1 | tail -5 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-movie-director && bun test 2>&1 | tail -5 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-cli && bun test 2>&1 | tail -5 )
```

Expected: pass/fail counts recorded. Known-unrelated red as of 2026-08-10:
`file2md` 34 failures, `wayfind` 1, `hermes-memory` 1 — those are in *other*
packages and must not be "fixed" here. The three packages above should be green;
if any is red at baseline, note the exact count before changing anything.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `bun-apps/pi-agent-ext-movie-director/extensions/movie-director.ts` | registers `movie` + `movie_help` | modify — one shared `MOVIE_GATING` |
| `bun-apps/pi-agent-ext-movie-director/extensions/movie-director.test.ts` | extension wiring tests | modify — add shared-reference test |
| `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts` | command table + routing description | modify — correct stale comment |
| `bun-apps/pi-agent-ext-movie-director/extensions/movie-director-cost.ts` | dead `cost` extension | **delete** |
| `bun-apps/pi-agent-ext-movie-director/extensions/movie-director-cost.test.ts` | its tests | **delete** |
| `bun-apps/pi-agent-ext-movie-director/src/cost-dispatch.ts` | its typed schema | **delete** |
| `bun-apps/pi-agent-cli/src/commands/schema-cost.ts` | schema-cost canary | modify — drop the dead NOTE |
| `bun-apps/pi-agent-cli/src/__tests__/schema-cost.test.ts` | canary tests | modify — drop the dead assertion |
| `bun-apps/pi-agent-ext-tool-gate/qa/savings.ts` | savings report | modify — drop the stale reference |
| `bun-apps/pi-agent-ext-tool-gate/extensions/migrated-extensions.ts` | **new** — the enumeration substrate (`MIGRATED_EXTENSIONS`, `captureRegisteredTools`, types) | **create** |
| `bun-apps/pi-agent-ext-tool-gate/extensions/drift-guard.test.ts` | per-tool valid-gating net | modify — import the substrate; fix stale exemption |
| `bun-apps/pi-agent-ext-tool-gate/extensions/gating-siblings.test.ts` | **new** — sibling-group drift guard | **create** |
| `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` | gate engine | modify — export `gateGatingKey` |

---

### Task 1: One shared gating object for `movie` + `movie_help`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/extensions/movie-director.ts:40-59` and `:86-101`
- Test: `bun-apps/pi-agent-ext-movie-director/extensions/movie-director.test.ts`

Context: the two tools declare byte-identical 16-keyword / 10-noun / 11-verb
literals. Sharing one *object reference* is safe — verified that no consumer
mutates `gating` in place (`tool-gate.ts:89-90` builds a new object via spread,
and only for `BUILTIN_CORE` names, which excludes `movie`/`movie_help`).

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("pi-movie-director extension", …)` block in
`extensions/movie-director.test.ts`:

```ts
  test("movie and movie_help share ONE gating object (cannot drift apart)", () => {
    const movie = captureTool("movie");
    const help = captureTool("movie_help");
    // Same reference, not merely deep-equal: co-firing is decided by fingerprint
    // equality in tool-gate (gatesWithSameGating), and two separate literals can
    // be edited apart with no signal. One object makes that impossible.
    expect(movie.gating).toBe(help.gating);
  });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-movie-director && bun test extensions/movie-director.test.ts 2>&1 | tail -20 )
```

Expected: FAIL — the two literals are deep-equal but are different objects.

- [ ] **Step 3: Extract the shared constant**

In `extensions/movie-director.ts`, insert this above `function makeMovieTool()`
(i.e. before line 35):

> **Correction (2026-08-10, post-implementation).** The doc comment prescribed
> below cites `reconstructOwnerDeclaredGates` collapsing the pair into one
> multi-name gate. That function does not exist anywhere in the repo, and
> `buildEffectiveGates` emits one single-name gate per tool — nothing collapses.
> The phantom was inherited from the comment this task replaced and was carried
> forward here by mistake. The shipped comment states the real mechanism
> (identical gating → identical `gateGatingKey` fingerprint → `gatesWithSameGating`
> treats them as one co-firing family). Read the shipped file, not the block below,
> for the accurate wording.

```ts
/**
 * Owner-declared gating for the movie-director family — ONE object shared by
 * `movie` and `movie_help`.
 *
 * Migrated from tool-gate's hardcoded GATES (the {names:["movie","movie_help"]}
 * gate). tool-gate groups co-firing tools by FINGERPRINT EQUALITY over this
 * object (gatesWithSameGating), so the two names must declare an identical
 * gating for reconstructOwnerDeclaredGates to collapse them back into one
 * multi-name gate (names[0] === "movie"). Sharing one object — rather than two
 * copies — is what makes an edit to one side impossible.
 *
 * Keywords cover the unambiguous montage/storyboard/分鏡/導演/film phrases; the
 * noun∧verb `requires` path mirrors flux2/ltx so keyword-free paraphrases
 * (assemble clips / cut footage / 剪片段) also reach the gate (gate-recall
 * adversarial floor 0.9 — see __GATE_PROBES__ below).
 *
 * Safe to share by reference: no consumer mutates `gating` in place
 * (tool-gate's injectBuiltinCore spreads into a NEW object, and only for
 * BUILTIN_CORE names, which excludes movie/movie_help).
 */
const MOVIE_GATING = {
  keywords: [
    "montage", "preflight", "storyboard", "分鏡", "剪輯",
    "影片製作", "導演", "make a movie", "make a film", "movie director",
    "compose video", "compose scene", "電影製作",
    "short film", "into a film", "scenes into",
  ],
  requires: {
    nouns: ["clip", "clips", "footage", "scene", "scenes", "sequence", "片段", "畫面", "作品", "影片"],
    verbs: ["assemble", "compose", "direct", "cut", "orchestrate", "edit", "stitch", "剪", "編排", "組裝", "製作"],
  },
};
```

Then in `makeMovieTool()` replace the whole comment block + `gating: { … }`
literal (lines 40-59) with:

```ts
    gating: MOVIE_GATING,
```

And in `makeMovieHelpTool()` replace the comment block + `gating: { … }` literal
(lines 86-101) with:

```ts
    gating: MOVIE_GATING,
```

- [ ] **Step 4: Run the package tests**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-movie-director && bun test 2>&1 | tail -10 )
```

Expected: PASS, including the new test and the existing gating/probe tests.

- [ ] **Step 5: Confirm the runtime content is unchanged**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test 2>&1 | tail -10 )
```

Expected: PASS — drift-guard still sees valid non-dead gating for both names,
and the reconstructed gate still has `names[0] === "movie"`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/extensions/movie-director.ts bun-apps/pi-agent-ext-movie-director/extensions/movie-director.test.ts
git commit -m "refactor(movie-director): share ONE gating object between movie and movie_help"
```

---

### Task 2: Correct the stale schema-cost comment

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts:316-322`

No test: this is a comment whose claim was refuted by measurement during Spec A.

- [ ] **Step 1: Replace the doc comment**

Replace lines 316-322 (the block starting `/**` and ending with the
`≥30% top-3 schema-cost reduction …` line) with:

```ts
/**
 * Slim routing description for the `movie` tool. The heavy per-command reference
 * (option keys, defaults, worked examples) lives in `movie_help` and is fetched
 * on demand — the same dispatcher/help-tool split flux2/ltx/krea2/workflow use.
 *
 * Keep it short because the dispatcher/help split is what keeps the full command
 * reference OUT of the always-loaded schema — NOT because `movie` is expensive.
 * An earlier version of this comment claimed movie "is consistently the #1
 * schema-cost tool"; that was true only before the routing-description
 * reduction. Measured 2026-08-10: `movie` = 371 tok (rank ~25), `movie_help` =
 * 83 tok, together 2.1% of the 21,124-tok total — and BOTH are gated, so their
 * cost at rest is zero. Do not spend effort shrinking them further; the standing
 * schema-cost tax is the always-active core set (10,113 tok/req), none of which
 * is movie-director's.
 */
```

- [ ] **Step 2: Run the package tests**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-movie-director && bun test 2>&1 | tail -5 )
```

Expected: PASS (comment-only change).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/dispatch.ts
git commit -m "docs(movie-director): correct the stale '#1 schema-cost tool' claim with measured figures"
```

---

### Task 3: Delete the dead `cost` prototype and its scaffolding

**Files:**
- Delete: `bun-apps/pi-agent-ext-movie-director/extensions/movie-director-cost.ts`
- Delete: `bun-apps/pi-agent-ext-movie-director/extensions/movie-director-cost.test.ts`
- Delete: `bun-apps/pi-agent-ext-movie-director/src/cost-dispatch.ts`
- Modify: `bun-apps/pi-agent-cli/src/commands/schema-cost.ts:143-149`
- Modify: `bun-apps/pi-agent-cli/src/__tests__/schema-cost.test.ts:219-224`
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/savings.ts:115-124`

Context: `cost` is absent from `run-dir/manifest.json`, absent from
`static-extensions.ts`, and not imported by `movie-director.ts` — confirmed not
loaded at runtime. CLAUDE.md allows exactly one registered extension per
`pi-agent-ext-<X>/` folder, so this file can never be wired as-is. `movie`
already exposes `cost-estimate` / `-reserve` / `-reconcile` / `-snapshot`, which
delegate to `src/cost.ts` — **`src/cost.ts` stays**; only the typed prototype goes.

- [ ] **Step 1: Prove nothing else imports the prototype**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps && grep -rn "cost-dispatch\|movie-director-cost" --include='*.ts' --include='*.json' --exclude-dir=node_modules . )
```

Expected: hits ONLY in the three files to delete plus the three scaffolding
sites listed above. If anything else appears, stop and report — do not delete.

- [ ] **Step 2: Delete the three files**

```bash
git rm bun-apps/pi-agent-ext-movie-director/extensions/movie-director-cost.ts \
       bun-apps/pi-agent-ext-movie-director/extensions/movie-director-cost.test.ts \
       bun-apps/pi-agent-ext-movie-director/src/cost-dispatch.ts
```

- [ ] **Step 3: Remove the dead canary NOTE**

In `bun-apps/pi-agent-cli/src/commands/schema-cost.ts`, delete the 6-line
`// NOTE (audit 2026-07-25): …` block (lines 143-148) that sits directly above
`const EXTRA_ENTRIES`, and replace it with:

```ts
// Empty today. The movie-director-cost prototype that once lived here was
// deleted (2026-08-10): measuring an extension offline while it never loads is
// what let a phantom `cost` gate inflate savings by ~536 tok/req.
```

Leave `const EXTRA_ENTRIES: { source: string; path: string }[] = [];` unchanged.

- [ ] **Step 4: Remove the dead canary assertion**

In `bun-apps/pi-agent-cli/src/__tests__/schema-cost.test.ts`, delete these 6
lines (the comment block plus the assertion) from the
`"covers every manifest extension and every static extension"` test:

```ts
		// movie-director-cost is NOT captured: it's a non-runtime PROTOTYPE
		// (absent from manifest + static-extensions + movie-director.ts imports).
		// Capturing it via EXTRA_ENTRIES inflated savings by ~536 tok (audit
		// P0①, 2026-07-25). Do NOT re-add until movie-director-cost.ts is wired
		// to load at runtime.
		expect(sources.has("movie-director-cost")).toBe(false);
```

The two `for (const s of [...]) expect(sources.has(s)).toBe(true);` loops above
it stay unchanged.

- [ ] **Step 5: Correct the stale reference in savings.ts**

In `bun-apps/pi-agent-ext-tool-gate/qa/savings.ts`, replace the trailing clause
of the `gateMissing` doc comment — the text
`+ locked by the movie-director-cost test.` (line 123) — with:

```
	 *  the manifest is the load truth).
```

so the sentence ends at the manifest clause. Do not touch the `gateMissing`
declaration itself.

- [ ] **Step 6: Run all three affected packages**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-movie-director && bun test 2>&1 | tail -5 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-cli && bun test 2>&1 | tail -5 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test 2>&1 | tail -5 )
```

Expected: PASS in all three. The movie-director count drops by the 3 deleted
`cost` tests.

- [ ] **Step 7: Commit**

```bash
git add -A bun-apps/pi-agent-ext-movie-director bun-apps/pi-agent-cli bun-apps/pi-agent-ext-tool-gate
git commit -m "refactor(movie-director): delete the never-loaded cost prototype and its scaffolding"
```

---

### Task 4: Extract the enumeration substrate out of the test file

**Files:**
- Create: `bun-apps/pi-agent-ext-tool-gate/extensions/migrated-extensions.ts`
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/drift-guard.test.ts`

Context — **why this is required, not cosmetic**: `MIGRATED_EXTENSIONS` and
`captureRegisteredTools` currently live inside `drift-guard.test.ts`. Importing
that file from another test file was measured to **re-execute its 27 tests**
inside the importer. The new guard in Task 5 therefore cannot import it. No file
outside `drift-guard.test.ts` consumes these exports today (verified by grep), so
the move is safe and needs no re-export shim.

- [ ] **Step 1: Create the module**

Create `bun-apps/pi-agent-ext-tool-gate/extensions/migrated-extensions.ts` and
**move into it, unchanged**, from `drift-guard.test.ts`:

1. every `import` at the top of the file EXCEPT `import { describe, expect, test } from "bun:test";`
2. the `type ToolDef = { … }` declaration — change it to `export type ToolDef = { … }`
3. the `export interface MigratedExtension { … }` declaration, with its full doc comment
4. the `export const MIGRATED_EXTENSIONS: MigratedExtension[] = [ … ];` array, with its full doc comment
5. the `function captureRegisteredTools(…)` definition, with its full doc comment — change it to `export function captureRegisteredTools(…)`

Give the new file this header:

```ts
/**
 * migrated-extensions — the enumeration substrate shared by tool-gate's gating
 * guards.
 *
 * Holds the MIGRATED_EXTENSIONS source of truth plus the capturing-`pi` helper
 * that turns an extension's registrar into the exact tool defs a live session
 * would see. Lives in a NON-test module on purpose: importing a `.test.ts` from
 * another `.test.ts` re-executes the imported file's suites inside the importer
 * (measured: drift-guard's 27 tests ran twice), so any second guard that needs
 * this enumeration must import it from here.
 *
 * Consumers: drift-guard.test.ts (per-tool valid-gating net),
 * gating-siblings.test.ts (sibling-group drift guard).
 */
```

- [ ] **Step 2: Point drift-guard.test.ts at the module**

In `drift-guard.test.ts`, delete everything the previous step moved out, and
leave the `bun:test` import in place. Add directly beneath it:

```ts
import {
	MIGRATED_EXTENSIONS,
	captureRegisteredTools,
	type MigratedExtension,
	type ToolDef,
} from "./migrated-extensions.ts";
```

Keep `validateGating`, `assertAllValid`, `runDriftGuardNet`, `entry`, and every
`describe`/`test` block exactly as they are — they now consume the imported
symbols.

- [ ] **Step 3: Run the package and confirm the count is IDENTICAL**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test 2>&1 | tail -8 )
```

Expected: PASS with the **same** test count as the baseline. A pure move must
not change the number of tests; a different count means a suite was dropped or
duplicated — stop and fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/migrated-extensions.ts bun-apps/pi-agent-ext-tool-gate/extensions/drift-guard.test.ts
git commit -m "refactor(tool-gate): extract MIGRATED_EXTENSIONS into a non-test module"
```

---

### Task 5: Sibling-group drift guard

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts:330`
- Create: `bun-apps/pi-agent-ext-tool-gate/extensions/gating-siblings.test.ts`

The guard reuses `tool-gate`'s own `gateGatingKey` so its notion of a "group"
can never drift from the runtime's — reimplementing the fingerprint would
recreate exactly the class of bug this guard exists to catch.

- [ ] **Step 1: Export `gateGatingKey`**

In `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` line 330, change:

```ts
function gateGatingKey(gate: ToolGate): string {
```

to:

```ts
export function gateGatingKey(gate: ToolGate): string {
```

Nothing else changes; `gatesWithSameGating` keeps calling it as before.

- [ ] **Step 2: Write the guard, failing negative case first**

Create `bun-apps/pi-agent-ext-tool-gate/extensions/gating-siblings.test.ts`:

```ts
/**
 * gating-siblings — the sibling-group drift guard.
 *
 * tool-gate groups co-firing tools into FAMILIES by fingerprint equality over
 * their owner-declared gating (gatesWithSameGating → gateGatingKey). Family
 * membership is maintained by copy-paste: the same keyword literal is repeated
 * once per member, sometimes across package boundaries (workflow/workflow_help/
 * workflow_control live in pi-agent-ext-workflow; subagent/subagents live in
 * pi-agent-ext-subagent — five members, one literal). Editing ONE member ejects
 * it from its family with no type error, no test failure, and no runtime
 * warning; the only symptom is a tool that stops appearing when the user
 * expects it.
 *
 * The guard: group every non-core gate by fingerprint, then assert that no two
 * DISTINCT groups share more than half of the smaller group's keywords.
 *
 *   cover(A,B) = |A ∩ B| / min(|A|, |B|)   must be < 0.5
 *
 * Calibration (measured 2026-08-10 over 29 non-core gated tools in 10 groups):
 * the overlap distribution is strictly BIMODAL — every overlapping pair is
 * fingerprint-identical (cover 1.000) and every cross-group pair shares ZERO
 * keywords. So the guard is green at 0 violations today with wide margin.
 *
 * Why 0.5 and not "any overlap fails": an editing accident leaves the two sides
 * near-identical (drop one of movie's 16 keywords → 15 shared → cover 0.94),
 * which 0.5 catches easily, while leaving room for two genuinely unrelated
 * gates to share a word or two in future without needing an exemption.
 *
 * Core gates (gating:{core:true}) are excluded: they carry no keywords and are
 * always active, so they have no family to drift out of.
 */
import { describe, expect, test } from "bun:test";
import { MIGRATED_EXTENSIONS, captureRegisteredTools, type ToolDef } from "./migrated-extensions.ts";
import { gateGatingKey } from "./tool-gate.ts";

/** One captured non-core gate, reduced to what the guard compares. */
export interface GateRow {
	tool: string;
	ext: string;
	keywords: string[];
	fingerprint: string;
}

/**
 * Fingerprint a tool def's gating using tool-gate's OWN gateGatingKey, by
 * adapting the def into the minimal ToolGate shape that function reads
 * (`names` and `description` are ignored by it).
 *
 * Normalizing `requires` is deliberate, not incidental: ToolGate's CoOccurrence
 * declares `nouns`/`verbs` as REQUIRED string[], while a captured def types them
 * as optional unknown[]. Passing `undefined` through when the def has no
 * `requires` matches gateGatingKey's own `requires ? … : null` branch, so a
 * gate with no co-occurrence fingerprints the same here as it does at runtime.
 */
export function fingerprintOf(def: ToolDef): string {
	const g = def.gating ?? {};
	const req = g.requires;
	return gateGatingKey({
		names: [def.name ?? "<anonymous>"],
		description: "",
		keywords: g.keywords ?? [],
		requires: req
			? { nouns: (req.nouns ?? []) as string[], verbs: (req.verbs ?? []) as string[] }
			: undefined,
	});
}

/** Every non-core gated tool registered by every migrated extension. */
export function collectGateRows(extensions: typeof MIGRATED_EXTENSIONS): GateRow[] {
	const rows: GateRow[] = [];
	for (const ext of extensions) {
		for (const def of captureRegisteredTools(ext.register)) {
			const g = def.gating;
			if (!g || g.core === true) continue;
			rows.push({
				tool: def.name ?? "<anonymous>",
				ext: ext.name,
				keywords: [...(g.keywords ?? [])],
				fingerprint: fingerprintOf(def),
			});
		}
	}
	return rows;
}

/** Shared keywords / size of the smaller keyword set. 0 when either side is empty. */
export function cover(a: string[], b: string[]): number {
	const A = new Set(a);
	const B = new Set(b);
	const smaller = Math.min(A.size, B.size);
	if (smaller === 0) return 0;
	let shared = 0;
	for (const k of A) if (B.has(k)) shared++;
	return shared / smaller;
}

export interface SiblingViolation {
	a: GateRow;
	b: GateRow;
	cover: number;
}

/**
 * Every pair of rows from DIFFERENT fingerprint groups whose keyword cover
 * reaches `threshold` — i.e. two tools that look like siblings but will not
 * co-fire. Pure.
 */
export function findSiblingDrift(rows: GateRow[], threshold = 0.5): SiblingViolation[] {
	const out: SiblingViolation[] = [];
	for (let i = 0; i < rows.length; i++) {
		for (let j = i + 1; j < rows.length; j++) {
			const a = rows[i]!;
			const b = rows[j]!;
			if (a.fingerprint === b.fingerprint) continue; // same family — fine
			const c = cover(a.keywords, b.keywords);
			if (c >= threshold) out.push({ a, b, cover: c });
		}
	}
	return out;
}

describe("gating-siblings — the guard itself is not vacuous", () => {
	test("flags two near-identical gates that are NOT fingerprint-equal", () => {
		// The exact Spec B failure mode: movie's 16 keywords, minus one on the
		// help side. 15 shared / min(16,15) = 1.0 → far above threshold.
		const kws = [
			"montage", "preflight", "storyboard", "分鏡", "剪輯",
			"影片製作", "導演", "make a movie", "make a film", "movie director",
			"compose video", "compose scene", "電影製作",
			"short film", "into a film", "scenes into",
		];
		const rows: GateRow[] = [
			{ tool: "movie", ext: "x", keywords: kws, fingerprint: "FP-A" },
			{ tool: "movie_help", ext: "x", keywords: kws.slice(0, 15), fingerprint: "FP-B" },
		];
		const found = findSiblingDrift(rows);
		expect(found.length).toBe(1);
		expect(found[0]!.cover).toBeGreaterThanOrEqual(0.5);
	});

	test("does NOT flag a real sibling pair (same fingerprint, full overlap)", () => {
		const kws = ["workflow", "pipeline", "orchestrate"];
		const rows: GateRow[] = [
			{ tool: "workflow", ext: "w", keywords: kws, fingerprint: "FP-SAME" },
			{ tool: "workflow_help", ext: "w", keywords: kws, fingerprint: "FP-SAME" },
		];
		expect(findSiblingDrift(rows)).toEqual([]);
	});

	test("does NOT flag unrelated gates sharing one incidental keyword", () => {
		const rows: GateRow[] = [
			{ tool: "alpha", ext: "a", keywords: ["video", "a2", "a3", "a4"], fingerprint: "FP-1" },
			{ tool: "beta", ext: "b", keywords: ["video", "b2", "b3", "b4"], fingerprint: "FP-2" },
		];
		// cover = 1/4 = 0.25 < 0.5
		expect(findSiblingDrift(rows)).toEqual([]);
	});
});

describe("gating-siblings — the live repo has no sibling drift", () => {
	test("no two distinct fingerprint groups share ≥50% of the smaller group's keywords", () => {
		const rows = collectGateRows(MIGRATED_EXTENSIONS);
		// Non-vacuous: the capture must actually have found the known families.
		expect(rows.length, "capture must be non-empty (else the guard passes vacuously)").toBeGreaterThan(20);
		const names = new Set(rows.map((r) => r.tool));
		for (const n of ["movie", "movie_help", "workflow", "subagent"]) {
			expect(names.has(n), `expected '${n}' in the captured non-core gate set`).toBe(true);
		}

		const violations = findSiblingDrift(rows);
		const detail = violations
			.map(
				(v) =>
					`  ${v.a.tool} (${v.a.ext}) vs ${v.b.tool} (${v.b.ext}) — cover ${v.cover.toFixed(2)}; ` +
					`these look like siblings but have DIFFERENT gating fingerprints, so they will NOT co-fire. ` +
					`Either make their gating identical (share ONE object) or make them genuinely distinct.`,
			)
			.join("\n");
		expect(violations.length, violations.length ? `sibling-group drift detected:\n${detail}` : "").toBe(0);
	});

	test("movie and movie_help are in the SAME fingerprint group", () => {
		const rows = collectGateRows(MIGRATED_EXTENSIONS);
		const movie = rows.find((r) => r.tool === "movie");
		const help = rows.find((r) => r.tool === "movie_help");
		expect(movie).toBeDefined();
		expect(help).toBeDefined();
		expect(movie!.fingerprint).toBe(help!.fingerprint);
	});
});
```

- [ ] **Step 3: Run the new guard**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test extensions/gating-siblings.test.ts 2>&1 | tail -20 )
```

Expected: PASS, 5 tests. The three "not vacuous" tests prove the detector fires
on the real failure shape and stays quiet on both legitimate shapes; the two
live-repo tests prove today's repo is clean.

If the live-repo test FAILS, do not weaken the threshold — read the reported
pair and fix the real drift, or report it.

- [ ] **Step 4: Run the whole package**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test 2>&1 | tail -8 )
```

Expected: PASS. Count = baseline + 5.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/gating-siblings.test.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts
git commit -m "test(tool-gate): guard against co-firing sibling groups drifting apart"
```

---

### Task 6: Correct the stale `ungatedByDesign` exemption

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/migrated-extensions.ts` (the `subagent` entry moved there in Task 4)

Context: the entry exempts `subagents` as "UNGATED before this migration and
stays ungated to preserve behavior". That is now false —
`pi-agent-ext-subagent/src/subagents-tool.ts:216` declares the workflow family's
gating. The exemption suppresses validation of a tool that IS gated and
documents the opposite of reality. `subagent_runs` genuinely has no gating, so
its exemption is correct and stays.

- [ ] **Step 1: Confirm the current reality before changing anything**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps && grep -n "gating" -B 6 pi-agent-ext-subagent/src/subagents-tool.ts | head -20 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps && grep -n "gating" pi-agent-ext-subagent/src/subagent-runs-tool.ts )
```

Expected: `subagents-tool.ts` shows a real `gating: { keywords: [...] }`;
`subagent-runs-tool.ts` shows no `gating` at all. If either differs from that,
stop and report — the fix below assumes exactly this state.

- [ ] **Step 2: Narrow the exemption to `subagent_runs`**

In `migrated-extensions.ts`, in the `subagent` entry, replace:

```ts
		ungatedByDesign: ["subagent_runs", "subagents"],
```

with:

```ts
		ungatedByDesign: ["subagent_runs"],
```

and replace that entry's doc comment with:

```ts
	{
		// ticket 10 — `subagent`, plus `subagents` (plural), which has SINCE been
		// given the workflow family's gating (subagents-tool.ts) and is therefore
		// validated by the net like any other gated tool. It was exempted here
		// while it was still always-on; that exemption was stale and was removed
		// 2026-08-10 (it was suppressing validation of a tool that IS gated).
		// `subagent_runs` genuinely declares no gating and stays exempt — the typo
		// guard in runDriftGuardNet fails loudly if it is ever renamed or removed.
```

- [ ] **Step 3: Run the package**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test 2>&1 | tail -8 )
```

Expected: PASS. `subagents` now flows through `validateGating`, which it
satisfies (7 non-empty keywords → not a dead gate).

- [ ] **Step 4: Run the subagent package too**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-subagent && bun test 2>&1 | tail -8 )
```

Note: this package's `test` script is `bun run check && bun run build && bun run test:unit`,
so it typechecks and builds as well. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/migrated-extensions.ts
git commit -m "fix(tool-gate): stop exempting subagents from the drift-guard — it is gated now"
```

---

### Task 7: Full verification and baseline comparison

**Files:** none modified.

- [ ] **Step 1: Run every affected package**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate && bun test 2>&1 | tail -6 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-movie-director && bun test 2>&1 | tail -6 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-subagent && bun test 2>&1 | tail -6 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-cli && bun test 2>&1 | tail -6 )
```

Expected: all four green.

- [ ] **Step 2: Run the schema-cost canary after the `cost` deletion**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-cli && bun test src/__tests__/schema-cost.test.ts 2>&1 | tail -12 )
```

Expected: PASS — every manifest + static extension is still discovered, and the
now-deleted prototype is no longer referenced.

- [ ] **Step 3: Compare the known-unrelated red against baseline**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-file2md && bun test 2>&1 | tail -4 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-wayfind && bun test 2>&1 | tail -4 )
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-hermes-memory && bun test 2>&1 | tail -4 )
```

Expected: exactly the pre-existing counts (file2md 34, wayfind 1,
hermes-memory 1). Report the numbers explicitly — do NOT fix them in this
branch, and do NOT claim green if they moved.

- [ ] **Step 4: Confirm the working tree holds only intended changes**

```bash
git status --porcelain
git log --oneline origin/main..HEAD
```

Expected: clean tree; 7 commits (spec + 6 task commits).

---

## Self-review notes

- Spec Unit 1 → Task 1. Unit 2 → Task 3. Unit 3 → Tasks 4 + 5. Unit 4 → Task 6.
  Unit 5 → Task 2. Spec's "negative case proving the guard is not vacuous" →
  Task 5 Step 2, three dedicated tests.
- Names used consistently across tasks: `MOVIE_GATING`, `MIGRATED_EXTENSIONS`,
  `captureRegisteredTools`, `gateGatingKey`, `fingerprintOf`, `collectGateRows`,
  `cover`, `findSiblingDrift`, `GateRow`, `SiblingViolation`.
- The spec's "re-export `MIGRATED_EXTENSIONS` from drift-guard.test.ts for
  existing consumers" was dropped: a grep proved there are none, so the
  re-export would be dead code (YAGNI).
