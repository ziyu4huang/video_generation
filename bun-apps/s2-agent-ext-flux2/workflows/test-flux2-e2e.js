// @ts-nocheck
/**
 * test-flux2-e2e.js — canonical L2 judgment e2e for s2-agent-ext-flux2.
 *
 * SHAPE (shared by every s2-agent-ext-* L2 workflow — see bun-apps/s2-agent/PRD.md):
 *   Phase "Generate" — agent drives the extension's CLI via bash → output PNG(s).
 *   Phase "Judge"    — parallel agents run the local VLM scorer (`run.py caption
 *                      --style score`) on each output and parse the score JSON.
 *   Synthesize       — plain JS: pass iff every output clears thresholds.
 *
 * WHY THIS CONTENT LIVES HERE (not in bun test)
 *   "Is the generated image GOOD and on-prompt?" is a judgment question `bun test`
 *   cannot answer. The deterministic surface (flag mapping, exit codes, dimensions,
 *   manifest parse) is covered by `s2-agent-ext-flux2/src/*.test.ts`. This workflow
 *   only covers the judgment layer.
 *
 * INVOCATION (unified runner)
 *   bash bun-apps/s2-agent/scripts/run-ext-e2e.sh flux2
 *   # or directly:
 *   bun-apps/s2-agent/run.sh -e workflow -p \
 *     "read bun-apps/s2-agent-ext-flux2/workflows/test-flux2-e2e.js and execute it via the workflow tool (background:false)"
 */

export const meta = {
  name: "test_flux2_e2e",
  description:
    "L2 judgment e2e for s2-agent-ext-flux2: generate via the flux2 CLI, then VLM-score each output (run.py caption --style score). Pass = every output clears conservative quality thresholds.",
  phases: [
    { title: "Generate" },
    { title: "Judge" },
  ],
};

// ─── Inputs (overridable via the workflow tool's `args`) ────────────────────
const a = (typeof args === "object" && args) || {};
const REPO_ROOT = String(a.repoRoot || cwd);
const FLUX2 = REPO_ROOT + "/swift/flux2-image-director/.build/release/flux2";
const OUT_DIR = String(a.outDir || REPO_ROOT + "/../video_generation__output/wf-e2e-flux2");
const NAME = String(a.name || "wf_e2e_judge");
const SEED = Number(a.seed ?? 42);
const WIDTH = Number(a.width ?? 768);
const HEIGHT = Number(a.height ?? 768);
const STEPS = Number(a.steps ?? 4);

// MLX venv: probed at judge time (worktree may use ../video_generation__venv).
const VENV_CANDIDATES = [
  REPO_ROOT + "/python/venv/bin/python",
  REPO_ROOT + "/../video_generation__venv/bin/python",
];

const PROMPTS = (a.prompts && Array.isArray(a.prompts))
  ? a.prompts
  : [
      "a red apple on a wooden table, soft window light, photorealistic",
      "a portrait of a young woman with freckles, natural light, 50mm",
    ];

// POSE MODE (opt-in). Pass `poses` (entries lifted verbatim from poses.json:
// {id, prompt, failure_modes, atoms:[{id,q}]}) to drive BOTH generation and
// judging from the pose library. Each output is then judged with the atomic
// `pose_dsg` validator instead of the holistic `score` (which over-praises
// complex poses — see docs/pose-validation.md §1). When `poses` is absent the
// workflow falls back to `score` judging on `prompts` (the regression-tested
// path). poses and prompts MAY coexist; poses win for their indices.
const POSES = (a.poses && Array.isArray(a.poses))
  ? a.poses.filter((p) => p && typeof p.prompt === "string" && Array.isArray(p.atoms))
  : [];

// Conservative thresholds — the local VLM over-scores (overall 9–10 for clean
// images), so 6 is a real "clearly acceptable" floor, not a high bar. The signal
// that matters is REGRESSION between commits, not the absolute number.
const THRESHOLDS = { overall: 6, artifacts: 6 };
const BLOCKING_ISSUE = /extra limb|fused|mutated|extra fingers|deformed|nsfw|blank|nan/i;
// Pose gate: anatomy_pass is a HARD fail (a six-fingered hand is not redeemed by
// a correct background); faithfulness is the atomic prompt-match ratio, floored
// at 0.8 (recomputed in Python by parse_pose_dsg — never trusted from the model).
const FAITH_THRESHOLD = Number(a.faithThreshold ?? 0.8);

// Generation prompt list. In pose mode, drive generation from the pose prompts
// (each pose carries its own prompt + atoms); otherwise use the bare prompts.
const GEN_PROMPTS = POSES.length ? POSES.map((p) => p.prompt) : PROMPTS;

// ─── Phase 1: generate one PNG per prompt via the flux2 CLI ─────────────────
phase("Generate");

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

log("Generating " + GEN_PROMPTS.length + " flux2 t2i output(s) at " + WIDTH + "x" + HEIGHT + (POSES.length ? " (pose_dsg mode)" : ""));

// Generate. We capture BOTH throw (schema-retry exhausted / non-recoverable) and
// a null return (terminal API error after retries) — either way `gen` is null and
// genThrown carries the reason, so the synthesize step can surface a REAL error
// instead of the silent "no outputs generated" that hides the root cause.
let gen = null;
let genThrown = "";
try {
  gen = await agent(
    [
      "Generate one flux2 t2i PNG per prompt, in order. Repo root: " + REPO_ROOT + ". Binary: " + FLUX2 + ".",
      "FIRST ensure the binary is ready: " + FLUX2 + " --help must exit 0. If missing, build: `( cd " + REPO_ROOT + "/swift/flux2-image-director && swift build -c release )` then `bash " + REPO_ROOT + "/swift/flux2-image-director/scripts/build-metallib.sh`. Skip metallib if .build/release/mlx.metallib already exists. This may take minutes on first build — use a long timeout.",
      "Then run ONE flux2 t2i per prompt (i index 0..N-1):",
      "  " + FLUX2 + " t2i --prompt <prompt> --seed " + SEED + " --width " + WIDTH + " --height " + HEIGHT + " --steps " + STEPS + " --output-dir " + JSON.stringify(OUT_DIR) + " --name " + JSON.stringify(NAME) + "_<i>",
      "Each run loads a 9B model — expect ~1-3 min each. Use a long timeout; if your bash tool times out, run nohup ... & and poll for the PNG, then read the log.",
      "On success flux2 prints a `✅ generated <name>` line, then an indented ABSOLUTE png path, then `   manifest:   <path>.manifest.json`. Use the manifest JSON's output field, or the indented line, to get the EXACT absolute path.",
      "Return ok=true only if EVERY prompt produced a PNG that exists with non-zero size. Return paths[] in prompt order (absolute). Put any failure tail in `error`.",
      "Prompts (in order): " + JSON.stringify(GEN_PROMPTS),
    ].join("\n"),
    { label: "flux2 t2i generate", tier: "small", schema: GEN_SCHEMA },
  );
} catch (e) {
  genThrown = (e && e.message) ? String(e.message) : String(e);
  gen = null;
}

// ─── Phase 2: VLM-judge each output in parallel ────────────────────────────
phase("Judge");

const JUDGE_SCHEMA = {
  type: "object",
  required: ["ok", "path", "overall", "artifacts"],
  properties: {
    ok: { type: "boolean", description: "VLM scorer ran and produced a parseable score JSON." },
    path: { type: "string", description: "The PNG path that was scored." },
    overall: { type: "integer", description: "VLM overall score (0-10)." },
    detail: { type: "integer" },
    sharpness: { type: "integer" },
    composition: { type: "integer" },
    prompt_adherence: { type: "integer" },
    artifacts: { type: "integer", description: "VLM artifacts score (0-10, higher = fewer artifacts)." },
    issues: { type: "array", items: { type: "string" }, description: "Defect strings the VLM listed." },
    rawTail: { type: "string", description: "Short tail of the scorer output for debugging." },
  },
  additionalProperties: false,
};

// pose_dsg verdict schema (atomic faithfulness + AbHuman anatomy gate).
const JUDGE_POSE_SCHEMA = {
  type: "object",
  required: ["ok", "path", "anatomy_pass", "faithfulness", "atoms"],
  properties: {
    ok: { type: "boolean", description: "pose_dsg scorer ran and produced a parseable verdict." },
    path: { type: "string", description: "The PNG path that was scored." },
    poseId: { type: "string", description: "The pose id from poses.json (e.g. L3-01)." },
    anatomy_pass: { type: "boolean", description: "Hard anatomy gate (recomputed in Python)." },
    faithfulness: { type: "number", description: "atoms present / total (recomputed in Python, 0..1)." },
    anatomy: {
      type: "object",
      description: "AbHuman fields: limb_count, hands, face (true/false/null), pose_plausible.",
      properties: {
        limb_count: { type: "boolean" },
        hands: { type: "boolean" },
        face: { type: ["boolean", "null"] },
        pose_plausible: { type: "boolean" },
      },
    },
    atoms: {
      type: "array",
      description: "One entry per atomic proposition, with the VLM's present verdict.",
      items: {
        type: "object",
        required: ["id", "present"],
        properties: {
          id: { type: "string" },
          q: { type: "string" },
          present: { type: "boolean" },
          confidence: { type: "number" },
        },
      },
    },
    issues: { type: "array", items: { type: "string" }, description: "Defect strings the VLM listed." },
    rawTail: { type: "string", description: "Short tail of the scorer output for debugging." },
  },
  additionalProperties: false,
};

const outputs = (gen && gen.ok && Array.isArray(gen.paths)) ? gen.paths.filter(Boolean) : [];

function venvProbeInstruction() {
  return "The MLX venv python is at ONE of: " + VENV_CANDIDATES.join(" or ")
    + ". Probe `[ -x <path> ]` and use the first that exists. (In a worktree it is usually the sibling ../video_generation__venv.)";
}

// Judge ONE output. NEVER silently drop a failure: a thrown agent (transient
// exhausted, schema non-compliance, PROVIDER_USAGE_LIMIT) or a null/shapeless
// return becomes an explicit {scored:false,...} entry carrying the reason. This
// is the workflow-layer defense against the engine's null→default pattern
// (RCA#4/#7): `judgments` is always one-entry-per-output, so a caller can never
// mistake "could not score" for "scored and passed".
//
// STYLE-AWARE: in pose mode (POSES[i] present) judge with the atomic `pose_dsg`
// validator (gate: anatomy_pass && faithfulness); otherwise fall back to the
// holistic `score` (gate: overall/artifacts thresholds). See docs/pose-validation.md.
async function judgeOne(p, i) {
  const pose = POSES[i] || null;
  if (pose) return judgePose(p, i, pose);
  return judgeScore(p, i);
}

// Holistic score path (still-lifes / non-pose prompts).
async function judgeScore(p, i) {
  try {
    const j = await agent(
      [
        "Score this generated image with the local VLM. Repo root: " + REPO_ROOT + ".",
        venvProbeInstruction(),
        "Run: <python> " + REPO_ROOT + "/python/mlx-movie-director/run.py caption " + JSON.stringify(p) + " --style score --lang en",
        "This loads a VLM (Qwen3-VL/Gemma) — ~1 min. Use a long timeout.",
        "It prints a line like `[score] {\"overall\":9,\"detail\":8,\"sharpness\":9,\"composition\":9,\"prompt_adherence\":10,\"artifacts\":10,\"issues\":[...]}` and saves <p>.caption.json. Parse the JSON (from the [score] line OR the .caption.json file).",
        "Return ok=true iff you got a parseable score with overall + artifacts. Copy overall/detail/sharpness/composition/prompt_adherence/artifacts and issues[] verbatim from the VLM JSON. Put a short scorer output tail in rawTail. Set path=" + JSON.stringify(p) + ".",
      ].join("\n"),
      { label: "vlm score output " + (i + 1), tier: "small", schema: JUDGE_SCHEMA },
    );
    if (!j || typeof j.overall !== "number" || typeof j.artifacts !== "number") {
      return { scored: false, style: "score", path: p, error: "scorer returned no parseable score", rawTail: (j && j.rawTail) || "" };
    }
    return {
      scored: true,
      style: "score",
      path: p,
      overall: j.overall,
      detail: j.detail,
      sharpness: j.sharpness,
      composition: j.composition,
      prompt_adherence: j.prompt_adherence,
      artifacts: j.artifacts,
      issues: Array.isArray(j.issues) ? j.issues : [],
    };
  } catch (e) {
    return { scored: false, style: "score", path: p, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

// Atomic pose_dsg path (complex human poses). Writes the pose's atoms to a temp
// file via a quoted heredoc (apostrophes in atom questions are safe inside
// 'EOF'), then runs caption --style pose_dsg --prompt --atoms <file>. The VLM
// verifies each atom; Python recomputes faithfulness + anatomy_pass, so we trust
// those two fields (they are NOT the model's arithmetic).
async function judgePose(p, i, pose) {
  const atomsJson = JSON.stringify({ atoms: pose.atoms }, null, 2);
  const atomsFile = "/tmp/flux2_pose_atoms_" + i + ".json";
  try {
    const j = await agent(
      [
        "Validate this generated pose image with the local VLM's pose_dsg scorer. Repo root: " + REPO_ROOT + ".",
        venvProbeInstruction(),
        "FIRST write the atoms JSON to a temp file with a quoted heredoc (apostrophes are safe inside the quoted delimiter):",
        "  cat > " + atomsFile + " <<'POSE_ATOMS_EOF'",
        atomsJson,
        "POSE_ATOMS_EOF",
        "Then run: <python> " + REPO_ROOT + "/python/mlx-movie-director/run.py caption " + JSON.stringify(p) + " --style pose_dsg --prompt " + JSON.stringify(pose.prompt) + " --atoms " + atomsFile + " --lang en",
        "This loads a VLM (Qwen3-VL/Gemma) — ~1 min. Use a long timeout.",
        "It saves <p>.caption.json with styles.pose_dsg = {atoms:[{id,q,present,confidence}], faithfulness, anatomy:{limb_count,hands,face,pose_plausible}, anatomy_pass, issues, summary}. faithfulness and anatomy_pass are RECOMPUTED in Python (not the model's own).",
        "Parse that JSON (read <p>.caption.json, take styles.pose_dsg). Return ok=true iff you got anatomy_pass (boolean) + faithfulness (number) + atoms[]. Copy anatomy_pass, faithfulness, anatomy, atoms[] (id/q/present/confidence), issues[] verbatim. Set path=" + JSON.stringify(p) + " and poseId=" + JSON.stringify(pose.id || "") + ". Put a short scorer output tail in rawTail.",
      ].join("\n"),
      { label: "vlm pose_dsg output " + (i + 1), tier: "small", schema: JUDGE_POSE_SCHEMA },
    );
    if (!j || typeof j.anatomy_pass !== "boolean" || typeof j.faithfulness !== "number" || !Array.isArray(j.atoms)) {
      return { scored: false, style: "pose_dsg", path: p, poseId: pose.id || "", error: "pose_dsg returned no parseable verdict", rawTail: (j && j.rawTail) || "" };
    }
    const failed = j.atoms.filter((x) => x && x.present === false).map((x) => x.id);
    return {
      scored: true,
      style: "pose_dsg",
      path: p,
      poseId: pose.id || "",
      anatomy_pass: j.anatomy_pass,
      faithfulness: j.faithfulness,
      anatomy: j.anatomy || {},
      atoms: j.atoms,
      failed_atoms: failed,
      issues: Array.isArray(j.issues) ? j.issues : [],
    };
  } catch (e) {
    return { scored: false, style: "pose_dsg", path: p, poseId: pose.id || "", error: (e && e.message) ? String(e.message) : String(e) };
  }
}

const judgments = outputs.length
  ? await parallel(outputs.map((p, i) => () => judgeOne(p, i)))
  : [];

// ─── Synthesize (plain JS) ─────────────────────────────────────────────────
// judgments is already one-entry-per-output (no .filter(Boolean) drop). Split
// into scored / unscored so the silent-failure path is observable and ok can
// never be true while an output remains unjudged. Failures split by style:
// score outputs gate on overall/artifacts; pose_dsg outputs gate on the hard
// anatomy_pass + faithfulness>=threshold (anatomy_pass=false ALWAYS fails).
const scored = judgments.filter((j) => j && j.scored);
const unscored = judgments.filter((j) => j && !j.scored);
const failedThresholds = scored
  .filter((j) => j.style !== "pose_dsg")
  .filter((j) =>
    j.overall < THRESHOLDS.overall ||
    j.artifacts < THRESHOLDS.artifacts ||
    (Array.isArray(j.issues) && j.issues.some((s) => BLOCKING_ISSUE.test(String(s)))),
  );
const failedPoses = scored
  .filter((j) => j.style === "pose_dsg")
  .filter((j) => j.anatomy_pass === false || j.faithfulness < FAITH_THRESHOLD);
const anyFailed = failedThresholds.length > 0 || failedPoses.length > 0;
const ok = outputs.length > 0 && unscored.length === 0 && !anyFailed;
const overalls = scored.filter((j) => j.style !== "pose_dsg").map((j) => j.overall).filter((x) => typeof x === "number").sort((x, y) => x - y);
const median = overalls.length ? overalls[Math.floor(overalls.length / 2)] : 0;
const needsReview = unscored.length > 0;

// Per-pose × per-atom regression matrix — the real signal L2 is after. A commit
// that drops pose L3-01 atom a4 (arm reaches back to ankle) from present→absent
// shows up here even if the holistic overall score is unchanged. Stable atom
// ids let a caller diff this matrix commit-over-commit.
const poseMatrix = scored
  .filter((j) => j.style === "pose_dsg")
  .map((j) => ({
    poseId: j.poseId,
    path: j.path,
    anatomy_pass: j.anatomy_pass,
    faithfulness: j.faithfulness,
    failed_atoms: j.failed_atoms || [],
    atoms: (j.atoms || []).map((x) => ({ id: x.id, q: x.q, present: x.present })),
  }));

function summarize() {
  if (!outputs.length) {
    return "failed: no outputs generated" + (genError ? " (" + genError + ")" : "");
  }
  if (unscored.length) {
    return "needs review: " + unscored.length + "/" + outputs.length
      + " output(s) could not be scored — "
      + unscored.map((u) => u.path + " [" + u.error + "]").join("; ");
  }
  if (failedPoses.length) {
    return "failed poses: " + failedPoses
      .map((f) => f.poseId + " (anatomy_pass=" + f.anatomy_pass + ",faithfulness=" + f.faithfulness.toFixed(2) + ",failed_atoms=" + JSON.stringify(f.failed_atoms) + ")")
      .join("; ");
  }
  if (failedThresholds.length) {
    return "failed: " + failedThresholds
      .map((f) => f.path + " (overall=" + f.overall + ",artifacts=" + f.artifacts + ",issues=" + JSON.stringify(f.issues) + ")")
      .join("; ");
  }
  const poseNote = poseMatrix.length
    ? "; poses " + poseMatrix.map((m) => m.poseId + "(faith=" + m.faithfulness.toFixed(2) + "," + (m.anatomy_pass ? "anatomy ok" : "ANATOMY FAIL") + ")").join(", ")
    : "";
  return scored.length + "/" + outputs.length + " outputs cleared thresholds (median overall " + median + ")" + poseNote;
}

const genError = genThrown
  || (gen && gen.error ? gen.error : "")
  || (gen && gen.ok ? "" : (gen ? "generation returned ok=false" : "generation agent returned no result"));

return {
  ok,
  ext: "flux2",
  outputs,
  // One entry per output. scored:false entries make a silent judge failure
  // inspectable instead of dropped (needsReview=true).
  judgments: judgments.map((j) => {
    if (!j || !j.scored) {
      return { scored: false, style: (j && j.style) || "score", path: j && j.path, poseId: j && j.poseId, error: (j && j.error) || "unknown", needsReview: true };
    }
    if (j.style === "pose_dsg") {
      return {
        scored: true,
        style: "pose_dsg",
        path: j.path,
        poseId: j.poseId,
        anatomy_pass: j.anatomy_pass,
        faithfulness: j.faithfulness,
        anatomy: j.anatomy,
        atoms: j.atoms,
        failed_atoms: j.failed_atoms,
        issues: j.issues,
      };
    }
    return {
      scored: true,
      style: "score",
      path: j.path,
      overall: j.overall,
      detail: j.detail,
      sharpness: j.sharpness,
      composition: j.composition,
      prompt_adherence: j.prompt_adherence,
      artifacts: j.artifacts,
      issues: j.issues,
    };
  }),
  thresholds: THRESHOLDS,
  faithThreshold: FAITH_THRESHOLD,
  poseMatrix,
  needsReview,
  summary: summarize(),
  genError,
};
