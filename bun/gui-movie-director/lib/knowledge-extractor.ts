import fs from "fs";
import path from "path";
import { OUTPUT_DIRS, RUN_PY } from "./paths";
import { loadConfig, vlmModelIsAuto } from "./config";
import { readJsonFile, writeJsonFile } from "./fsUtils";
import {
  saveReportToDb,
  loadLatestReportFromDb,
  appendRecordsToDb,
} from "./knowledge-db";
import type {
  KnowledgeRecord,
  KnowledgeReport,
  ReviewCaption,
  T2IRunConfig,
  StructuredKnowledge,
} from "./knowledge-types";

const REPORT_FILENAME = "knowledge-report.json";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_RECORDS_FOR_AI = 60;

// --- Scanning ---

function parseCaptionField(raw: string | object | null | undefined): ReviewCaption | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof obj?.overall !== "number") return null;
    return obj as ReviewCaption;
  } catch {
    return null;
  }
}

function isT2IRecord(run: T2IRunConfig): boolean {
  // Include image generation commands; exclude video
  const cmd = (run.command ?? "").toLowerCase();
  if (!cmd.startsWith("image")) return false;
  const pipeline = (run.pipeline ?? "").toLowerCase();
  if (pipeline.includes("video") || pipeline.includes("ltx")) return false;
  return true;
}

export function scanOutputDirs(): KnowledgeRecord[] {
  const records: KnowledgeRecord[] = [];
  const seen = new Set<string>(); // deduplicate stems across dirs

  for (let dirIdx = 0; dirIdx < OUTPUT_DIRS.length; dirIdx++) {
    const dir = OUTPUT_DIRS[dirIdx];
    if (!fs.existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of entries) {
      const ext = path.extname(file).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      // Skip relay thumbnails (proxy images for video segments)
      if (file.includes("_relay")) continue;

      const stem = file.slice(0, -ext.length);
      const key = `${dirIdx}:${stem}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const imagePath = path.join(dir, file);
      const runPath = path.join(dir, `${stem}.run.json`);
      const manifestPath = path.join(dir, `${stem}.manifest.json`);
      const captionPath = path.join(dir, `${stem}.caption.json`);

      const runRaw = readJsonFile<T2IRunConfig>(runPath);
      // Only include T2I image records
      if (!runRaw || !isT2IRecord(runRaw)) continue;

      const manifestRaw = readJsonFile<any>(manifestPath);
      const captionRaw = readJsonFile<any>(captionPath);

      const caption = captionRaw
        ? parseCaptionField(captionRaw.caption)
        : null;

      const manifest = manifestRaw
        ? (() => {
            const mf: any = manifestRaw;
            const stepTimes: number[] = Array.isArray(mf?.timings?.denoising_step_times)
              ? mf.timings.denoising_step_times
              : [];
            const avgStep = stepTimes.length
              ? stepTimes.reduce((a: number, b: number) => a + b, 0) / stepTimes.length
              : undefined;
            // transformer model identity = its containing dir basename (e.g. "zimage-moody-v126")
            const txPath: string | undefined = mf?.models?.transformer?.path;
            const txModel = txPath ? path.basename(path.dirname(txPath)) : undefined;
            return {
              status: mf.status ?? "unknown",
              elapsed_seconds: mf.elapsed_seconds ?? 0,
              memory_peak_mb: typeof mf.memory_peak_mb === "number" ? Math.round(mf.memory_peak_mb) : undefined,
              denoising_seconds: typeof mf?.timings?.denoising_seconds === "number"
                ? Math.round(mf.timings.denoising_seconds * 100) / 100
                : undefined,
              avg_step_seconds: avgStep !== undefined ? Math.round(avgStep * 100) / 100 : undefined,
              step_count: stepTimes.length || undefined,
              transformer_model: txModel,
            };
          })()
        : null;

      records.push({
        stem,
        dirIdx,
        imagePath,
        run: runRaw,
        manifest,
        caption,
        hasCaption: caption !== null,
        qualityScore: caption?.overall ?? null,
        pipeline: runRaw.pipeline ?? "unknown",
      });
    }
  }

  // Sort by stem (timestamp) descending
  records.sort((a, b) => b.stem.localeCompare(a.stem));
  return records;
}

// --- Caption generation ---

export interface CaptionProgress {
  total: number;
  done: number;
  current: string;
  error?: string;
}

export async function generateMissingCaptions(
  records: KnowledgeRecord[],
  onProgress?: (p: CaptionProgress) => void,
  limit?: number,
): Promise<{ generated: number; failed: number }> {
  const cfg = loadConfig();
  const missing = records.filter((r) => !r.hasCaption);
  const batch = limit ? missing.slice(0, limit) : missing;
  let generated = 0;
  let failed = 0;

  const newlyCaptioned: KnowledgeRecord[] = [];

  for (let i = 0; i < batch.length; i++) {
    const rec = batch[i];
    onProgress?.({ total: batch.length, done: i, current: rec.stem });

    try {
      const prompt = rec.run?.prompt ?? "";
      const captionArgs = [
        cfg.pythonPath,
        RUN_PY,
        "caption",
        rec.imagePath,
        "--style", "review",
        "--lang", "en",
        "--api-url", cfg.vlmApiUrl,
        // "auto" → omit --model so caption.py auto-resolves (prefers Gemma 26B
        // when already loaded). See vlmModelIsAuto.
        ...(vlmModelIsAuto(cfg.vlmModel) ? [] : ["--model", cfg.vlmModel]),
        ...(prompt ? ["--prompt", prompt] : []),
      ];
      const proc = Bun.spawn(
        captionArgs,
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
      );

      const stdoutP = new Response(proc.stdout).text();
      const stderrP = new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      await stdoutP;
      const stderr = await stderrP;

      if (exitCode !== 0) {
        console.error(`[knowledge] caption failed for ${rec.stem}:`, stderr.slice(0, 300));
        failed++;
      } else {
        generated++;
        // Update in-memory record
        const captionPath = rec.imagePath.replace(/\.[^.]+$/, "") + ".caption.json";
        const captionRaw = readJsonFile<any>(captionPath);
        if (captionRaw) {
          const parsed = parseCaptionField(captionRaw.caption);
          rec.caption = parsed;
          rec.hasCaption = parsed !== null;
          rec.qualityScore = parsed?.overall ?? null;
        }
        newlyCaptioned.push(rec);
      }
    } catch (err: any) {
      console.error(`[knowledge] caption error for ${rec.stem}:`, err.message);
      failed++;
    }
  }

  // Persist newly captioned records to the knowledge base
  if (newlyCaptioned.length > 0) {
    try {
      appendRecordsToDb(newlyCaptioned);
    } catch (err: any) {
      console.error("[knowledge] appendRecordsToDb failed:", err.message);
    }
  }

  onProgress?.({ total: batch.length, done: batch.length, current: "" });
  return { generated, failed };
}

// --- DeepSeek analysis ---

function formatRecord(rec: KnowledgeRecord, index: number): string {
  const run = rec.run!;
  const cap = rec.caption!;
  const lora = run.lora_path ? path.basename(run.lora_path) : "none";
  const scores = `overall=${cap.overall} detail=${cap.detail} sharpness=${cap.sharpness} composition=${cap.composition} prompt_adherence=${cap.prompt_adherence} artifacts=${cap.artifacts}`;
  const strengths = cap.strengths.length ? cap.strengths.slice(0, 3).join("; ") : "—";
  const issues = cap.issues.length ? cap.issues.slice(0, 2).join("; ") : "none";

  // Impactful params beyond the headline pipeline/steps/cfg — these are the real
  // quality levers (denoise = i2i source fidelity; stg = coherence; post-processing;
  // controlnet/face_detail). Only surface non-default values to avoid noise.
  const r = run as any;
  const extras: string[] = [];
  if (r.denoise_strength != null && r.denoise_strength !== 1) extras.push(`denoise=${r.denoise_strength}`);
  if (r.stg_scale != null && r.stg_scale !== 1) extras.push(`stg=${r.stg_scale}`);
  if (r.seed != null) extras.push(`seed=${r.seed}`);
  if (r.enhance_prompt) extras.push(`enhance_prompt`);
  if (r.film_grain) extras.push(`film_grain=${r.film_grain}`);
  if (r.sharpening) extras.push(`sharpening=${r.sharpening}`);
  if (r.lut_path) extras.push(`lut=${path.basename(r.lut_path)}`);
  if (r.control_type) extras.push(`controlnet=${r.control_type}@${r.control_strength ?? "?"}`);
  if (r.face_detail) extras.push(`face_detail(dn=${r.face_detail_denoise ?? "?"})`);
  if (r.seed_variance) extras.push(`seed_variance`);
  const extraLine = extras.length ? ` | ${extras.join(", ")}` : "";

  // Perf profile from the manifest — lets knowledge correlate model/time/memory
  // with quality (e.g. "moody-v126 + 12 steps = 16s / 7.8GB, scored 9").
  const mf = rec.manifest;
  const perfParts: string[] = [];
  if (mf) {
    if (mf.transformer_model) perfParts.push(`model=${mf.transformer_model}`);
    if (mf.elapsed_seconds) perfParts.push(`${mf.elapsed_seconds}s`);
    if (mf.memory_peak_mb) perfParts.push(`${mf.memory_peak_mb}MB`);
    if (mf.step_count && mf.avg_step_seconds) perfParts.push(`${mf.step_count}steps@${mf.avg_step_seconds}s`);
  }
  const perfLine = perfParts.length ? ` | Perf: ${perfParts.join(", ")}` : "";

  return [
    `--- Record ${index + 1} ---`,
    `Prompt: ${run.prompt}`,
    `Pipeline: ${run.pipeline} | LoRA: ${lora} @ ${run.lora_scale} | Steps: ${run.steps} | CFG: ${run.cfg_scale} | Size: ${run.width}x${run.height}${extraLine}${perfLine}`,
    `Scores: ${scores}`,
    `Strengths: ${strengths}`,
    `Issues: ${issues}`,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are a T2I (text-to-image) prompt engineering expert specializing in Flux2-Klein and Z-Image diffusion models on Apple Silicon.

You will receive a batch of image generation records, each with:
- The full prompt used
- Pipeline/LoRA/parameter settings — including impactful levers only shown when non-default:
  denoise_strength (i2i source fidelity), stg_scale (coherence), seed, enhance_prompt,
  post-processing (film_grain/sharpening/lut), controlnet (type@strength), face_detail
- A perf profile: transformer model identity, total elapsed seconds, peak memory, and
  per-step timing — use this to correlate model/time/memory COST with quality
- VLM quality scores (1-10 on 6 dimensions) and analysis

Your job: extract actionable prompt engineering knowledge from patterns in the data.

Output your response in TWO sections:

SECTION 1 — Markdown guide (start with "## T2I Prompt Engineering Guide"):
- Top 5 prompt strategies (with concrete examples)
- Prompt patterns that correlate with high scores (especially prompt_adherence and overall)
- Things to avoid
- Best parameter combinations per pipeline — note how denoise/stg/post-processing levers
  shifted scores when present, and the perf cost (time/memory) of each combination
- Top 5 example prompts with explanation of why they worked

SECTION 2 — JSON block (must be valid JSON, fenced with \`\`\`json and \`\`\`):
{
  "topStrategies": [{"template": "...", "avgScore": 8.5, "sampleCount": 3, "bestLora": "..."}],
  "avoid": ["..."],
  "bestParams": [{"pipeline": "flux2-klein", "steps": 28, "cfgScale": 3.5, "loraScale": 0.8}],
  "loraInsights": [{"lora": "anything2real", "avgScore": 9.1, "notes": "..."}],
  "topExamples": [{"prompt": "...", "score": 9.5, "pipeline": "...", "why": "...", "loraPath": "..."}]
}`;

function parseDeepSeekResponse(text: string): { markdown: string; structured: StructuredKnowledge } {
  // Extract JSON block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  let structured: StructuredKnowledge = {
    topStrategies: [],
    avoid: [],
    bestParams: [],
    loraInsights: [],
    topExamples: [],
  };

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      structured = {
        topStrategies: parsed.topStrategies ?? [],
        avoid: parsed.avoid ?? [],
        bestParams: parsed.bestParams ?? [],
        loraInsights: parsed.loraInsights ?? [],
        topExamples: parsed.topExamples ?? [],
      };
    } catch (e) {
      console.error("[knowledge] Failed to parse structured JSON from DeepSeek:", e);
    }
  }

  // Markdown is everything before the JSON fence (or full text if no JSON)
  const markdownEnd = text.indexOf("```json");
  const markdown = markdownEnd > 0 ? text.slice(0, markdownEnd).trim() : text.trim();

  return { markdown, structured };
}

export async function callDeepSeek(
  records: KnowledgeRecord[],
  options: { minScore?: number; maxRecords?: number } = {},
): Promise<KnowledgeReport> {
  const cfg = loadConfig();
  const apiKey = (cfg as any).deepseekApiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set — set it via env or config.json");

  const model = (cfg as any).deepseekModel ?? "deepseek-chat";
  const minScore = options.minScore ?? 0;
  const maxRecs = options.maxRecords ?? MAX_RECORDS_FOR_AI;

  // Filter: must have both run and caption, meet score threshold
  const eligible = records
    .filter((r) => r.run && r.caption && (r.qualityScore ?? 0) >= minScore)
    .sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))
    .slice(0, maxRecs);

  if (eligible.length === 0) {
    throw new Error("No eligible records found (need run.json + caption.json). Run caption extraction first.");
  }

  const avgQualityScore =
    eligible.reduce((s, r) => s + (r.qualityScore ?? 0), 0) / eligible.length;

  const userPrompt = [
    `Analyze these ${eligible.length} T2I generation records and extract prompt engineering knowledge:\n`,
    ...eligible.map((r, i) => formatRecord(r, i)),
  ].join("\n\n");

  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    // Bound the request: callDeepSeek runs ON the HTTP request path and a hung
    // DeepSeek API would stall this request indefinitely. 90s matches the
    // max_tokens:8192 completion budget; the caller maps a timeout to a 504.
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      // Enriched records (perf + impactful params) + the richer markdown guide the
      // SYSTEM_PROMPT asks for can run ~11K chars of markdown alone; 4096 tokens
      // gets consumed before the JSON block finishes, losing structured knowledge.
      // 8192 leaves headroom for BOTH the markdown guide and the fenced JSON block.
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const text: string = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Empty response from DeepSeek");

  const { markdown, structured } = parseDeepSeekResponse(text);

  return {
    generatedAt: new Date().toISOString(),
    model,
    recordCount: eligible.length,
    avgQualityScore: Math.round(avgQualityScore * 10) / 10,
    markdown,
    structured,
  };
}

// --- Report persistence ---

export function getReportPath(): string {
  return path.join(OUTPUT_DIRS[0], REPORT_FILENAME);
}

export function loadReport(): KnowledgeReport | null {
  // Try new KB location first; fall back to legacy output-dir path
  return loadLatestReportFromDb() ?? readJsonFile<KnowledgeReport>(getReportPath());
}

export function saveReport(report: KnowledgeReport): void {
  // Primary: new knowledge-base/ folder (JSONL DB structure)
  saveReportToDb(report);
  // Secondary: legacy path for GUI backward compat (/api/knowledge/report)
  writeJsonFile(getReportPath(), report);
}

export function deleteReport(): void {
  const p = getReportPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
