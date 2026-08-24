// @ts-nocheck
/**
 * self-improve-flux2.js — the CLOSED self-improve loop for s2-agent-ext-flux2.
 *
 * Sibling to test-flux2-e2e.js (the single-shot L2 judgment). This workflow
 * CLOSES the loop that test-flux2-e2e.js only opens: generate → judge → on
 * below-threshold, reflect (failed atoms → targeted prompt expansion) → retry,
 * bounded by `attempts`, seed-locked per attempt, ranked comparatively.
 *
 * It wraps the SAME proven Generate + Judge thunks (the prompt text is copied
 * verbatim from test-flux2-e2e.js — these engine-vm scripts cannot import each
 * other, see _shared-patterns.md copy convention) in the engine's existing
 * `gate(thunk, validator, {attempts})` combinator (workflow.ts:787-802). The
 * validator is a PURE JS function over the judge result; it emits targeted
 * feedback that gate feeds into the next attempt's generation prompt. Control
 * flow stays in JS, so a weak driver model can never break the multi-attempt
 * trace by mis-parsing a tool call — only the per-attempt bash agents touch the
 * model, and those already have schema-retry + null→{scored:false} handling.
 *
 * COMPARATIVE RANKING (the determinism lever): the validator never trusts an
 * absolute VLM score. `ok` requires anatomy_pass (Python-recomputed, hard) AND
 * faithfulness>=threshold AND no failed atoms. The "best" output is chosen
 * across attempts by fewest failed_atoms (tie-break: highest faithfulness), so
 * a single VLM flip cannot falsely pass or flip pass/fail. See
 * docs/pose-validation.md for why holistic scores are the wrong unit.
 *
 * SHAPE
 *   Resolve — args, venv probe, target list (poses → pose_dsg | prompts → score)
 *   Loop    — gate(generateThenJudge, validator, {attempts}); trace[] accumulates
 *             per-attempt per-target matrices; best-so-far picked comparatively
 *   Persist — append winning (prompt→params→verdict) exemplar to .exemplars.jsonl
 *   Report  — {ok, attempts, winnerPath, winnerVerdict, best, trace, exemplar, …}
 *
 * INVOCATION
 *   bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh flux2
 *   # or directly:
 *   bun-apps/s2-agent/run.sh -e workflow -p \
 *     "read bun-apps/s2-agent-ext-flux2/workflows/self-improve-flux2.js and execute it via the workflow tool (background:false)"
 *
 * SAFETY: this loop is PROPOSE-ONLY. It persists exemplars (jsonl) and returns a
 * verdict; it NEVER git-applies, edits source, or merges anything. Auto-fix is
 * explicitly out of scope (see goal §3).
 */

export const meta = {
  name: "self_improve_flux2",
  description:
    "Closed, bounded self-improve loop for flux2. DEFAULT mode=best-of-N: generate → judge (pose_dsg/score) → retry on fail with a FRESH seed and BARE prompts, best-so-far ranked comparatively by per-atom matrix (seed sampling is the measured quality lever on flux2-klein; reflection has not been observed to beat it). mode=reflect (opt-in) injects the validator's failed-atom feedback into the next attempt's prompts. Bounded by the engine gate(): convergence early-exit + plateau-aware static exit. Appends winning exemplars. Propose-only — never auto-applies.",
  phases: [
    { title: "Resolve" },
    { title: "Loop" },
    { title: "Persist" },
    { title: "Report" },
  ],
};

// ─── Inputs (overridable via the workflow tool's `args`) ────────────────────
const a = (typeof args === "object" && args) || {};
const REPO_ROOT = String(a.repoRoot || cwd);
const FLUX2 = REPO_ROOT + "/swift/flux2-image-director/.build/release/flux2";
const OUT_DIR = String(a.outDir || REPO_ROOT + "/../video_generation__output/wf-self-improve-flux2");
const NAME = String(a.name || "wf_self_improve");
const SEED_BASE = Number(a.seed ?? a.seedBase ?? 42);
// Explicit per-attempt seed set (best-of-N). When non-empty, attempt i uses
// seeds[i] (clamped to the last entry). Empty → SEED_BASE + attempt. This is
// how best-of-N samples a controlled seed set (e.g. [300,500,700]) and lets the
// comparative picker prove it selects the clean seed from a mix.
const SEEDS = (Array.isArray(a.seeds) ? a.seeds : [])
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x) && x >= 0);
const WIDTH = Number(a.width ?? 768);
const HEIGHT = Number(a.height ?? 768);
const STEPS = Number(a.steps ?? 4);
const ATTEMPTS = Math.max(1, Number(a.attempts ?? 3));
const MAX_EXEMPLARS = Math.max(1, Number(a.maxExemplars ?? 40));
// Regression-aware termination: if the failed-atom signature is unchanged for
// CONSECUTIVE_STATIC rounds (plateau), stop early instead of burning the full
// budget. 0 disables (cap-only, the original behavior).
const CONSECUTIVE_STATIC = Math.max(0, Number(a.consecutiveStatic ?? 2));
// Cross-run few-shot: the winning expanded prompt from a prior converged run on
// this pose (loaded by the driver from the exemplars jsonl). Injected into
// attempt 0's generation. Empty/absent → no few-shot (first run).
const FEWSHOT = typeof a.fewShot === "string" && a.fewShot.trim() ? String(a.fewShot) : "";
// Optional judge-model override. The pose_dsg judge's default served model
// (prism-ml/bonsai-27b) returns 0 atoms on multi-subject images (measured
// 3/3 on L4-02 — see goal 0704 §4). A stronger tier (e.g. prism-ml/bonsai-27b)
// analyzes them correctly. Injected into the run.py caption --model flag when set.
const JUDGE_MODEL = typeof a.judgeModel === "string" && a.judgeModel.trim() ? String(a.judgeModel) : "";
// Fallback judge tier for 0-atom verdicts (goal 0704 §1 — the pure-win fix the
// 0612 arc left documented-but-not-coded). The default served pose_dsg judge
// (prism-ml/bonsai-27b) returns 0 atoms on multi-subject images (measured 3/3
// on L4-02 — see [[pose-dsg-empty-atoms-multi-subject-judge-tier]]); a stronger
// tier analyzes them correctly. judgePose auto-retries ONCE with this tier when
// 0 atoms are returned under any other judge, so a user no longer has to KNOW to
// pass --judge-model on multi-subject. Single-subject poses judge fine under the
// default and never trigger this → no latency cost there.
const FALLBACK_JUDGE_MODEL = "prism-ml/bonsai-27b";

// Loop MODE (measured verdict, goal 0704 §1). On flux2-klein, the loop's
// reflection machinery does NOT beat single-shot best-of-N — seed sampling is
// the quality lever (corr 0.96 with human pref, see [[klein-int8-local-models]]);
// reflection's targeted prompt expansion could not fix the one defect it found
// (fused fingers — a structural generation weakness, not a prompt-coverage gap).
// So the DEFAULT mode is best-of-N: each attempt samples a fresh seed with BARE
// prompts (no reflection feedback injected), and the winner is picked
// comparatively by fewest failed_atoms — exactly best-of-N with a convergence
// gate (early-exit on attempt 0) + plateau-aware bounded exit.
//   "best-of-n" (default) — bare prompts, feedback ignored, seed varies per attempt
//   "reflect"             — CURRENT-PRE-0704 behavior: validator's failed-atom
//                          feedback is injected into the next attempt's prompts.
// Reflection is retained (opt-in) for generators where defects may be
// prompt-coverage gaps (untested on krea2 / non-distilled flux2).
const MODE = (() => {
  const m = String(a.mode || "best-of-n").trim().toLowerCase();
  return m === "reflect" ? "reflect" : "best-of-n";
})();
const REFLECT = MODE === "reflect";

const VENV_CANDIDATES = [
  REPO_ROOT + "/python/venv/bin/python",
  REPO_ROOT + "/../video_generation__venv/bin/python",
];

const EXEMPLARS_FILE = REPO_ROOT + "/bun-apps/s2-agent-ext-flux2/workflows/self-improve-flux2.exemplars.jsonl";

// Prompts (holistic score path) — the regression-tested fallback when no poses.
const PROMPTS = (a.prompts && Array.isArray(a.prompts))
  ? a.prompts.filter((x) => typeof x === "string")
  : ["a red apple on a wooden table, soft window light, photorealistic"];

// POSE MODE (opt-in). `poses` entries lifted verbatim from poses.json:
// {id, prompt, failure_modes, atoms:[{id,q}]}. Drives BOTH generation and the
// atomic pose_dsg judge. When present, poses win over prompts.
const POSES = (a.poses && Array.isArray(a.poses))
  ? a.poses.filter((p) => p && typeof p.prompt === "string" && Array.isArray(p.atoms))
  : [];
const POSE_MODE = POSES.length > 0;

// Thresholds (see test-flux2-e2e.js — conservative because the local VLM over-scores).
const THRESHOLDS = { overall: 6, artifacts: 6 };
const BLOCKING_ISSUE = /extra limb|fused|mutated|extra fingers|deformed|nsfw|blank|nan/i;
const FAITH_THRESHOLD = Number(a.faithThreshold ?? 0.8);

// ─── Phase: Resolve ─────────────────────────────────────────────────────────
phase("Resolve");

function venvProbeInstruction() {
  return "The MLX venv python is at ONE of: " + VENV_CANDIDATES.join(" or ")
    + ". Probe `[ -x <path> ]` and use the first that exists. (In a worktree it is usually the sibling ../video_generation__venv.)";
}

// Targets: one generation prompt per target. In pose mode each pose carries its
// own prompt + atoms; otherwise use the bare prompts.
const BASE_PROMPTS = POSE_MODE ? POSES.map((p) => p.prompt) : PROMPTS;

log(
  "self-improve flux2: " + BASE_PROMPTS.length + " target(s), " + ATTEMPTS + " attempt(s) max, "
  + (POSE_MODE ? "pose_dsg" : "score") + " judging, seedBase=" + SEED_BASE + ", mode=" + MODE
  + (JUDGE_MODEL ? ", judge=" + JUDGE_MODEL : ""),
);

// ═══════════════════════════════════════════════════════════════════════════
// Phase: Loop — generate→judge thunk + validator, wrapped in gate()
// ═══════════════════════════════════════════════════════════════════════════
phase("Loop");

// Per-attempt accumulator. Each entry: {attempt, seed, paths, judgments, poseMatrix,
// failedCount, meanFaith, ok}. The comparative best-so-far is selected from this
// trace after gate() returns — never from an absolute score.
const trace = [];

const GEN_SCHEMA = {
  type: "object",
  required: ["ok", "paths"],
  properties: {
    ok: { type: "boolean", description: "All prompts generated a real PNG (exit 0, file exists, non-zero size)." },
    paths: { type: "array", items: { type: "string" }, description: "Absolute PNG output paths, one per prompt, in order." },
    binaryReady: { type: "boolean", description: "flux2 release binary + mlx.metallib present and --help exits 0." },
    error: { type: "string", description: "Failure tail if ok=false; empty otherwise." },
  },
  additionalProperties: false,
};

const JUDGE_SCORE_SCHEMA = {
  type: "object",
  required: ["ok", "path", "overall", "artifacts"],
  properties: {
    ok: { type: "boolean" },
    path: { type: "string" },
    overall: { type: "integer" },
    detail: { type: "integer" },
    sharpness: { type: "integer" },
    composition: { type: "integer" },
    prompt_adherence: { type: "integer" },
    artifacts: { type: "integer" },
    issues: { type: "array", items: { type: "string" } },
    rawTail: { type: "string" },
  },
  additionalProperties: false,
};

const JUDGE_POSE_SCHEMA = {
  type: "object",
  required: ["ok", "path", "anatomy_pass", "faithfulness", "atoms"],
  properties: {
    ok: { type: "boolean" },
    path: { type: "string" },
    poseId: { type: "string" },
    anatomy_pass: { type: "boolean" },
    faithfulness: { type: "number" },
    anatomy: {
      type: "object",
      properties: {
        limb_count: { type: "boolean" },
        hands: { type: "boolean" },
        face: { type: ["boolean", "null"] },
        pose_plausible: { type: "boolean" },
      },
    },
    atoms: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "present"],
        properties: { id: { type: "string" }, q: { type: "string" }, present: { type: "boolean" }, confidence: { type: "number" } },
      },
    },
    issues: { type: "array", items: { type: "string" } },
    rawTail: { type: "string" },
  },
  additionalProperties: false,
};

// Generate one PNG per (expanded) prompt for this attempt. SEED IS LOCKED PER
// ATTEMPT so the retry trace is reproducible. In best-of-N mode the natural
// unit is a sampled seed SET — pass `seeds: [n0, n1, ...]` and attempt i uses
// seeds[i] (clamped to the last entry if attempts > seeds.length). Without it,
// seed = SEED_BASE + attempt (the reflection-mode default: each retry is a
// fresh consecutive roll). The --name suffix keeps each attempt's files distinct.
async function generate(attempt, expandedPrompts) {
  const seed = (SEEDS.length > 0) ? SEEDS[Math.min(attempt, SEEDS.length - 1)] : (SEED_BASE + attempt);
  const nameSuffix = NAME + "_attempt" + attempt;
  try {
    const g = await agent(
      [
        "Generate one flux2 t2i PNG per prompt, in order. Repo root: " + REPO_ROOT + ". Binary: " + FLUX2 + ".",
        "FIRST ensure the binary is ready: " + FLUX2 + " --help must exit 0. If missing, build: `( cd " + REPO_ROOT + "/swift/flux2-image-director && swift build -c release )` then `bash " + REPO_ROOT + "/swift/flux2-image-director/scripts/build-metallib.sh`. Skip metallib if .build/release/mlx.metallib already exists. This may take minutes on first build — use a long timeout.",
        "Then run ONE flux2 t2i per prompt (i index 0..N-1):",
        "  " + FLUX2 + " t2i --prompt <prompt> --seed " + seed + " --width " + WIDTH + " --height " + HEIGHT + " --steps " + STEPS + " --output-dir " + JSON.stringify(OUT_DIR) + " --name " + JSON.stringify(nameSuffix) + "_<i>",
        "Each run loads a 9B model — expect ~1-3 min each. Use a long timeout; if your bash tool times out, run nohup ... & and poll for the PNG, then read the log.",
        "On success flux2 prints a `✅ generated <name>` line, then an indented ABSOLUTE png path, then `   manifest:   <path>.manifest.json`. Use the manifest JSON's output field, or the indented line, to get the EXACT absolute path.",
        "Return ok=true only if EVERY prompt produced a PNG that exists with non-zero size. Return paths[] in prompt order (absolute). Put any failure tail in `error`.",
        "Prompts (in order): " + JSON.stringify(expandedPrompts),
      ].join("\n"),
      { label: "flux2 t2i generate attempt " + attempt, tier: "small", schema: GEN_SCHEMA },
    );
    if (!g || !g.ok || !Array.isArray(g.paths)) {
      return { ok: false, paths: [], error: (g && g.error) || "generation returned no result", seed };
    }
    return { ok: true, paths: g.paths.filter(Boolean), error: "", seed };
  } catch (e) {
    return { ok: false, paths: [], error: (e && e.message) ? String(e.message) : String(e), seed };
  }
}

async function judgeScore(p, i) {
  try {
    const j = await agent(
      [
        "Score this generated image with the local VLM. Repo root: " + REPO_ROOT + ".",
        venvProbeInstruction(),
        "Run: <python> " + REPO_ROOT + "/python/mlx-movie-director/run.py caption " + JSON.stringify(p) + " --style score --lang en",
        "This loads a VLM (Qwen3-VL/Gemma) — ~1 min. Use a long timeout.",
        "It prints a line like `[score] {\"overall\":9,...,\"artifacts\":10,\"issues\":[...]}` and saves <p>.caption.json. Parse the JSON (from the [score] line OR the .caption.json file).",
        "Return ok=true iff you got a parseable score with overall + artifacts. Copy overall/detail/sharpness/composition/prompt_adherence/artifacts and issues[] verbatim from the VLM JSON. Put a short scorer output tail in rawTail. Set path=" + JSON.stringify(p) + ".",
      ].join("\n"),
      { label: "vlm score output " + (i + 1), tier: "small", schema: JUDGE_SCORE_SCHEMA },
    );
    if (!j || typeof j.overall !== "number" || typeof j.artifacts !== "number") {
      return { scored: false, style: "score", path: p, error: "scorer returned no parseable score", rawTail: (j && j.rawTail) || "" };
    }
    return {
      scored: true, style: "score", path: p,
      overall: j.overall, detail: j.detail, sharpness: j.sharpness,
      composition: j.composition, prompt_adherence: j.prompt_adherence, artifacts: j.artifacts,
      issues: Array.isArray(j.issues) ? j.issues : [],
    };
  } catch (e) {
    return { scored: false, style: "score", path: p, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function judgePose(p, i, pose) {
  const atomsJson = JSON.stringify({ atoms: pose.atoms }, null, 2);
  const atomsFile = "/tmp/flux2_pose_atoms_" + i + ".json";
  // One pose_dsg VLM call with an optional --model override ("" = let run.py
  // auto-resolve among served models). Extracted into a closure so the
  // auto-fallback below can re-invoke with the stronger tier without
  // duplicating the prompt.
  const runOnce = (modelArg, callLabel) =>
    agent(
      [
        "Validate this generated pose image with the local VLM's pose_dsg scorer. Repo root: " + REPO_ROOT + ".",
        venvProbeInstruction(),
        "FIRST write the atoms JSON to a temp file with a quoted heredoc (apostrophes are safe inside the quoted delimiter):",
        "  cat > " + atomsFile + " <<'POSE_ATOMS_EOF'",
        atomsJson,
        "POSE_ATOMS_EOF",
        "Then run: <python> " + REPO_ROOT + "/python/mlx-movie-director/run.py caption " + JSON.stringify(p) + " --style pose_dsg --prompt " + JSON.stringify(pose.prompt) + " --atoms " + atomsFile + (modelArg ? " --model " + JSON.stringify(modelArg) : "") + " --lang en",
        "This loads a VLM (Qwen3-VL/Gemma) — ~1 min. Use a long timeout.",
        "It saves <p>.caption.json with styles.pose_dsg = {atoms:[{id,q,present,confidence}], faithfulness, anatomy:{limb_count,hands,face,pose_plausible}, anatomy_pass, issues, summary}. faithfulness and anatomy_pass are RECOMPUTED in Python (not the model's own).",
        "Parse that JSON (read <p>.caption.json, take styles.pose_dsg). Return ok=true iff you got anatomy_pass (boolean) + faithfulness (number) + atoms[]. Copy anatomy_pass, faithfulness, anatomy, atoms[] (id/q/present/confidence), issues[] verbatim. Set path=" + JSON.stringify(p) + " and poseId=" + JSON.stringify(pose.id || "") + ". Put a short scorer output tail in rawTail.",
      ].join("\n"),
      { label: callLabel, tier: "small", schema: JUDGE_POSE_SCHEMA },
    );
  try {
    // The model for the first call: an explicit --judge-model override wins;
    // otherwise "" lets run.py auto-resolve (typically prism-ml/bonsai-27b when
    // that is the only model served).
    let modelUsed = JUDGE_MODEL;
    let j = await runOnce(modelUsed, "vlm pose_dsg output " + (i + 1));
    // ── Judge-tier auto-fallback (goal 0704 §1) ──────────────────────────────
    // The default served judge (prism-ml/bonsai-27b) returns 0 atoms on
    // multi-subject images (measured 3/3 on L4-02). A 0-atom verdict means the
    // VLM did not actually analyze the image (faithfulness 0 + anatomy all-false
    // is the tell) — untrustworthy, not a real fail. Rather than declare unscored
    // (the old footgun: the user had to KNOW to pass --judge-model), retry ONCE
    // with the stronger tier that can analyze multi-subject. Single-subject poses
    // judge fine under the default and never trigger this, so they pay no latency
    // cost. Logged + flagged on the verdict so the tier dependency stays
    // OBSERVABLE, not silent. No retry when the user already pinned the fallback.
    let fellBack = false;
    if (j && Array.isArray(j.atoms) && j.atoms.length === 0 && modelUsed !== FALLBACK_JUDGE_MODEL) {
      log("[judge] pose_dsg returned 0 atoms under " + (modelUsed || "auto-resolved judge") + " → retrying once with " + FALLBACK_JUDGE_MODEL);
      modelUsed = FALLBACK_JUDGE_MODEL;
      fellBack = true;
      j = await runOnce(modelUsed, "vlm pose_dsg output " + (i + 1) + " [fallback " + FALLBACK_JUDGE_MODEL + "]");
    }
    if (!j || typeof j.anatomy_pass !== "boolean" || typeof j.faithfulness !== "number" || !Array.isArray(j.atoms)) {
      return { scored: false, style: "pose_dsg", path: p, poseId: pose.id || "", error: "pose_dsg returned no parseable verdict", rawTail: (j && j.rawTail) || "", judgeFallback: fellBack };
    }
    if (j.atoms.length === 0) {
      // Still 0 atoms even under the fallback tier (or the user pinned the
      // fallback and it still flaked). Genuine unscored — surface it, naming the
      // judge(s) that failed so the tier dependency is visible in the record.
      const judgeTried = fellBack ? FALLBACK_JUDGE_MODEL + " (fallback)" : (JUDGE_MODEL || "auto-resolved judge");
      return { scored: false, style: "pose_dsg", path: p, poseId: pose.id || "", error: "pose_dsg returned 0 atoms under " + judgeTried + " (VLM did not analyze the image)", rawTail: (j && j.rawTail) || "", judgeFallback: fellBack };
    }
    const failed = j.atoms.filter((x) => x && x.present === false).map((x) => x.id);
    return {
      scored: true, style: "pose_dsg", path: p, poseId: pose.id || "",
      anatomy_pass: j.anatomy_pass, faithfulness: j.faithfulness, anatomy: j.anatomy || {},
      atoms: j.atoms, failed_atoms: failed, issues: Array.isArray(j.issues) ? j.issues : [],
      judgeFallback: fellBack,
    };
  } catch (e) {
    return { scored: false, style: "pose_dsg", path: p, poseId: pose.id || "", error: (e && e.message) ? String(e.message) : String(e) };
  }
}

// Build the targeted feedback string for the NEXT generation attempt from the
// current attempt's per-target failures. This is the "reflection" step: each
// failed atom's question becomes an explicit clause the model must emphasize.
// Returns { ok, feedback }. ok is comparative-safe: anatomy_pass is a Python
// hard gate; faithfulness is Python-recomputed; failed_atoms is per-atom present
// verdict. No absolute VLM score enters the ok decision.
function validate(attemptResult) {
  const judgments = attemptResult.judgments || [];
  const unscored = judgments.filter((j) => !j.scored);
  const scored = judgments.filter((j) => j.scored);

  const failedPose = scored.filter((j) => j.style === "pose_dsg" && (j.anatomy_pass === false || j.faithfulness < FAITH_THRESHOLD));
  const failedScore = scored
    .filter((j) => j.style !== "pose_dsg")
    .filter((j) => j.overall < THRESHOLDS.overall || j.artifacts < THRESHOLDS.artifacts || (Array.isArray(j.issues) && j.issues.some((s) => BLOCKING_ISSUE.test(String(s)))));

  const ok = judgments.length > 0 && unscored.length === 0 && failedPose.length === 0 && failedScore.length === 0;

  // ── Build targeted feedback (reflection → next prompt expansion) ──────────
  const bits = [];
  for (const f of failedPose) {
    const anatomy = f.anatomy || {};
    const anatomyBits = [];
    if (anatomy.limb_count === false) anatomyBits.push("correct limb count");
    if (anatomy.hands === false) anatomyBits.push("five-fingered hands, no extra/fused fingers");
    if (anatomy.face === false) anatomyBits.push("an undistorted face");
    if (anatomy.pose_plausible === false) anatomyBits.push("a physically plausible pose");
    const poseTag = f.poseId ? "[" + f.poseId + "] " : "";
    if (anatomyBits.length) bits.push(poseTag + "Anatomy MUST be fixed: " + anatomyBits.join("; ") + ".");
    const fa = (f.atoms || []).filter((x) => x.present === false);
    if (fa.length) {
      bits.push(poseTag + "These requested elements were ABSENT — emphasize them explicitly: "
        + fa.map((x) => "'" + (x.q || x.id) + "'").join("; ") + ".");
    }
  }
  for (const f of failedScore) {
    const iss = Array.isArray(f.issues) && f.issues.length ? f.issues.join("; ") : "overall=" + f.overall + ",artifacts=" + f.artifacts;
    bits.push("Improve: " + iss + ".");
  }
  if (unscored.length) {
    bits.push("A previous output could not be scored (" + unscored.map((u) => u.error || "unknown").join("; ") + ") — re-roll cleanly.");
  }
  const feedback = bits.length ? "REFLECT on the previous attempt and regenerate with these targeted fixes: " + bits.join(" ") : "";

  // ── Regression-aware termination (plateau detection) ─────────────────────
  // If the failed-atom signature has been identical for CONSECUTIVE_STATIC
  // rounds (including this one), the loop is stuck — stop early instead of
  // burning the full budget. We return ok=true so gate() halts, but tag
  // reason="static" so the result distinguishes a real convergence from a
  // plateau exit. trace already holds this attempt's entry (validate runs after
  // the thunk pushes it).
  if (!ok && CONSECUTIVE_STATIC > 0 && trace.length >= CONSECUTIVE_STATIC) {
    const lastN = trace.slice(-CONSECUTIVE_STATIC);
    const sig = (e) => String(e && e.failedSignature || "");
    const firstSig = sig(lastN[0]);
    if (firstSig && lastN.every((e) => sig(e) === firstSig)) {
      return { ok: true, feedback: "", reason: "static" };
    }
  }
  return { ok, feedback, reason: ok ? "converged" : undefined };
}

// The gate thunk: generate (with feedback expanded into prompts) → judge → trace.
async function generateThenJudge(feedback, attempt) {
  // On attempt 0, if a cross-run few-shot exemplar was loaded (args.fewShot —
  // the winning expanded prompt from a prior converged run on this pose, loaded
  // deterministically by the driver), seed generation with it. This is the
  // "self-generated in-context examples" loop (goal 0402 criterion #3). On later
  // attempts, feedback (reflection) drives the expansion as usual.
  const seeds = (attempt === 0 && FEWSHOT) ? BASE_PROMPTS.map((p, i) => (i === 0 ? FEWSHOT : p)) : BASE_PROMPTS;
  // Expand each prompt with the feedback clause (reflection injection). ONLY in
  // reflect mode — in best-of-n (the default, see MODE) feedback is ignored so
  // each attempt is a BARE-prompt fresh-seed sample (seed sampling is the measured
  // quality lever on flux2-klein; reflection has not been observed to beat it).
  // The validator still computes `feedback` and the convergence/plateau gates
  // still fire in both modes — only the prompt injection differs.
  const injectFeedback = REFLECT && feedback;
  const expanded = injectFeedback
    ? seeds.map((p) => p + " // " + feedback)
    : seeds.slice();

  const gen = await generate(attempt, expanded);
  const outputs = gen.ok ? gen.paths : [];

  // No outputs → surface a real error (genError), never a silent "no outputs".
  if (!outputs.length) {
    const entry = { attempt, seed: gen.seed, paths: [], judgments: [], poseMatrix: [], failedCount: 0, meanFaith: 0, ok: false, genError: gen.error || "no outputs generated" };
    trace.push(entry);
    return entry;
  }

  const judgments = await parallel(outputs.map((p, i) => () => (POSE_MODE ? judgePose(p, i, POSES[i] || POSES[0]) : judgeScore(p, i))));

  // Per-target matrix (pose mode) — the comparative signal. failedCount drives
  // best-so-far selection; meanFaith is the tie-break.
  const poseMatrix = judgments
    .filter((j) => j && j.scored && j.style === "pose_dsg")
    .map((j) => ({
      poseId: j.poseId, path: j.path, anatomy_pass: j.anatomy_pass, faithfulness: j.faithfulness,
      failed_atoms: j.failed_atoms || [],
      atoms: (j.atoms || []).map((x) => ({ id: x.id, q: x.q, present: x.present })),
    }));

  const v = validate({ judgments });
  const failedCount =
    judgments.filter((j) => j.scored && j.style === "pose_dsg").reduce((n, j) => n + (j.failed_atoms || []).length, 0)
    + judgments.filter((j) => j.scored && j.style !== "pose_dsg" && (j.overall < THRESHOLDS.overall || j.artifacts < THRESHOLDS.artifacts)).length;
  const faiths = judgments.filter((j) => j.scored && j.style === "pose_dsg").map((j) => j.faithfulness).filter((x) => typeof x === "number");
  const meanFaith = faiths.length ? faiths.reduce((s, x) => s + x, 0) / faiths.length : 0;

  // failedSignature: a stable string of WHAT failed (sorted failed atom ids +
  // failed-score count + unscored count), so the validator can detect a plateau
  // (same failures across rounds). Empty string when nothing failed (a converged
  // attempt has no plateau signature).
  //
  // The `unscored:N` token is CRITICAL: an unscored judgment (judge flake, 0-atom
  // verdict) contributes no failed atom ids and no failed-score count, so WITHOUT
  // this token its signature would be "" — and the validator's plateau guard
  // `if (firstSig && ...)` short-circuits on empty, making the most common hard-
  // pose failure mode (empty-atoms on multi-subject under a weak judge) BYPASS
  // plateau and burn the full budget (measured 3/3 on L4-02/26b). Counting
  // unscored judgments gives them a stable non-empty signature so repeated judge
  // flakes are caught as a plateau. See goal 0704 §2 + memory
  // self-improve-loop-plateau-blind-to-empty-atoms.
  const failedAtomIds = judgments
    .filter((j) => j.scored && j.style === "pose_dsg")
    .flatMap((j) => (j.failed_atoms || []).map((id) => (j.poseId || "") + ":" + id))
    .sort();
  const failedScoreCount = judgments.filter((j) => j.scored && j.style !== "pose_dsg" && (j.overall < THRESHOLDS.overall || j.artifacts < THRESHOLDS.artifacts)).length;
  const unscoredCount = judgments.filter((j) => !j.scored).length;
  const failedSignature = failedAtomIds
    .concat(failedScoreCount ? ["score:" + failedScoreCount] : [])
    .concat(unscoredCount ? ["unscored:" + unscoredCount] : [])
    .join("|");

  const entry = { attempt, seed: gen.seed, paths: outputs, judgments, poseMatrix, failedCount, meanFaith, ok: v.ok, reason: v.reason, failedSignature, expandedPrompt: expanded[0] || "" };
  trace.push(entry);
  return entry;
}

// gate() feeds validator's `feedback` into the next thunk attempt and exits on
// ok=true or attempts exhausted. Bounded by construction — it cannot hang.
const verdict = await gate(
  (feedback, attempt) => generateThenJudge(feedback, attempt),
  (r) => validate(r),
  { attempts: ATTEMPTS },
);

// ── Comparative best-so-far selection (never absolute score) ────────────────
// If gate succeeded, the last attempt is the winner. Otherwise pick the attempt
// with the fewest failed atoms (tie-break: highest meanFaith, then lowest index).
function pickBest() {
  if (!trace.length) return null;
  const sorted = trace.slice().sort((x, y) => {
    if (x.failedCount !== y.failedCount) return x.failedCount - y.failedCount;
    if (y.meanFaith !== x.meanFaith) return y.meanFaith - x.meanFaith;
    return x.attempt - y.attempt;
  });
  return sorted[0];
}

const best = pickBest();
// Derive WHY gate stopped from the trace's failed-atom signatures (not from a
// `reason` field — validate is called twice per attempt, once inside the thunk
// before the entry is pushed and once by gate after; only the post-push call
// sees the plateau, so its reason is not on the entry. The signature IS.):
//   gate stopped AND last attempt had NO failures  → "converged" (real pass)
//   gate stopped BUT last attempt STILL failed     → "static" (plateau exit)
//   gate did not stop (ran out of attempts)        → "exhausted"
const lastEntry = trace[trace.length - 1] || null;
const lastSig = lastEntry ? lastEntry.failedSignature || "" : "";
const gateStopped = !!verdict.ok;
const converged = gateStopped && lastSig === "";
const staticExit = gateStopped && lastSig !== "";
const terminationReason = converged ? "converged" : staticExit ? "static" : "exhausted";
// On convergence the winner is the last (passing) attempt; on a static-exit or
// exhaustion, pick the BEST attempt (fewest failed atoms) — not the stuck one.
const winnerAttempt = converged ? (lastEntry || best) : best;
const winnerPaths = (winnerAttempt && winnerAttempt.paths) || [];
const winnerPath = winnerPaths[0] || "";
const winnerVerdict = winnerAttempt
  ? {
      attempt: winnerAttempt.attempt,
      seed: winnerAttempt.seed,
      ok: !!winnerAttempt.ok,
      failedCount: winnerAttempt.failedCount,
      meanFaith: winnerAttempt.meanFaith,
      poseMatrix: winnerAttempt.poseMatrix || [],
      judgments: (winnerAttempt.judgments || []).map((j) => {
        if (!j.scored) return { scored: false, style: j.style, path: j.path, error: j.error, needsReview: true };
        if (j.style === "pose_dsg") {
          return { scored: true, style: "pose_dsg", path: j.path, poseId: j.poseId, anatomy_pass: j.anatomy_pass, faithfulness: j.faithfulness, anatomy: j.anatomy, failed_atoms: j.failed_atoms, issues: j.issues };
        }
        return { scored: true, style: "score", path: j.path, overall: j.overall, artifacts: j.artifacts, issues: j.issues };
      }),
    }
  : null;

const attemptsUsed = verdict.attempts || trace.length;
const needsReview = !converged;

log(
  "loop " + (converged ? "CONVERGED" : (staticExit ? "STATIC-EXIT" : (needsReview ? "needsReview" : "done")))
  + " after " + attemptsUsed + "/" + ATTEMPTS + " attempt(s)"
  + (best ? " — best: attempt " + best.attempt + ", failedAtoms=" + best.failedCount + ", meanFaith=" + best.meanFaith.toFixed(2) : ""),
);

// ═══════════════════════════════════════════════════════════════════════════
// Phase: Persist — append winning exemplar (self-generated in-context example)
// ═══════════════════════════════════════════════════════════════════════════
phase("Persist");

// The exemplar is the winning (prompt → params → verdict) triple. Future runs
// can load these as few-shot candidates ("a similar pose converged with this
// prompt expansion"). Capped to MAX_EXEMPLARS active (retire lowest faith).
//
// PERSISTENCE IS NOT MODEL-DRIVEN. The workflow only BUILDS the exemplar and
// returns it (below). The synchronous DRIVER (self-improve-loop.driver.ts)
// appends it to EXEMPLARS_FILE via plain fs after the run — so persistence
// cannot die with a weak-model agent mid-loop (goal 0402 criterion #2). The
// previous version used a model agent here; that was the silent-kill risk the
// live run surfaced.
// Store the WINNING EXPANDED prompt (base + the reflection clause that converged)
// under `winningPrompt`, and the bare pose prompt under `prompt` (for matching).
// The driver loads `winningPrompt` as the next run's few-shot seed (criterion #3).
const exemplar = winnerVerdict
  ? {
      prompt: BASE_PROMPTS[0] || "",
      winningPrompt: winnerAttempt?.expandedPrompt || BASE_PROMPTS[0] || "",
      params: { seed: winnerVerdict.seed, steps: STEPS, width: WIDTH, height: HEIGHT, pipeline: "flux2-t2i" },
      verdict: {
        ok: winnerVerdict.ok,
        attempt: winnerVerdict.attempt,
        failedCount: winnerVerdict.failedCount,
        meanFaith: winnerVerdict.meanFaith,
        faithThreshold: FAITH_THRESHOLD,
        style: POSE_MODE ? "pose_dsg" : "score",
      },
      winnerPath,
      attemptsUsed,
      converged,
    }
  : null;

if (exemplar) {
  log("Exemplar: built (winner attempt " + winnerVerdict.attempt + ", meanFaith=" + winnerVerdict.meanFaith.toFixed(2) + ") — driver appends → " + EXEMPLARS_FILE);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase: Report
// ═══════════════════════════════════════════════════════════════════════════
phase("Report");

function summarize() {
  const head = converged ? "converged" : "needs review";
  const att = " after " + attemptsUsed + "/" + ATTEMPTS + " attempt(s)";
  if (!trace.length) return "failed: no attempts ran";
  const perTarget = (winnerVerdict && winnerVerdict.poseMatrix.length)
    ? "; winner poses " + winnerVerdict.poseMatrix.map((m) => m.poseId + "(faith=" + m.faithfulness.toFixed(2) + "," + (m.anatomy_pass ? "anatomy ok" : "ANATOMY FAIL") + ",failed=" + JSON.stringify(m.failed_atoms) + ")").join(", ")
    : "";
  return head + att + " — best attempt " + (best ? best.attempt : "?") + " (failedAtoms=" + (best ? best.failedCount : "?") + ", meanFaith=" + (best ? best.meanFaith.toFixed(2) : "?") + ")" + perTarget;
}

return {
  ok: converged,
  ext: "flux2",
  loop: true,
  mode: MODE,
  attemptsUsed,
  maxAttempts: ATTEMPTS,
  converged,
  staticExit,
  terminationReason,
  needsReview,
  winnerPath,
  winnerVerdict,
  best: best ? { attempt: best.attempt, failedCount: best.failedCount, meanFaith: best.meanFaith, seed: best.seed } : null,
  trace: trace.map((t) => ({ attempt: t.attempt, seed: t.seed, ok: t.ok, failedCount: t.failedCount, meanFaith: t.meanFaith, failedSignature: t.failedSignature || "", genError: t.genError || "" })),
  exemplar,
  exemplarsFile: EXEMPLARS_FILE,
  maxExemplars: MAX_EXEMPLARS,
  summary: summarize(),
};
