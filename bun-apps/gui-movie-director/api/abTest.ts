import fs from "fs";
import path from "path";
import { loadConfig, vlmModelIsAuto, REPO_DIR } from "../lib/config";
import { OUTPUT_DIRS, RUN_PY, MODELS_DIR } from "../lib/paths";
import { readJsonFile } from "../lib/fsUtils";
import { parsePostJson } from "../lib/requestUtils";
import { findCompanionJson } from "./gallery";
import { normalizeCaptionFile } from "../lib/captionFormat";

/**
 * In-gallery A/B test. Given two gallery image URLs, runs the same analysis the
 * 4-bit-vs-8-bit manual workflow used (signal metrics via `run.py image quality`,
 * pixel diff SSIM/PSNR + an amplified heatmap via app/ab_diff.py, and an optional
 * VLM `caption --style score` on each), then assembles a LEAN feedback JSON.
 *
 * The JSON is a pointer-manifest: it references the real run.json / manifest.json
 * / model-dir paths (so Claude Code can read full detail) rather than inlining
 * every param, and carries computed results + explicit `action_hints` so the agent
 * knows where and what to do. The endpoint returns the JSON; the frontend copies
 * it to the clipboard (no file is written for the JSON itself — only the heatmap).
 */

// --- quant-suffix normalization (mirrors frontend/utils/galleryGroup.ts) ----
// Strips trailing quant/format markers so a 4-bit vs 8-bit pair (same base) is
// detected as a quant A/B, not two different models.
const QUANT_SUFFIX_RE =
  /-((?:4|8|16|32)bit(?:-g\d+)?|bf16|fp16|fp8|f16|f8|requant(?:-test)?)$/;
export function normalizeTransformerKey(t: string | null | undefined): string {
  return t ? t.replace(QUANT_SUFFIX_RE, "") : "";
}

// run.json fields whose difference defines the A/B "lever".
const LEVER_FIELDS = [
  "transformer",
  "seed",
  "steps",
  "cfg_scale",
  "pipeline",
  "lora_path",
  "lora_paths",
  "loras",
  "lora_scale",
  "width",
  "height",
  "denoise_strength",
] as const;

export interface LeverResult {
  lever: string;
  diff_fields: string[];
}

/** Detect which run param differs between A and B → the tested lever. */
export function detectLever(
  aRun: Record<string, any> | null,
  bRun: Record<string, any> | null,
): LeverResult {
  if (!aRun || !bRun) return { lever: "unknown", diff_fields: [] };
  const diff = LEVER_FIELDS.filter((f) => {
    const av = aRun[f], bv = bRun[f];
    if (av === undefined && bv === undefined) return false;
    return JSON.stringify(av) !== JSON.stringify(bv);
  });
  let lever = "multi";
  if (diff.length === 0) lever = "none";
  else if (diff.length === 1) {
    const f = diff[0];
    if (f === "transformer") {
      const ta = normalizeTransformerKey(aRun.transformer);
      const tb = normalizeTransformerKey(bRun.transformer);
      lever = ta && ta === tb ? "transformer-quant" : "transformer";
    } else if (f.startsWith("lora")) lever = "lora";
    else if (f === "width" || f === "height") lever = "resolution";
    else lever = f;
  } else {
    // transformer + quant-suffix-only difference plus others?
    lever = "multi:" + diff.join(",");
  }
  return { lever, diff_fields: diff };
}

export interface AbFeedback {
  schema: string;
  intent: string;
  lever: string;
  pair: Array<{
    role: "A" | "B";
    name: string;
    url: string;
    run_path: string | null;
    manifest_path: string | null;
    transformer: string | null;
    model_format: string | null;
    model_dir: string | null;
    key_params: Record<string, any>;
  }>;
  diff_fields: string[];
  analysis: {
    signal_metrics: Record<string, any>;
    pixel_diff: Record<string, any> | null;
    vlm_scores: Record<string, any> | null;
  };
  verdict: { winner: "A" | "B" | "tie"; rationale: string; user_note: string };
  diff_heatmap_url: string | null;
  action_hints: Record<string, any>;
}

interface ModelInfo {
  format: string | null;
  dir: string | null;
}

function lookupModel(transformer: string | null | undefined): ModelInfo {
  if (!transformer) return { format: null, dir: null };
  // zimage transformers live under models/transformer/<name>/manifest.json
  const dir = path.join(MODELS_DIR, "transformer", transformer);
  const man = path.join(dir, "manifest.json");
  if (fs.existsSync(man)) {
    const m = readJsonFile<Record<string, any>>(man);
    return { format: m?.format ?? null, dir: path.relative(REPO_DIR, dir) + "/" };
  }
  return { format: null, dir: null };
}

function keyParams(run: Record<string, any> | null): Record<string, any> {
  if (!run) return {};
  const out: Record<string, any> = {};
  for (const k of ["pipeline", "seed", "steps", "cfg_scale", "width", "height"]) {
    if (run[k] !== undefined && run[k] !== null) out[k] = run[k];
  }
  return out;
}

/** Build the lean pointer-manifest feedback object. Pure — unit-tested. */
export function buildAbFeedback(args: {
  intent: string;
  lever: LeverResult;
  a: { name: string; url: string; runPath: string | null; manifestPath: string | null; run: Record<string, any> | null };
  b: { name: string; url: string; runPath: string | null; manifestPath: string | null; run: Record<string, any> | null };
  signalMetrics: Record<string, any>;
  pixelDiff: Record<string, any> | null;
  vlmScores: Record<string, any> | null;
  heatmapUrl: string | null;
  userNote?: string;
}): AbFeedback {
  const { lever, a, b } = args;
  const aModel = lookupModel(a.run?.transformer);
  const bModel = lookupModel(b.run?.transformer);

  const winner = deriveWinner(args.vlmScores, args.signalMetrics);
  const regen = buildRegenCommand(a.run, b.run, lever);

  const modelDirs: Record<string, string> = {};
  if (a.run?.transformer && aModel.dir) modelDirs[a.run.transformer] = aModel.dir;
  if (b.run?.transformer && bModel.dir && b.run.transformer !== a.run?.transformer) {
    modelDirs[b.run.transformer] = bModel.dir;
  }

  return {
    schema: "ab-feedback/v1",
    intent: args.intent || `A/B test — lever: ${lever.lever}`,
    lever: lever.lever,
    pair: [
      {
        role: "A",
        name: a.name,
        url: a.url,
        run_path: a.runPath ? path.relative(REPO_DIR, a.runPath) : null,
        manifest_path: a.manifestPath ? path.relative(REPO_DIR, a.manifestPath) : null,
        transformer: a.run?.transformer ?? null,
        model_format: aModel.format,
        model_dir: aModel.dir,
        key_params: keyParams(a.run),
      },
      {
        role: "B",
        name: b.name,
        url: b.url,
        run_path: b.runPath ? path.relative(REPO_DIR, b.runPath) : null,
        manifest_path: b.manifestPath ? path.relative(REPO_DIR, b.manifestPath) : null,
        transformer: b.run?.transformer ?? null,
        model_format: bModel.format,
        model_dir: bModel.dir,
        key_params: keyParams(b.run),
      },
    ],
    diff_fields: lever.diff_fields,
    analysis: {
      signal_metrics: args.signalMetrics,
      pixel_diff: args.pixelDiff,
      vlm_scores: args.vlmScores,
    },
    verdict: {
      winner: winner.winner,
      rationale: winner.rationale,
      user_note: args.userNote ?? "",
    },
    diff_heatmap_url: args.heatmapUrl,
    action_hints: {
      what_to_do: deriveWhatToDo(lever, winner, aModel, bModel, a.run, b.run, args.signalMetrics),
      regen_command: regen,
      model_dirs: modelDirs,
      read_for_full_detail:
        "each pair entry's run_path / manifest_path carry the complete param set; read them for full detail before acting.",
    },
  };
}

function deriveWinner(
  vlm: Record<string, any> | null,
  metrics: Record<string, any>,
): { winner: "A" | "B" | "tie"; rationale: string } {
  // Prefer the perceptual VLM overall score; fall back to signal-metric win count.
  if (vlm?.A?.overall != null && vlm?.B?.overall != null) {
    const d = vlm.A.overall - vlm.B.overall;
    if (d >= 1) return { winner: "A", rationale: `VLM overall A=${vlm.A.overall} > B=${vlm.B.overall}` };
    if (d <= -1) return { winner: "B", rationale: `VLM overall B=${vlm.B.overall} > A=${vlm.A.overall}` };
    return { winner: "tie", rationale: `VLM overall tied (A=${vlm.A.overall}, B=${vlm.B.overall})` };
  }
  const winners = metrics?.winners ?? {};
  const counts: Record<string, number> = { A: 0, B: 0 };
  for (const w of Object.values(winners)) {
    if (w === "A") counts.A++;
    else if (w === "B") counts.B++;
  }
  if (counts.A > counts.B) return { winner: "A", rationale: `signal metrics: A wins ${counts.A} vs B ${counts.B}` };
  if (counts.B > counts.A) return { winner: "B", rationale: `signal metrics: B wins ${counts.B} vs A ${counts.A}` };
  return { winner: "tie", rationale: "no VLM; signal metrics tied" };
}

/** A/B values of the primary lever field, so the hint can name the actual range. */
function leverValues(
  lever: LeverResult,
  aRun: Record<string, any> | null,
  bRun: Record<string, any> | null,
): { field: string; aVal: any; bVal: any } | null {
  const f = lever.diff_fields[0];
  if (!f || !aRun || !bRun) return null;
  return { field: f, aVal: aRun[f], bVal: bRun[f] };
}

/** Group signal metrics by winner → "B wins sharpness, edge_density; A wins contrast, …". */
function signalWinnerSummary(signalMetrics: Record<string, any> | null): string {
  const winners: Record<string, any> = signalMetrics?.winners ?? {};
  const groups: Record<string, string[]> = { A: [], B: [] };
  for (const [metric, w] of Object.entries(winners)) {
    if (w === "A" || w === "B") groups[w].push(metric);
  }
  const parts: string[] = [];
  for (const w of ["A", "B"] as const) {
    if (groups[w].length) parts.push(`${w} wins ${groups[w].join(", ")}`);
  }
  return parts.join("; ") || "metrics tied";
}

function deriveWhatToDo(
  lever: LeverResult,
  winner: { winner: string },
  aModel: ModelInfo,
  bModel: ModelInfo,
  aRun: Record<string, any> | null,
  bRun: Record<string, any> | null,
  signalMetrics: Record<string, any> | null,
): string {
  const lv = leverValues(lever, aRun, bRun);
  const range =
    lv && lv.aVal != null && lv.bVal != null && String(lv.aVal) !== String(lv.bVal)
      ? ` (A=${lv.aVal} vs B=${lv.bVal})`
      : "";
  if (lever.lever === "transformer-quant") {
    if (winner.winner === "tie") {
      const lower = (aModel.format?.includes("4bit") ? "A" : bModel.format?.includes("4bit") ? "B" : null);
      return `Quant depth is NOT a quality lever here (tie). Keep the lower-memory option${lower ? ` (${lower}, 4-bit)` : ""}; don't re-run quant A/B for this subject.`;
    }
    return `Quant depth moved quality (${winner.winner} wins). If the winner is the higher-bit model and the gain justifies the +memory, switch; else keep 4-bit.`;
  }
  if (lever.lever === "none") return "No param differs between A and B — these may be near-duplicates; check seeds/run identity before drawing conclusions.";
  if (winner.winner === "tie") {
    // Generic-lever tie: there is no winner to "tune toward", so name the
    // signal tradeoff instead and let the user pick by priority.
    return `Lever '${lever.lever}'${range} did not produce a clear VLM winner (tie). Signal tradeoff — ${signalWinnerSummary(signalMetrics)}. No single best: pick by your priority (e.g. sharpness vs cleanliness) or re-run with a wider lever range for a decisive result.`;
  }
  const w = winner.winner === "A" ? "A" : "B";
  const target = lv ? (winner.winner === "A" ? lv.aVal : lv.bVal) : null;
  return `Lever '${lever.lever}'${range} → ${w} wins${target != null ? ` (move toward ${target})` : ""}. See regen_command to reproduce the winning arm.`;
}

function buildRegenCommand(
  aRun: Record<string, any> | null,
  bRun: Record<string, any> | null,
  lever: LeverResult,
): string {
  const base = aRun ?? bRun;
  if (!base) return "(no run.json — cannot reconstruct command)";
  const diff = new Set(lever.diff_fields);
  const pipeline = base.pipeline ?? "zimage";
  const sub = pipeline === "zimage" ? "t2i" : "t2i";
  // For the lever field under test, emit an <A-val|B-val> placeholder so the
  // varied param (and both arms) is obvious; otherwise reproduce the shared
  // value. Previously only `transformer` got this treatment — now every scalar
  // lever (seed/steps/cfg_scale/width/height) surfaces its A/B range too.
  const val = (field: string): string => {
    const av = aRun?.[field];
    const bv = bRun?.[field];
    if (diff.has(field) && av != null && bv != null && String(av) !== String(bv)) {
      return `<${av}|${bv}>`;
    }
    return String(base[field] ?? "");
  };
  const t = val("transformer") || "<transformer>";
  const parts = [
    "python/venv/bin/python",
    "python/mlx-movie-director/run.py",
    "image",
    sub,
    "--transformer", t,
  ];
  if (base.seed != null) parts.push("--seed", val("seed") || "<seed>");
  if (base.steps != null) parts.push("--steps", val("steps") || "<steps>");
  if (base.cfg_scale != null) parts.push("--cfg-scale", val("cfg_scale") || "<cfg>");
  if (base.width != null && base.height != null) parts.push("--width", val("width"), "--height", val("height"));
  if (base.prompt) parts.push("--prompt", `'${String(base.prompt).replace(/'/g, "'\\''")}'`);
  return parts.join(" ");
}

// --- subprocess helper (drains both pipes — see caption.ts:88-93 why) --------
async function spawnCapture(cmd: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env });
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout: await stdoutP, stderr: await stderrP };
}

/**
 * Pull the parsed VLM score object out of a normalized caption file. The score
 * style stores its payload as a JSON STRING in `entry.caption` (e.g.
 * `'{"overall":9,"detail":8,...}'`), NOT under a `score` key — so we parse it.
 */
function extractScoreFromCap(cap: any): any | null {
  if (!cap) return null;
  const entry = cap.styles?.score ?? (cap.style === "score" ? cap : null);
  if (!entry) return null;
  const raw = entry.caption;
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  return obj && typeof obj === "object" ? obj : null;
}

function resolveGalleryUrl(url: string): { abs: string; dirIdx: number } | null {
  const m = url.match(/^\/output\/(\d+)\/(.+)/);
  if (!m) return null;
  const dirIdx = parseInt(m[1], 10);
  if (dirIdx < 0 || dirIdx >= OUTPUT_DIRS.length) return null;
  const abs = path.join(OUTPUT_DIRS[dirIdx], m[2]);
  // strict containment
  const resolved = path.resolve(abs);
  if (!OUTPUT_DIRS.some((d) => resolved.startsWith(d + path.sep) || resolved === d)) return null;
  return { abs: resolved, dirIdx };
}

export async function handleAbTest(req: Request): Promise<Response> {
  const body = await parsePostJson<{
    a?: { url?: string };
    b?: { url?: string };
    intent?: string;
    skipVlm?: boolean;
    userNote?: string;
  }>(req);
  if (body instanceof Response) return body;

  const aUrl = body.a?.url, bUrl = body.b?.url;
  if (!aUrl || !bUrl) {
    return Response.json({ ok: false, error: "Missing 'a.url' or 'b.url'" }, { status: 400 });
  }
  const aRes = resolveGalleryUrl(aUrl);
  const bRes = resolveGalleryUrl(bUrl);
  if (!aRes || !bRes) {
    return Response.json({ ok: false, error: "Invalid gallery URL (expected /output/<idx>/<name>)" }, { status: 400 });
  }
  // A/B analysis is image-only: the diff heatmap + no-reference metrics + VLM
  // skin scoring all operate on still images. Reject video pairs explicitly
  // rather than silently emitting empty metrics.
  const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  const isImage = (p: string) => IMAGE_EXT.has(path.extname(p).toLowerCase());
  if (!isImage(aRes.abs) || !isImage(bRes.abs)) {
    return Response.json(
      { ok: false, error: "A/B analysis supports image pairs only (got a video). Pick two images." },
      { status: 400 },
    );
  }

  const cfg = loadConfig();
  const py = cfg.pythonPath;
  const abDiffPy = path.join(REPO_DIR, "python", "mlx-movie-director", "app", "ab_diff.py");

  // --- read run.json + manifest.json companions for each image ---
  const readCompanions = (abs: string) => {
    const dir = path.dirname(abs);
    const base = path.basename(abs).replace(/\.[^.]+$/, "");
    const runPath = findCompanionJson(dir, base, ".run.json");
    const manifestPath = findCompanionJson(dir, base, ".manifest.json");
    return {
      runPath,
      manifestPath,
      run: runPath ? readJsonFile<Record<string, any>>(runPath) : null,
    };
  };
  const aComp = readCompanions(aRes.abs);
  const bComp = readCompanions(bRes.abs);

  // --- 1. signal metrics via run.py image quality ---
  const qJson = path.join(OUTPUT_DIRS[aRes.dirIdx], "ab_analysis", `_q_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(qJson), { recursive: true });
  const qRes = await spawnCapture(
    [py, RUN_PY, "image", "quality", "--quality-inputs", aRes.abs, bRes.abs, "--quality-labels", "A,B", "--quality-json", qJson, "--no-html", "--no-compare-png"],
    { ...process.env },
  );
  let signalMetrics: Record<string, any> = { winners: {} };
  if (qRes.code === 0 && fs.existsSync(qJson)) {
    const qd = readJsonFile<Record<string, any>>(qJson);
    const imgs = Array.isArray(qd?.images) ? qd.images : [];
    const byRole: Record<string, any> = {};
    const winners: Record<string, string> = {};
    // higher-is-better metrics
    const higherBetter = new Set(["sharpness", "edge_density", "contrast", "snr_db"]);
    const lowerBetter = new Set(["noise_sigma", "blockiness"]);
    if (imgs.length === 2) {
      const [ia, ib] = imgs;
      byRole.A = ia.metrics; byRole.B = ib.metrics;
      for (const k of Object.keys(ia.metrics || {})) {
        if (typeof ia.metrics[k] !== "number") continue;
        if (ia.metrics[k] === ib.metrics[k]) continue;
        if (higherBetter.has(k)) winners[k] = ia.metrics[k] > ib.metrics[k] ? "A" : "B";
        else if (lowerBetter.has(k)) winners[k] = ia.metrics[k] < ib.metrics[k] ? "A" : "B";
      }
    }
    signalMetrics = { A: byRole.A, B: byRole.B, winners };
  } else {
    console.error("[ab-test] quality metrics failed:", qRes.stderr.slice(0, 300));
  }
  try { fs.unlinkSync(qJson); } catch { /* tmp */ }

  // --- 2. pixel diff + heatmap via app/ab_diff.py ---
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const heatRel = `ab_analysis/ab_diff_${ts}.png`;
  const heatAbs = path.join(OUTPUT_DIRS[aRes.dirIdx], heatRel);
  fs.mkdirSync(path.dirname(heatAbs), { recursive: true });
  const dRes = await spawnCapture([py, abDiffPy, aRes.abs, bRes.abs, heatAbs], { ...process.env });
  let pixelDiff: Record<string, any> | null = null;
  if (dRes.code === 0) {
    try { pixelDiff = JSON.parse(dRes.stdout.trim().split("\n").pop()!); } catch { pixelDiff = null; }
  } else {
    console.error("[ab-test] diff failed:", dRes.stderr.slice(0, 300));
  }
  const heatmapUrl = dRes.code === 0 ? `/output/${aRes.dirIdx}/${heatRel}` : null;

  // --- 3. optional VLM scores (reuse cached score caption, else run) ---
  let vlmScores: Record<string, any> | null = null;
  if (!body.skipVlm) {
    const scoreFor = async (abs: string, role: "A" | "B") => {
      const dir = path.dirname(abs);
      const base = path.basename(abs).replace(/\.[^.]+$/, "");
      const capPath = findCompanionJson(dir, base, ".caption.json");
      let score: any = null;
      let cached = false;
      if (capPath) {
        const cap = normalizeCaptionFile(readJsonFile(capPath));
        score = extractScoreFromCap(cap);
        if (score) cached = true;
      }
      if (!score) {
        const args = [RUN_PY, "caption", abs, "--style", "score", "--api-url", cfg.vlmApiUrl, "--lang", "en"];
        if (!vlmModelIsAuto(cfg.vlmModel)) args.push("--model", cfg.vlmModel);
        const r = await spawnCapture([py, ...args], { ...process.env });
        if (r.code === 0) {
          const m = r.stdout.match(/Saved:\s+(\/[^\s]+\.json)/);
          const cp = m ? m[1] : null;
          if (cp && fs.existsSync(cp)) {
            score = extractScoreFromCap(normalizeCaptionFile(readJsonFile(cp)));
          }
        } else {
          console.error(`[ab-test] VLM ${role} failed:`, r.stderr.slice(0, 300));
        }
      }
      return score ? { ...score, cached } : null;
    };
    const [sa, sb] = await Promise.all([scoreFor(aRes.abs, "A"), scoreFor(bRes.abs, "B")]);
    vlmScores = { A: sa, B: sb };
    if (!sa && !sb) vlmScores = null;
  }

  const lever = detectLever(aComp.run, bComp.run);
  const feedback = buildAbFeedback({
    intent: body.intent ?? "",
    lever,
    a: { name: path.basename(aRes.abs), url: aUrl, runPath: aComp.runPath, manifestPath: aComp.manifestPath, run: aComp.run },
    b: { name: path.basename(bRes.abs), url: bUrl, runPath: bComp.runPath, manifestPath: bComp.manifestPath, run: bComp.run },
    signalMetrics,
    pixelDiff,
    vlmScores,
    heatmapUrl,
    userNote: body.userNote,
  });

  return Response.json({ ok: true, feedback, lever: lever.lever, heatmapUrl });
}
