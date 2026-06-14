import fs from "fs";
import path from "path";
import { OUTPUT_DIRS, RUN_PY } from "./paths";
import { loadConfig } from "./config";
import { readJsonFile, writeJsonFile } from "./fsUtils";
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
        ? { status: manifestRaw.status ?? "unknown", elapsed_seconds: manifestRaw.elapsed_seconds ?? 0 }
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
        "--model", cfg.vlmModel,
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
      }
    } catch (err: any) {
      console.error(`[knowledge] caption error for ${rec.stem}:`, err.message);
      failed++;
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

  return [
    `--- Record ${index + 1} ---`,
    `Prompt: ${run.prompt}`,
    `Pipeline: ${run.pipeline} | LoRA: ${lora} @ ${run.lora_scale} | Steps: ${run.steps} | CFG: ${run.cfg_scale} | Size: ${run.width}x${run.height}`,
    `Scores: ${scores}`,
    `Strengths: ${strengths}`,
    `Issues: ${issues}`,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are a T2I (text-to-image) prompt engineering expert specializing in Flux2-Klein and Z-Image diffusion models on Apple Silicon.

You will receive a batch of image generation records, each with:
- The full prompt used
- Pipeline/LoRA/parameter settings
- VLM quality scores (1-10 on 6 dimensions) and analysis

Your job: extract actionable prompt engineering knowledge from patterns in the data.

Output your response in TWO sections:

SECTION 1 — Markdown guide (start with "## T2I Prompt Engineering Guide"):
- Top 5 prompt strategies (with concrete examples)
- Prompt patterns that correlate with high scores (especially prompt_adherence and overall)
- Things to avoid
- Best parameter combinations per pipeline
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
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
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
  return readJsonFile<KnowledgeReport>(getReportPath());
}

export function saveReport(report: KnowledgeReport): void {
  writeJsonFile(getReportPath(), report);
}

export function deleteReport(): void {
  const p = getReportPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
