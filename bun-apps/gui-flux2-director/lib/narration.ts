/**
 * narration.ts — shared narration budget helpers for auto-story mode.
 */

/**
 * Max voice-over words that comfortably fit one scene's clip. Kokoro speaks
 * ≈ 2.5 words/second at speed 1.0 (measured on af_heart, 2026-09-05); keep a
 * little headroom under the cut so amix's duration=first never bites into
 * the final word.
 */
export function storySecondsToNarrationWords(seconds: number): number {
  return Math.max(4, Math.floor(seconds * 2.5));
}

/** Narration lead-in before the first word (ms) — lets the cut settle. */
export const NARRATION_LEAD_IN_MS = 300;

/** LTX's own soundtrack level under the narration (linear volume). */
export const BED_VOLUME = 0.32;
