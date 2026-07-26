/**
 * Pure helpers for the probe runner — extracted so they are unit-testable
 * independent of the live subagent dispatch (which is slow + network-bound).
 *
 * Everything here is deterministic: same inputs ⇒ same outputs, no I/O.
 */
import type { Probe, ProbeResult } from "./types.ts";
import { passed } from "./types.ts";

/** Default cap on how much of the child's output is fed to the judge (token budget). */
export const DEFAULT_JUDGE_OUTPUT_CAP = 4000;

/**
 * Build the judge's grading prompt: rubric as a numbered 0–3 scale + the
 * response to grade (truncated) + a strict "JSON only" return contract.
 * Deterministic — used by the unit test to pin the prompt shape.
 */
export function buildJudgePrompt(rubric: string[], output: string, maxOutputChars = DEFAULT_JUDGE_OUTPUT_CAP): string {
  const scale = rubric.map((r, i) => `${i}: ${r}`).join("\n");
  const trimmed = output.slice(0, maxOutputChars);
  return (
    `You are grading an agent's response. Rubric (score each 0-3):\n` +
    `${scale}\n\n` +
    `Response to grade:\n"""\n${trimmed}\n"""\n` +
    `Return JSON: {"scores":[...], "notes":"..."}. Only the JSON.`
  );
}

/**
 * Run a probe's structural regexes against the child's output.
 * Empty/undefined structural ⇒ vacuously true (no machine gate configured).
 */
export function runStructural(structural: RegExp[] | undefined, output: string): boolean {
  return (structural ?? []).every((re) => re.test(output));
}

/**
 * Parse the judge's JSON reply robustly. Accepts:
 *   - a bare JSON object,
 *   - a ```json fenced block,
 *   - the first balanced {...} embedded in prose.
 * Coerces `scores` to a number[] (clamping non-finite) and `notes` to a string.
 * Returns {scores:[], notes:""} on total failure rather than throwing — the
 * runner treats an unparseable judge as a zero-score with a diagnostic note.
 */
export function parseJudgeResult(raw: string): { scores: number[]; notes: string } {
  const json = extractJsonObject(raw);
  if (json === undefined) return { scores: [], notes: `unparseable judge reply: ${raw.slice(0, 200)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { scores: [], notes: `unparseable judge reply: ${raw.slice(0, 200)}` };
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const rawScores = Array.isArray(obj.scores) ? obj.scores : [];
  const scores = rawScores.map((n) => {
    const num = typeof n === "number" ? n : Number.parseFloat(String(n));
    return Number.isFinite(num) ? num : 0;
  });
  const notes = typeof obj.notes === "string" ? obj.notes : String(obj.notes ?? "");
  return { scores, notes };
}

/** Find a JSON object in free-form text: fenced ```json block, else first balanced {...}. */
function extractJsonObject(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/\{/);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Validate a Probe's structural shape (used at module-load to fail fast on a
 * malformed fixture rather than silently scoring garbage). Returns the list of
 * problems (empty = valid). Pure — no throw, so the test can assert each rule.
 */
export function validateProbe(p: Probe): string[] {
  const problems: string[] = [];
  if (typeof p.id !== "string" || p.id.length === 0) problems.push("id must be a non-empty string");
  if (p.phase !== 1 && p.phase !== 2 && p.phase !== 3) problems.push("phase must be 1 | 2 | 3");
  if (typeof p.prompt !== "string" || p.prompt.trim().length === 0) problems.push("prompt must be a non-empty string");
  if (!Array.isArray(p.rubric) || p.rubric.length === 0) problems.push("rubric must be a non-empty string[]");
  else {
    for (let i = 0; i < p.rubric.length; i++) {
      if (typeof p.rubric[i] !== "string" || p.rubric[i].trim().length === 0) {
        problems.push(`rubric[${i}] must be a non-empty string`);
      }
    }
  }
  if (p.structural !== undefined) {
    if (!Array.isArray(p.structural)) problems.push("structural must be a RegExp[] when present");
    else {
      for (let i = 0; i < p.structural.length; i++) {
        if (!(p.structural[i] instanceof RegExp)) problems.push(`structural[${i}] must be a RegExp`);
      }
    }
  }
  return problems;
}

/** Align a scores array to a rubric length: pad with 0 / truncate, never throw. */
export function alignScores(scores: number[], rubricLength: number): number[] {
  const out = scores.slice(0, rubricLength);
  while (out.length < rubricLength) out.push(0);
  return out;
}

/** One line of the score table: id | structural | per-rubric scores | pass/fail. */
export function formatRow(result: ProbeResult, baseline: ProbeResult | undefined, rubricLength: number): string {
  const scores = alignScores(result.rubricScores, rubricLength)
    .map((s) => String(s))
    .join(",");
  const verdict = passed(result, baseline) ? "PASS" : "FAIL";
  const struct = result.structuralPassed ? "struct:ok" : "struct:FAIL";
  return `${result.id.padEnd(34)} ${struct.padEnd(10)} [${scores}] ${verdict}`;
}
