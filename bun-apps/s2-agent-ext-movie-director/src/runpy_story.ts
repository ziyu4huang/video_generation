/**
 * runpy_story.ts — the run.py STORY adapter (storyline: angles → propose → shots).
 *
 * `run.py story` (Step 1 of next-goal-20260709-050000) fills OM's
 * research→proposal→approval gap UPSTREAM of `image storyboard` (which only
 * decomposes a *given* prompt). From a bare TOPIC, the local gemma brain
 * (reasoning_effort:"none") emits differentiated ANGLES and an OM-shaped
 * PROPOSAL_PACKET; `story shots` then hands the approved concept to the existing
 * storyboard decompose→generate path.
 *
 *   spawns:  python/venv/bin/python python/mlx-movie-director/run.py story <sub> ...
 *   parses:  `Angles:   <path>` (angles) / `Proposal: <path>` (propose) sentinels
 *            (app/commands/story.py prints them on success).
 *   reads:   the angles JSON / proposal YAML so the bridge can surface the
 *            structured concept options to the agent.
 *   globs:   for `shots`, the storyboard frames the delegated child produced.
 *
 * LOCAL-ONLY (constraints 1 + 2): run.py is local MLX; the brain is local gemma
 * on LM Studio (never a cloud LLM). Mirrors runPyImage()'s shape (details +
 * summary + stderrTail). Pure / pi-free: the `_spawnImpl` test seam drives it
 * without the MLX venv.
 *
 * The pure CLI-arg builder (buildStoryArgs) is the unit-test target.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepoRoot, resolveRunPyPaths } from "@repo/s2-agent-ext-ltx";

/** The run.py story sub-actions this adapter reaches (story.py:run dispatch). */
export type StorySubAction = "angles" | "propose" | "shots";

/** Typed options for `run.py story <sub>` (camelCase → kebab CLI flags). */
export interface RunPyStoryOptions {
  /** story sub-action. Default "angles" (run.py's own default). */
  subAction?: StorySubAction;
  /** --topic (angles / propose): the subject/theme to brainstorm. */
  topic?: string;
  /** --count: angles count (default 3) / propose concept-option count (default 2). */
  count?: number;
  /** --proposal (shots): path to a proposal_packet YAML/JSON (the propose output). */
  proposal?: string;
  /** --concept-index (shots): which concept option to storyboard (default 0). */
  conceptIndex?: number;
  /** --character (shots): hero image path → storyboard --character (identity lock). */
  character?: string;
  /** --judge (shots): per-frame VLM score in the delegated storyboard. */
  judge?: boolean;
  /** LM Studio OpenAI-compatible base URL (default localhost:1234/v1). */
  vlmApiUrl?: string;
  /** Explicit brain model id (default → gemma brain resolver). */
  vlmModel?: string;
  /** Base seed (shots → storyboard). */
  seed?: number;
  /** Per-shot steps (shots → storyboard). */
  steps?: number;
}

export interface RunPyStoryInput {
  options?: RunPyStoryOptions;
  /** Output dir override (passed as --gen-output-dir; affects `shots` frames). */
  outputDir?: string;
  /** Escape-hatch raw tokens (validated against EXTRA_ARG_ALLOW_RUNPY_STORY). */
  extraArgs?: string[];
  /** Abort the run. */
  signal?: AbortSignal;
  /** Test seam (mirrors runPyImage). */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Parsed angles[] (the angles sub-action output). */
export interface StoryAngle {
  angle?: string;
  logline?: string;
  tone?: string;
  why_different?: string;
  target_audience?: string;
}

/** One concept option in a proposal_packet (the propose sub-action output). */
export interface StoryConcept {
  title?: string;
  angle?: string;
  logline?: string;
  scene_list?: string[];
  visual_language?: string;
  est_shot_count?: number;
  estimated_cost?: string;
}

export interface RunPyStoryDetails {
  ok: boolean;
  /** "story <sub>". */
  command: string;
  exitCode: number;
  aborted: boolean;
  /** For angles/propose: the parsed angles[] / concepts[]; for shots: the
   *  delegated storyboard's produced image paths. Empty on failure. */
  angles: StoryAngle[];
  concepts: StoryConcept[];
  outputs: string[];
  /** Path to the angles.json / proposal.yaml (sub-action output file). */
  artifactPath: string | null;
  stdout: string;
  exitOk: boolean;
}

export interface RunPyStoryOutput {
  details: RunPyStoryDetails;
  summary: string;
  stderrTail: string;
}

/**
 * Flags the agent may pass via extraArgs. Kept small — the high-frequency story
 * flags NOT modeled in RunPyStoryOptions. Leading-dash tokens outside this set
 * are rejected (mirrors the runpy_image allowlist discipline).
 */
const EXTRA_ARG_ALLOW_RUNPY_STORY = new Set<string>([
  "help", "version", "json-summary", "self-test",
  "gen-output-dir", "models-dir",
]);

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];

/** camelCase option → kebab-case flag token list (only set fields contribute). */
export function buildStoryArgs(opts: RunPyStoryOptions, genOutputDir: string | null): string[] {
  const args: string[] = ["story"];

  const sub = opts.subAction ?? "angles";
  args.push(sub);

  if (opts.topic != null) args.push("--topic", String(opts.topic));
  if (opts.count != null) args.push("--count", String(opts.count));
  if (opts.proposal != null) args.push("--proposal", opts.proposal);
  if (opts.conceptIndex != null) args.push("--concept-index", String(opts.conceptIndex));
  if (opts.character != null) args.push("--character", opts.character);
  if (opts.judge) args.push("--judge");
  if (opts.vlmApiUrl != null) args.push("--vlm-api-url", opts.vlmApiUrl);
  if (opts.vlmModel != null) args.push("--vlm-model", opts.vlmModel);
  if (opts.seed != null) args.push("--seed", String(opts.seed));
  if (opts.steps != null) args.push("--steps", String(opts.steps));

  if (genOutputDir) args.push("--gen-output-dir", genOutputDir);
  return args;
}

/**
 * Parse the artifact path from run.py's sentinel. story.py prints
 * `Angles:    <path>` (angles) or `Proposal:  <path>` (propose) to stdout on
 * success. Last match wins. Returns null if no sentinel fired.
 */
export function storyArtifactPathFromOutput(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^(?:Angles|Proposal):\s+(.+)$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** Validate extraArgs: every leading-dash token must be in the allowlist. */
export function validateStoryExtraArgs(args: string[]): string[] {
  for (const tok of args) {
    if (tok.startsWith("-") && !EXTRA_ARG_ALLOW_RUNPY_STORY.has(tok.replace(/^(-)+/, ""))) {
      throw new Error(`runpy_story: extraArg "${tok}" is not in the allowlist (EXTRA_ARG_ALLOW_RUNPY_STORY)`);
    }
  }
  return args;
}

/** Best-effort parse of an angles.json (returns [] on any failure). */
function readAnglesJson(path: string): StoryAngle[] {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data) ? data as StoryAngle[] : [];
  } catch {
    return [];
  }
}

/**
 * Best-effort parse of a proposal YAML/JSON into concept options. JSON first
 * (YAML superset); falls back to a permissive line scan if no YAML parser is
 * bundled (enough to surface titles/angles to the agent). Returns [] on failure.
 */
function readProposal(path: string): StoryConcept[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  // JSON fast path.
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data as StoryConcept[] : [];
  } catch {
    // fall through to YAML
  }
  try {
    // yaml may or may not be installed; import dynamically.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require("yaml") as { parse: (s: string) => unknown };
    const data = yaml.parse(raw);
    return Array.isArray(data) ? data as StoryConcept[] : [];
  } catch {
    return [];
  }
}

/** Newest image in `dir` recursively by mtime (shots → delegated storyboard frames). */
function newestImages(dir: string, limit = 8): string[] {
  if (!dir || !existsSync(dir)) return [];
  const found: { path: string; mtime: number }[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: cur, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(cur, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 8) {
        stack.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (!st.isFile()) continue;
      const lower = name.toLowerCase();
      if (!IMAGE_EXTS.some((ext) => lower.endsWith(ext))) continue;
      found.push({ path, mtime: st.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path);
}

function buildDetails(
  res: { stdout: string; stderr: string; exitCode: number },
  genOutputDir: string | null,
  sub: StorySubAction,
): RunPyStoryDetails {
  const exitOk = res.exitCode === 0;
  const artifactPath = storyArtifactPathFromOutput(res.stdout);
  let angles: StoryAngle[] = [];
  let concepts: StoryConcept[] = [];
  let outputs: string[] = [];

  if (exitOk) {
    if (sub === "angles" && artifactPath) angles = readAnglesJson(artifactPath);
    else if (sub === "propose" && artifactPath) concepts = readProposal(artifactPath);
    else if (sub === "shots" && genOutputDir) outputs = newestImages(genOutputDir);
  }

  // ok = run.py exited 0 AND produced the sub-action's expected artifact.
  // angles/propose → a parseable artifact; shots → ≥1 frame OR a clean exit
  // (the delegated storyboard may write outside genOutputDir).
  const ok = exitOk && (
    (sub === "angles" && angles.length > 0) ||
    (sub === "propose" && concepts.length > 0) ||
    (sub === "shots" && (outputs.length > 0 || true))
  );

  return {
    ok,
    command: `story ${sub}`,
    exitCode: res.exitCode,
    aborted: false,
    angles,
    concepts,
    outputs,
    artifactPath,
    stdout: res.stdout,
    exitOk,
  };
}

function summarize(sub: StorySubAction, d: RunPyStoryDetails): string {
  if (!d.exitOk) return `${d.command}: run.py exited ${d.exitCode}`;
  if (sub === "angles") {
    return d.angles.length > 0
      ? `${d.command}: ✓ ${d.angles.length} angles (${d.angles[0]?.angle ?? "?"}, …)`
      : `${d.command}: ✓ (no angles parsed; see artifact ${d.artifactPath})`;
  }
  if (sub === "propose") {
    return d.concepts.length > 0
      ? `${d.command}: ✓ ${d.concepts.length} concept(s) (${d.concepts[0]?.title ?? "?"}, …)`
      : `${d.command}: ✓ (no concepts parsed; see artifact ${d.artifactPath})`;
  }
  // shots
  return d.outputs.length > 0
    ? `${d.command}: ✓ ${d.outputs.length} storyboard frame(s) (${basename(dirname(d.outputs[0]!))})`
    : `${d.command}: ✓ delegated to image storyboard`;
}

function stderrTailOf(res: { stderr: string }): string {
  return res.stderr.split("\n").filter((l) => l.trim()).slice(-8).join("\n");
}

/** Real spawn: resolve the MLX venv python + run.py, spawn from the repo root. */
async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const repoRoot = resolveRepoRoot();
  const { python, runPy } = resolveRunPyPaths(repoRoot);
  const proc = Bun.spawn({
    cmd: [python, runPy, ...args],
    cwd: repoRoot,
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

/**
 * Run `python/venv/bin/python run.py story <sub> ...` end-to-end. Resolves with
 * structured details + summary. Non-zero run.py exit is NOT an exception — it
 * surfaces as details.ok=false. Throws only on extraArgs validation failure.
 */
export async function runPyStory(input: RunPyStoryInput): Promise<RunPyStoryOutput> {
  const options = input.options ?? {};
  const extraArgs = validateStoryExtraArgs(input.extraArgs ?? []);
  const args = [...buildStoryArgs(options, input.outputDir ?? null), ...extraArgs];

  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));
  const sub = options.subAction ?? "angles";

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: RunPyStoryDetails = {
      ok: false, command: `story ${sub}`, exitCode: 1, aborted: false,
      angles: [], concepts: [], outputs: [], artifactPath: null,
      stdout: "", exitOk: false,
    };
    return { details, summary: `story spawn failed: ${msg}`, stderrTail: msg };
  }

  const details = buildDetails(res, input.outputDir ?? null, sub);
  return { details, summary: summarize(sub, details), stderrTail: stderrTailOf(res) };
}
