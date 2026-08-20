/**
 * script-pacing-gate.ts — words-per-second sanity check for the script artifact
 * (Bug 3, saturn-young-rings 2026-07-12, see output/next-goal-20260712_081500.md).
 *
 * The gap this closes: nothing in this pipeline ever validated a script's
 * narration pace against natural speech. A script can lock
 * `total_duration_seconds` at whatever the agent already decided the VIDEO
 * should be, with a word count that only fits that duration at ~2x natural
 * speaking rate — then TTS synthesis measures the real (much longer) natural
 * duration, and the agent compresses the SPEECH RATE to force-fit the
 * pre-decided video length instead of extending the video (chaining more
 * I2V clips) to match the narration's natural length. This is a purely
 * text-math check (no subprocess, no ffprobe) computable the moment the
 * script artifact exists — the cheapest possible point to catch it, well
 * before any TTS/video asset is generated.
 *
 * Deliberately ADVISORY (warn/fail computed and surfaced, never blocks a
 * checkpoint write) — a pacing_profile of "energetic" or a
 * technical/dense narration can legitimately run faster than a
 * contemplative documentary voice, and the wps bound below is a rough
 * heuristic, not a hard physical limit the way "no cuts" or "duration<=0"
 * are for pre-compose. Surfacing it automatically at write-checkpoint time
 * (see checkpoint.ts) still beats pure movie_help documentation, which this
 * session's Bug 2 already showed isn't reliably acted on.
 */

export interface ScriptSectionLike {
  id?: string;
  text?: string;
  start_seconds?: number;
  end_seconds?: number;
}

export interface ScriptLike {
  total_duration_seconds?: number;
  sections?: ScriptSectionLike[];
  voice_performance?: { pacing_profile?: string };
}

export interface PacingSectionResult {
  id: string;
  words: number;
  seconds: number;
  wordsPerSecond: number;
  status: "pass" | "warn" | "fail";
}

export interface ScriptPacingResult {
  status: "pass" | "warn" | "fail";
  overallWords: number;
  overallSeconds: number;
  overallWordsPerSecond: number;
  sections: PacingSectionResult[];
  detail: string;
}

export interface ScriptPacingOptions {
  /** Words/sec above which a section (or the overall script) warns. Default 3.0 (~180 wpm). */
  warnWordsPerSecond?: number;
  /** Words/sec above which a section (or the overall script) fails. Default 3.5 (~210 wpm). */
  failWordsPerSecond?: number;
}

function wordCount(text: string | undefined): number {
  return (text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function statusFor(wps: number, warnBar: number, failBar: number): "pass" | "warn" | "fail" {
  if (wps > failBar) return "fail";
  if (wps > warnBar) return "warn";
  return "pass";
}

/**
 * Compute words-per-second for each script section and for the whole script,
 * and classify against natural-speech bounds. Never throws; a script with no
 * sections or zero duration reports 0 wps (status "pass" — nothing to flag).
 */
export function scriptPacingCheck(script: ScriptLike, opts: ScriptPacingOptions = {}): ScriptPacingResult {
  const warnBar = opts.warnWordsPerSecond ?? 3.0;
  const failBar = opts.failWordsPerSecond ?? 3.5;
  const sections = script.sections ?? [];

  const sectionResults: PacingSectionResult[] = sections.map((s, i) => {
    const words = wordCount(s.text);
    const seconds = Math.max(0, (s.end_seconds ?? 0) - (s.start_seconds ?? 0));
    const wordsPerSecond = seconds > 0 ? words / seconds : 0;
    return {
      id: s.id ?? `section_${i}`,
      words,
      seconds,
      wordsPerSecond,
      status: seconds > 0 ? statusFor(wordsPerSecond, warnBar, failBar) : "pass",
    };
  });

  const overallWords = sectionResults.reduce((sum, s) => sum + s.words, 0);
  const overallSeconds = script.total_duration_seconds ?? sectionResults.reduce((sum, s) => sum + s.seconds, 0);
  const overallWordsPerSecond = overallSeconds > 0 ? overallWords / overallSeconds : 0;
  const overallStatus = overallSeconds > 0 ? statusFor(overallWordsPerSecond, warnBar, failBar) : "pass";

  const worstSectionStatus = sectionResults.reduce<"pass" | "warn" | "fail">((worst, s) => {
    if (s.status === "fail" || worst === "fail") return s.status === "fail" || worst === "fail" ? "fail" : worst;
    if (s.status === "warn" || worst === "warn") return "warn";
    return "pass";
  }, "pass");
  const status: "pass" | "warn" | "fail" =
    overallStatus === "fail" || worstSectionStatus === "fail"
      ? "fail"
      : overallStatus === "warn" || worstSectionStatus === "warn"
        ? "warn"
        : "pass";

  const flaggedSections = sectionResults.filter((s) => s.status !== "pass");
  const detail =
    status === "pass"
      ? `overall ${overallWordsPerSecond.toFixed(2)} words/sec (${overallWords} words / ${overallSeconds.toFixed(1)}s) — within natural speech pace`
      : `overall ${overallWordsPerSecond.toFixed(2)} words/sec (${overallWords} words / ${overallSeconds.toFixed(1)}s)` +
        (flaggedSections.length > 0
          ? `; ${flaggedSections.length} section(s) brisk-or-faster: ` +
            flaggedSections.map((s) => `"${s.id}" ${s.wordsPerSecond.toFixed(2)} wps`).join(", ")
          : "") +
        ` — this script only fits its planned duration at an unnaturally fast speaking rate. ` +
        `Do NOT compress TTS rate to force narration into a shorter video; instead EXTEND the video ` +
        `(chain more I2V clips per scene, last-frame reseed) to match the narration's natural pace, ` +
        `or shorten the script text itself.`;

  return { status, overallWords, overallSeconds, overallWordsPerSecond, sections: sectionResults, detail };
}
