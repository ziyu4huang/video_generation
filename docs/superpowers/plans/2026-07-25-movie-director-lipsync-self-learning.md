# movie-director Lipsync Self-Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `evaluate-lipsync` command to `pi-agent-ext-movie-director`
that scores an already-produced talking-head video's mouth-motion-vs-audio
correlation (via `python -m app.lipsync_metrics`) and returns a structured
`lesson` the agent persists through hermes-memory's existing `memory` tool —
closing the loop so future lipdub generations can consult past ones instead of
re-discovering the same failure modes from scratch.

**Architecture:** Two new pure/thin modules
(`runpy_lipsync.ts` — spawn + JSON parse; `lipsync-lesson.ts` — pure lesson
builder) wired into one new `dispatch.ts` case (`evaluate-lipsync`), which is
then reachable through the `movie` tool, `movie_help`, and the CLI for free.
No changes to `pi-agent-ext-hermes-memory`.

**Tech Stack:** Bun/TypeScript (`pi-agent-ext-movie-director`), spawns the
existing `python/venv` interpreter against `python/mlx-movie-director/app/lipsync_metrics.py`
(already implemented, unmodified in this plan).

**Spec:** `docs/superpowers/specs/2026-07-25-movie-director-lipsync-self-learning-design.md`

---

### Task 1: `runpy_lipsync.ts` — the `app.lipsync_metrics` spawn adapter

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.test.ts
import { describe, expect, it } from "bun:test";
import { runPyLipsync } from "./runpy_lipsync.ts";

describe("runPyLipsync — spawn injection (no venv)", () => {
  it("ok=true with parsed metrics on exit 0 + valid JSON stdout", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({
        stdout: JSON.stringify({
          verdict: "adequate",
          pearson_r: 0.55,
          mouth_ratio_std: 0.05,
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.metrics?.verdict).toBe("adequate");
    expect(result.metrics?.pearson_r).toBe(0.55);
    expect(result.metrics?.mouth_ratio_std).toBe(0.05);
    expect(result.error).toBeNull();
  });

  it("ok=true and preserves an optional caveat field", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({
        stdout: JSON.stringify({
          verdict: "inadequate",
          pearson_r: -0.35,
          mouth_ratio_std: 0.018,
          caveat: "pearson_r is strongly negative — anti-phase, not genuine lip-sync.",
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.metrics?.caveat).toContain("anti-phase");
  });

  it("ok=false on non-zero exit code", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({ stdout: "", stderr: "Traceback...", exitCode: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("exited 1");
    expect(result.stderrTail).toContain("Traceback");
  });

  it("ok=false on malformed JSON stdout", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({ stdout: "not json", stderr: "", exitCode: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("non-JSON");
  });

  it("ok=false when the spawn itself throws", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => {
        throw new Error("ENOENT: python not found");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("ENOENT");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/runpy_lipsync.test.ts )`
Expected: FAIL with "Cannot find module './runpy_lipsync.ts'" (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts
/**
 * runpy_lipsync.ts — the `python -m app.lipsync_metrics` adapter (mouth-motion
 * vs. audio-loudness correlation for a talking-head video).
 *
 * `lipsync_metrics.py` is a MODULE, not a run.py subcommand (its own
 * `__main__` block: `python -m app.lipsync_metrics <mp4_path>`, printing
 * `json.dumps(result, indent=2)` to stdout) — so this spawns the venv python
 * directly with `-m`, from `python/mlx-movie-director` as cwd (required for
 * the `app.` import to resolve), rather than going through run.py like
 * runpy_tts.ts / runpy_image.ts do.
 *
 * Unlike runpy_tts's best-effort posture (which protects an already-succeeded
 * generation), evaluation IS the point here — callers get a real {ok, error}
 * on any failure, nothing is swallowed at this layer.
 */
import { join } from "node:path";
import { resolveRepoRoot, resolveRunPyPaths } from "@repo/pi-agent-ext-ltx";

export interface LipsyncMetrics {
  verdict: string;
  pearson_r: number | null;
  mouth_ratio_std: number | null;
  caveat?: string;
}

export interface RunPyLipsyncInput {
  videoPath: string;
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive
   * runPyLipsync without the MLX venv. The real path resolves the venv
   * python and spawns `python -m app.lipsync_metrics <videoPath>` from
   * python/mlx-movie-director.
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RunPyLipsyncOutput {
  ok: boolean;
  metrics: LipsyncMetrics | null;
  error: string | null;
  stderrTail: string;
}

async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const repoRoot = resolveRepoRoot();
  const { python } = resolveRunPyPaths(repoRoot);
  const cwd = join(repoRoot, "python", "mlx-movie-director");
  const proc = Bun.spawn({
    cmd: [python, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run `python -m app.lipsync_metrics <videoPath>` and parse its JSON stdout. */
export async function runPyLipsync(input: RunPyLipsyncInput): Promise<RunPyLipsyncOutput> {
  const args = ["-m", "app.lipsync_metrics", input.videoPath];
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync_metrics spawn failed: ${msg}`, stderrTail: "" };
  }

  const stderrTail = res.stderr.slice(-2000);
  if (res.exitCode !== 0) {
    return { ok: false, metrics: null, error: `lipsync_metrics exited ${res.exitCode}`, stderrTail };
  }

  try {
    const metrics = JSON.parse(res.stdout) as LipsyncMetrics;
    return { ok: true, metrics, error: null, stderrTail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync_metrics produced non-JSON stdout: ${msg}`, stderrTail };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/runpy_lipsync.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun run check )`
Expected: no errors.

```bash
git add bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.test.ts
git commit -m "feat(pi-agent-ext-movie-director): add app.lipsync_metrics spawn adapter"
```

---

### Task 2: `lipsync-lesson.ts` — pure lesson builder

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.test.ts
import { describe, expect, test } from "bun:test";
import { buildLipsyncLesson } from "./lipsync-lesson.ts";

describe("buildLipsyncLesson", () => {
  test("adequate verdict -> target=memory, category=insight", () => {
    const lesson = buildLipsyncLesson({
      verdict: "adequate",
      pearsonR: 0.55,
      mouthRatioStd: 0.056,
      seed: 501,
      promptSummary: "simple talking prompt",
      identityRef: "kai_source.png",
      voice: "am_michael",
    });
    expect(lesson.target).toBe("memory");
    expect(lesson.category).toBe("insight");
    expect(lesson.content).toContain("kai_source.png");
    expect(lesson.content).toContain("am_michael");
    expect(lesson.content).toContain("seed=501");
    expect(lesson.content).toContain("0.55");
    expect(lesson.reason).toBeUndefined();
  });

  test("inadequate verdict with a caveat -> target=failure, category=tool-quirk, reason=caveat", () => {
    const lesson = buildLipsyncLesson({
      verdict: "inadequate",
      pearsonR: -0.35,
      mouthRatioStd: 0.018,
      seed: 501,
      promptSummary: "simple talking prompt",
      identityRef: "kai_source.png",
      voice: "am_michael",
      caveat: "pearson_r is strongly negative — anti-phase, not genuine lip-sync.",
    });
    expect(lesson.target).toBe("failure");
    expect(lesson.category).toBe("tool-quirk");
    expect(lesson.reason).toBe("pearson_r is strongly negative — anti-phase, not genuine lip-sync.");
    expect(lesson.content).toContain("kai_source.png");
  });

  test("inadequate verdict with no caveat -> reason falls back to the verdict string", () => {
    const lesson = buildLipsyncLesson({
      verdict: "inadequate",
      pearsonR: 0.24,
      mouthRatioStd: 0.03,
      seed: 511,
      identityRef: "dov_source_v3.png",
      voice: "am_onyx",
    });
    expect(lesson.target).toBe("failure");
    expect(lesson.reason).toBe("verdict=inadequate");
  });

  test("missing optional fields (seed/promptSummary) still produce valid content", () => {
    const lesson = buildLipsyncLesson({
      verdict: "adequate",
      pearsonR: 0.5,
      mouthRatioStd: 0.04,
      identityRef: "dov_source_v3.png",
      voice: "am_onyx",
    });
    expect(lesson.content).toContain("dov_source_v3.png");
    expect(lesson.content).not.toContain("seed=undefined");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/lipsync-lesson.test.ts )`
Expected: FAIL with "Cannot find module './lipsync-lesson.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.ts
/**
 * lipsync-lesson.ts — builds a structured lesson from a lipsync_metrics
 * verdict, shaped to map 1:1 onto hermes-memory's `memory` tool call
 * (`target`, `category`, `content`, `reason`). Pure: no I/O, no hermes-memory
 * dependency — the agent is the one that calls the memory tool, this module
 * only decides what to say.
 */
export interface LipsyncLesson {
  target: "failure" | "memory";
  category: "tool-quirk" | "insight";
  content: string;
  reason?: string;
}

export interface LipsyncLessonInput {
  verdict: string;
  pearsonR: number | null;
  mouthRatioStd: number | null;
  seed?: number;
  promptSummary?: string;
  identityRef?: string;
  voice?: string;
  caveat?: string;
}

export function buildLipsyncLesson(input: LipsyncLessonInput): LipsyncLesson {
  const who = [input.identityRef, input.voice].filter(Boolean).join(" / ") || "unknown identity";
  const params = [
    input.seed !== undefined ? `seed=${input.seed}` : null,
    input.promptSummary ? `prompt="${input.promptSummary}"` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const metrics = `pearson_r=${input.pearsonR ?? "n/a"}, mouth_ratio_std=${input.mouthRatioStd ?? "n/a"}`;
  const paramsSuffix = params ? ` (${params})` : "";

  if (input.verdict === "adequate") {
    return {
      target: "memory",
      category: "insight",
      content: `Lipdub combo works: ${who}${paramsSuffix} -> ${metrics}.`,
    };
  }

  return {
    target: "failure",
    category: "tool-quirk",
    content: `Lipdub combo fails: ${who}${paramsSuffix} -> ${metrics}.`,
    reason: input.caveat ?? `verdict=${input.verdict}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/lipsync-lesson.test.ts )`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun run check )`
Expected: no errors.

```bash
git add bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.ts bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.test.ts
git commit -m "feat(pi-agent-ext-movie-director): add pure lipsync lesson builder"
```

---

### Task 3: `evaluate-lipsync` dispatch command

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts:66-88` (COMMANDS array), `:302-286`-ish (COMMAND_REFERENCE — insert a new bullet), and the `dispatch()` switch (new case)
- Test: `bun-apps/pi-agent-ext-movie-director/src/commands.test.ts` (existing file, new `describe` block)

This task depends on Tasks 1 and 2 (imports `runPyLipsync` and `buildLipsyncLesson`).

- [ ] **Step 1: Write the failing tests**

Append to `bun-apps/pi-agent-ext-movie-director/src/commands.test.ts` (match
the file's existing tab indentation):

```ts
describe("evaluate-lipsync", () => {
	test("requires videoPath", async () => {
		const res = await dispatch("evaluate-lipsync", {});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain("videoPath");
	});

	test("adequate verdict -> lesson.target=memory", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{
				videoPath: "/fake/shot.mp4",
				seed: 501,
				identityRef: "kai_source.png",
				voice: "am_michael",
			},
			{
				runPyLipsyncImpl: async () => ({
					ok: true,
					metrics: { verdict: "adequate", pearson_r: 0.55, mouth_ratio_std: 0.056 },
					error: null,
					stderrTail: "",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.text);
		expect(parsed.lesson.target).toBe("memory");
		expect(parsed.lesson.category).toBe("insight");
		expect(parsed.metrics.verdict).toBe("adequate");
	});

	test("inadequate verdict -> lesson.target=failure", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{
				videoPath: "/fake/shot.mp4",
				seed: 601,
				identityRef: "dov_source_v3.png",
				voice: "am_onyx",
			},
			{
				runPyLipsyncImpl: async () => ({
					ok: true,
					metrics: {
						verdict: "inadequate",
						pearson_r: -0.35,
						mouth_ratio_std: 0.018,
						caveat: "anti-phase",
					},
					error: null,
					stderrTail: "",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.text);
		expect(parsed.lesson.target).toBe("failure");
		expect(parsed.lesson.reason).toBe("anti-phase");
	});

	test("propagates a runPyLipsync failure as {ok:false}", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{ videoPath: "/fake/shot.mp4" },
			{
				runPyLipsyncImpl: async () => ({
					ok: false,
					metrics: null,
					error: "lipsync_metrics exited 1",
					stderrTail: "Traceback...",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain("exited 1");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/commands.test.ts -t "evaluate-lipsync" )`
Expected: FAIL — `dispatch("evaluate-lipsync", ...)` returns `{ok: false, error: 'Unknown command...'}` (or a type error, since `"evaluate-lipsync"` isn't yet a valid `Command`).

- [ ] **Step 3: Add the command to `COMMANDS`**

In `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts`, replace:

```ts
/** The canonical 19 orchestration commands (also the CLI's command surface). */
export const COMMANDS = [
  "preflight",
  "pipeline-list",
  "pipeline-show",
  "init-project",
  "list-projects",
  "next-stage",
  "write-checkpoint",
  "read-checkpoint",
  "validate-artifact",
  "generate",
  "compose",
  "compose-remotion",
  "compose-motion",
  "pre-compose",
  "final-review",
  "cost-estimate",
  "cost-reserve",
  "cost-reconcile",
  "cost-snapshot",
  "read-decision-log",
  "run-pipeline",
  "run-waypoint",
] as const;
```

with:

```ts
/** The canonical 23 orchestration commands (also the CLI's command surface). */
export const COMMANDS = [
  "preflight",
  "pipeline-list",
  "pipeline-show",
  "init-project",
  "list-projects",
  "next-stage",
  "write-checkpoint",
  "read-checkpoint",
  "validate-artifact",
  "generate",
  "evaluate-lipsync",
  "compose",
  "compose-remotion",
  "compose-motion",
  "pre-compose",
  "final-review",
  "cost-estimate",
  "cost-reserve",
  "cost-reconcile",
  "cost-snapshot",
  "read-decision-log",
  "run-pipeline",
  "run-waypoint",
] as const;
```

(The "19" in the original comment was already stale — the array actually has
22 entries before this change; fixed to the correct post-change count of 23
while touching this line.)

- [ ] **Step 4: Add imports**

In `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts`, add near the other
leaf-module imports (after the `recordDecision` import, `dispatch.ts:50`):

```ts
import { runPyLipsync, type RunPyLipsyncInput, type RunPyLipsyncOutput } from "./runpy_lipsync.ts";
import { buildLipsyncLesson } from "./lipsync-lesson.ts";
```

- [ ] **Step 5: Add the `runPyLipsyncImpl` test seam to `DispatchDeps`**

In `dispatch.ts`, modify the `DispatchDeps` interface (currently
`dispatch.ts:336-344`):

```ts
export interface DispatchDeps {
	/** Forwarded to composeMotion() as its MotionDeps (e.g. { spawnImpl }). */
	composeMotionDeps?: MotionDeps;
	/** run-pipeline: inject to intercept inner dispatch calls in tests (default: re-entrant dispatch). */
	innerDispatch?: (command: string, opts: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
	/** run-pipeline: inject waypoint producers in tests (default: real bounded pi sessions). */
	waypointDeps?: WaypointDeps;
	/** run-pipeline: inject the ffprobe duration prober in tests (default: real ffprobe). */
	probeDuration?: (path: string) => Promise<number>;
	/** evaluate-lipsync: inject the lipsync_metrics runner in tests (default: real runPyLipsync). */
	runPyLipsyncImpl?: (input: RunPyLipsyncInput) => Promise<RunPyLipsyncOutput>;
}
```

- [ ] **Step 6: Add the `evaluate-lipsync` case**

In `dispatch.ts`, insert a new case immediately after the `"generate"` case
closes (`case "generate": {` starts at `dispatch.ts:480`; insert right before
`case "compose": {` at `dispatch.ts:577`):

```ts
      case "evaluate-lipsync": {
        const missing = missingFields(opts, ["videoPath"]);
        if (missing.length > 0) return { ok: false, error: `evaluate-lipsync requires non-empty ${missing.join(", ")}` };
        const videoPath = String(opts.videoPath);
        const seed = opts.seed !== undefined ? Number(opts.seed) : undefined;
        const promptSummary = opts.promptSummary ? String(opts.promptSummary) : undefined;
        const identityRef = opts.identityRef ? String(opts.identityRef) : undefined;
        const voice = opts.voice ? String(opts.voice) : undefined;

        const runLipsync = deps?.runPyLipsyncImpl ?? runPyLipsync;
        const evaluated = await runLipsync({ videoPath });
        if (!evaluated.ok || !evaluated.metrics) {
          return { ok: false, error: evaluated.error ?? "evaluate-lipsync: lipsync_metrics failed" };
        }

        const lesson = buildLipsyncLesson({
          verdict: evaluated.metrics.verdict,
          pearsonR: evaluated.metrics.pearson_r,
          mouthRatioStd: evaluated.metrics.mouth_ratio_std,
          seed,
          promptSummary,
          identityRef,
          voice,
          caveat: evaluated.metrics.caveat,
        });

        return { ok: true, text: jsonOut({ metrics: evaluated.metrics, lesson }) };
      }
```

- [ ] **Step 7: Add the `COMMAND_REFERENCE` bullet**

In `dispatch.ts`, insert a new bullet immediately after the `generate` entry
ends and before `"  • compose          — ..."` (i.e. right before what is
currently `dispatch.ts:201`'s `"  • compose          — ..."` line):

```ts
  "  • evaluate-lipsync — {videoPath, seed?, promptSummary?, identityRef?, voice?} → runs",
  "                        `python -m app.lipsync_metrics` on an already-produced talking-head video and returns",
  "                        {metrics:{verdict, pearson_r, mouth_ratio_std, caveat?}, lesson:{target, category, content,",
  "                        reason?}}. Decoupled from how the video was made (native-i2v + `run.py video lipdub` today —",
  "                        neither is wired into `generate` as a provider). Call this right after producing a lipdub",
  "                        video, passing the seed/prompt/identity/voice actually used; when the result has a `lesson`,",
  "                        call hermes-memory's `memory` tool immediately with target=lesson.target,",
  "                        category=lesson.category, content=lesson.content, reason=lesson.reason (when present) so the",
  "                        finding survives this session. Before producing a NEW lipdub video, call hermes-memory's",
  "                        `memory_search` tool first (category:'tool-quirk', query built from the character",
  "                        identity/voice) to check for known-bad seed/prompt combinations before picking new ones.",
```

**Reminder — no test enforces this bullet's presence** (`commandReferenceBlock`
falls back to a long-enough "Unknown command" string that still passes the
existing `details.length > 20` check). Verify it's there by re-reading the
diff, not just by running tests.

- [ ] **Step 8: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/commands.test.ts )`
Expected: PASS, including the pre-existing `"every command has a non-empty
name, summary, details, and run"` and `"each deterministic command's details
equals its dispatch reference block"` tests (these will now also cover
`evaluate-lipsync`; if `summaryFor` returns just the name `"evaluate-lipsync"`
instead of a real summary, Step 7's bullet is missing or the marker string
doesn't match `commandReferenceBlock`'s `"  • ${command} "` lookup exactly —
go back and fix the bullet's leading spaces/em-dash spacing).

- [ ] **Step 9: Full package test + typecheck**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test && bun run check )`
Expected: all tests pass, zero type errors.

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/dispatch.ts bun-apps/pi-agent-ext-movie-director/src/commands.test.ts
git commit -m "feat(pi-agent-ext-movie-director): add evaluate-lipsync command"
```

---

### Task 4: agent-facing contract in `CONTEXT.md`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/CONTEXT.md`

- [ ] **Step 1: Add a "Learning loop" section**

Read the file first to find a natural insertion point (after the "Resilience"
section, before "Integration" — matching the file's existing section order
seen during planning). Add:

```markdown
### Learning loop

**`evaluate-lipsync`**:
Scores an already-produced talking-head video's mouth-motion-vs-audio
correlation (`python -m app.lipsync_metrics`) and returns a `lesson`
(`{target, category, content, reason?}`) shaped for hermes-memory's `memory`
tool. Decoupled from how the video was produced — call it after any
`native-i2v` + `run.py video lipdub` pair.
_Avoid_: generate hook (lipdub is not a `generate` provider today — see
`evaluate-lipsync`'s own `movie_help` entry for why)

**Lesson**:
The output of `evaluate-lipsync` — `target: "memory"|"failure"`,
`category: "insight"|"tool-quirk"`, `content`, `reason?`. When present, call
hermes-memory's `memory` tool immediately with these fields so the finding
survives the session. Before producing a NEW lipdub video, call
hermes-memory's `memory_search` tool first (`category: "tool-quirk"`) to
check for known-bad combinations.
_Avoid_: silent skip (a `lesson` field left unrecorded defeats the entire
point of this loop — see `evaluate-lipsync`'s `movie_help` entry)
```

- [ ] **Step 2: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/CONTEXT.md
git commit -m "docs(pi-agent-ext-movie-director): document the lipsync learning-loop contract"
```

---

### Task 5: final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full package suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: all tests pass (pre-existing + the ~13 new ones from Tasks 1-3).

- [ ] **Step 2: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun run check )`
Expected: no errors.

- [ ] **Step 3: Confirm hermes-memory is untouched**

Run: `git diff --stat origin/main... -- bun-apps/pi-agent-ext-hermes-memory`
Expected: empty output (no changes to that package, per the spec's
acceptance criteria).
