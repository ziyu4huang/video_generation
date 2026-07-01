/**
 * scenePipeline.ts — multi-seed `flux2 scene` pipeline.
 *
 * `flux2 scene` refs are GLOBAL tokens (no identity→region binding), so
 * placement/pose is prompt-driven & reliable-but-probabilistic (see
 * docs/multi-reference-architecture.md §6). The practical fix, already
 * proven out by scripts/scene-classroom-demo.sh and
 * scripts/multi-seed-autoselect.sh, is SEED SELECTION: render the same scene
 * across N seeds, verify each with a VLM, and keep the one that actually
 * matches. This module is that workflow as a first-class, testable pipeline
 * instead of a bash script with hardcoded absolute paths.
 *
 * VLM verification reuses pi-vlm's shared subagent primitive (`askImage` +
 * `resolveLLM`, defaulting to lm-studio/google/gemma-4-26b-a4b-qat) — the same
 * subagent plumbing pi-vlm itself and bun-pi-agent-cli already use, so this is
 * not a new LM Studio client, just a new caller of the existing one.
 *
 * Both the per-seed runner and the VLM asker are injectable so the
 * loop/winner-selection logic itself is unit-testable without a built flux2
 * binary or a running LM Studio.
 */
import type { Flux2Details } from "./result.ts";

export interface ScenePipelineOptions {
  /** Seeds to render (in order). Required — this is what triggers the pipeline. */
  seeds: number[];
  /**
   * Question to ask the VLM about each rendered candidate (e.g. "Describe each
   * person's position (LEFT/RIGHT) and pose."). Omit to skip VLM verification
   * entirely (candidates are still generated + gated; the caller picks from
   * `candidates[]` using gate status alone).
   */
  verifyPrompt?: string;
  /**
   * Case-insensitive substrings that must ALL appear in a candidate's VLM
   * reply for it to be considered a match. The first (in seed order) matching,
   * non-FAIL candidate is the winner. Ignored if `verifyPrompt` is omitted.
   */
  verifyMatch?: string[];
  /** "provider/modelId" override for the VLM subagent. Default: lm-studio/google/gemma-4-26b-a4b-qat. */
  vlmModel?: string;
  /** After picking a winner, re-render it once more with --hand-repair. */
  handRepairWinner?: boolean;
}

export interface ScenePipelineCandidate {
  seed: number;
  output: string | null;
  gate: "PASS" | "WARN" | "FAIL" | null;
  vlmReply: string | null;
  matched: boolean;
  ok: boolean;
}

export interface ScenePipelineResult {
  candidates: ScenePipelineCandidate[];
  winnerSeed: number | null;
  winnerOutput: string | null;
  /** Why the winner was picked ("verify-match" | "best-gate" | "none"). */
  winnerReason: "verify-match" | "best-gate" | "none";
  handRepair?: { output: string | null; gate: "PASS" | "WARN" | "FAIL" | null } | null;
}

/** Runs ONE `flux2 scene` invocation for a given seed (+ optional extra option overrides). */
export type RunSceneOnce = (
  options: Record<string, unknown>,
) => Promise<Flux2Details>;

/** Asks a VLM one question about one image; returns its reply text. */
export type AskAboutImage = (imagePath: string, question: string) => Promise<{ reply: string; ok: boolean }>;

const GATE_RANK: Record<string, number> = { PASS: 2, WARN: 1, FAIL: 0 };

function gateRank(g: string | null): number {
  return g ? (GATE_RANK[g] ?? -1) : -1;
}

/** True iff every substring in `needles` (case-insensitive) appears in `haystack`. */
function matchesAll(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.every((n) => h.includes(n.toLowerCase()));
}

/**
 * Disambiguate `name`/`output` with a suffix so seeds never clobber each
 * other's file. flux2 writes by name/output regardless of seed — a caller
 * that passes a fixed `name` (rather than omitting it for the CLI's own
 * auto-timestamped default) would otherwise have every candidate overwrite
 * the same file, silently corrupting the "winner" path once the next seed
 * renders. Omitted name/output (the CLI's own timestamped default) is left
 * untouched — each real invocation already gets a fresh timestamp.
 */
function withOutputSuffix(baseOptions: Record<string, unknown>, suffix: string): Record<string, unknown> {
  const opts = { ...baseOptions };
  if (typeof opts.name === "string" && opts.name.length > 0) {
    opts.name = `${opts.name}_${suffix}`;
  }
  if (typeof opts.output === "string" && opts.output.length > 0) {
    const dot = opts.output.lastIndexOf(".");
    opts.output = dot > 0 ? `${opts.output.slice(0, dot)}_${suffix}${opts.output.slice(dot)}` : `${opts.output}_${suffix}`;
  }
  return opts;
}

/**
 * Pick the winner: prefer the first (seed order) non-FAIL candidate whose VLM
 * reply matches every `verifyMatch` substring; otherwise fall back to the
 * candidate with the best gate status (PASS > WARN > FAIL > null), first one
 * wins ties.
 */
function pickWinner(
  candidates: ScenePipelineCandidate[],
  verifyMatch: string[] | undefined,
): { seed: number | null; output: string | null; reason: ScenePipelineResult["winnerReason"] } {
  if (verifyMatch?.length) {
    const matched = candidates.find((c) => c.matched && c.gate !== "FAIL");
    if (matched) return { seed: matched.seed, output: matched.output, reason: "verify-match" };
  }
  let best: ScenePipelineCandidate | null = null;
  for (const c of candidates) {
    if (!c.ok) continue;
    if (!best || gateRank(c.gate) > gateRank(best.gate)) best = c;
  }
  if (best) return { seed: best.seed, output: best.output, reason: "best-gate" };
  return { seed: null, output: null, reason: "none" };
}

export interface RunScenePipelineDeps {
  runSceneOnce: RunSceneOnce;
  askAboutImage: AskAboutImage;
}

/**
 * Run the multi-seed scene pipeline: render every seed, gate + (optionally)
 * VLM-verify each, pick a winner, and (optionally) hand-repair it.
 *
 * `baseOptions` are the scene options WITHOUT `seed` (each candidate sets its
 * own). `deps` are injected so this loop is unit-testable without a real
 * flux2 binary or LM Studio.
 */
export async function runScenePipeline(
  baseOptions: Record<string, unknown>,
  pipelineOpts: ScenePipelineOptions,
  deps: RunScenePipelineDeps,
  onProgress?: (text: string) => void,
): Promise<ScenePipelineResult> {
  if (!pipelineOpts.seeds?.length) {
    throw new Error("scenePipeline.seeds must be a non-empty array");
  }

  const candidates: ScenePipelineCandidate[] = [];
  for (const seed of pipelineOpts.seeds) {
    onProgress?.(`scene pipeline: rendering seed ${seed} (${candidates.length + 1}/${pipelineOpts.seeds.length})`);
    const details = await deps.runSceneOnce({ ...withOutputSuffix(baseOptions, `seed${seed}`), seed });
    let vlmReply: string | null = null;
    let matched = false;
    if (details.ok && details.output && pipelineOpts.verifyPrompt) {
      onProgress?.(`scene pipeline: verifying seed ${seed} via VLM`);
      const answer = await deps.askAboutImage(details.output, pipelineOpts.verifyPrompt);
      if (answer.ok) {
        vlmReply = answer.reply;
        matched = pipelineOpts.verifyMatch?.length ? matchesAll(answer.reply, pipelineOpts.verifyMatch) : false;
      }
    }
    candidates.push({
      seed,
      output: details.output,
      gate: details.gate,
      vlmReply,
      matched,
      ok: details.ok,
    });
  }

  const winner = pickWinner(candidates, pipelineOpts.verifyMatch);
  const result: ScenePipelineResult = {
    candidates,
    winnerSeed: winner.seed,
    winnerOutput: winner.output,
    winnerReason: winner.reason,
  };

  if (pipelineOpts.handRepairWinner && winner.seed != null) {
    onProgress?.(`scene pipeline: hand-repairing winning seed ${winner.seed}`);
    const repaired = await deps.runSceneOnce({
      ...withOutputSuffix(baseOptions, `seed${winner.seed}_handrepair`),
      seed: winner.seed,
      handRepair: true,
    });
    result.handRepair = { output: repaired.output, gate: repaired.gate };
  }

  return result;
}
