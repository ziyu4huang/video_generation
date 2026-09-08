/**
 * Complex case suite (self-arc-15, map D1) — step-scripted paired cases that
 * stress the dimensions where bun-terminal and rpc actually DIFFER. The base
 * registry (cases.ts) is untouched; this module is consumed only under
 * `--suite complex`.
 *
 * Scored cases (4):
 *   cx-multi-turn    — session continuity: recall CXK-<nonce> two turns later;
 *                      the filler turn and turn-3 echo NEVER contain the code
 *                      (persistence, not echo).
 *   cx-midturn-abort — mid-flight control + recovery (map note: the planner's
 *                      3-background-child swarm was reshaped to a symmetric
 *                      single-turn abort — child-level abort levers are lane-
 *                      ASYMMETRIC (viewer gesture vs no rpc command), which is
 *                      a capability row, not a paired scored case).
 *   cx-long-output   — 20 numbered lines; screen must latch ≥18 CUMULATIVELY
 *                      across poll frames (the F-invalidate class — rows scroll
 *                      out, the final frame alone is untrustworthy); rpc counts
 *                      the full text.
 *   cx-error-path    — a failing bash call must surface in lane-native evidence.
 */

import { LIVE_MARKER_RE } from "./screen.js";
import type { ComplexCaseDef } from "./types.js";

/** Evidence text for the lane at hand: rpc's last-assistant text, else the
 *  reconstructed screen (screen lanes carry "" in lastText — matrix run 1
 *  taught: a predicate reading only lastText NEVER latches on screen lanes). */
const pickText = (v: { screen: string | null }, h: { lastText: string }): string =>
  h.lastText.length > 0 ? h.lastText : (v.screen ?? "");

const QUIET = (text: string) => !LIVE_MARKER_RE.test(text);

export const COMPLEX_CASES: ComplexCaseDef[] = [
  {
    id: "cx-multi-turn",
    capMs: 300_000,
    metric: "continuity: turn-3 recall without echo",
    steps: [
      {
        kind: "submit",
        text: (n) => `Remember this code for later: CXK-${n}. Reply only: CODE-NOTED.`,
        pred: (v, _n, h) => pickText(v, h).includes("CODE-NOTED") && QUIET(pickText(v, h)),
      },
      {
        // Filler must NOT contain the code — turn 3 must prove persistence.
        kind: "submit",
        text: () => `Unrelated task: reply only: FILLER-DONE.`,
        pred: (v, _n, h) => pickText(v, h).includes("FILLER-DONE") && QUIET(pickText(v, h)),
      },
      {
        kind: "submit",
        // The dictated reply names a PLACEHOLDER, not the value — only the
        // child's memory can supply CXK-<nonce> (the echo cannot).
        text: () => `What code did I ask you to remember earlier? Reply exactly: The code is <code>.`,
        pred: (v, n, h) => {
          const text = pickText(v, h);
          return /The code is CXK-/.test(text) && text.includes(`CXK-${n}`) && QUIET(text);
        },
      },
    ],
  },
  {
    id: "cx-midturn-abort",
    capMs: 240_000,
    metric: "mid-flight control: abort→quiet + post-abort recovery",
    steps: [
      {
        kind: "submit",
        text: (n) =>
          `Write a slow numbered countdown from 25 down to 1, one number per line, thinking briefly between lines. End with ABT-${n}.`,
      },
      { kind: "wait", ms: 6000 },
      // Abort via the lane-native lever: Esc bytes (screen) / abort command (rpc).
      { kind: "abort" },
      {
        kind: "poll",
        capMs: 30_000,
        pred: (v, _n, h) => QUIET(pickText(v, h)),
      },
      {
        kind: "submit",
        text: (n) => `Reply only: RECOVERED-${n}.`,
        pred: (v, n, h) => {
          const text = pickText(v, h);
          return text.includes(`RECOVERED-${n}`) && QUIET(text);
        },
      },
    ],
  },
  {
    id: "cx-long-output",
    capMs: 300_000,
    metric: "long-output fidelity: lines latched (cumulative) vs received",
    steps: [
      {
        kind: "submit",
        text: (n) =>
          `Write EXACTLY 20 lines, one per line, each exactly: BENCLONG-<k>-${n} where k goes 1 to 20. Output them all at once, no pauses, no other text.`,
        // Screen pred: ≥18 distinct lines seen CUMULATIVELY (the accumulator
        // lives in the driver; h.cumulative carries the union). Rpc pred: the
        // full text contains ≥18 markers.
        pred: (v, n, h) => {
          if (typeof h.lastText === "string" && h.lastText.length > 0) {
            const found = [...h.lastText.matchAll(new RegExp(`BENCLONG-\\d+-${n}`, "g"))].length;
            return found >= 18 && QUIET(h.lastText);
          }
          return h.cumulative.size >= 18 && QUIET(pickText(v, h));
        },
        capMs: 300_000,
        cumulativeRe: "BENCLONG-\\d+-",
      },
    ],
  },
  {
    id: "cx-error-path",
    capMs: 240_000,
    metric: "error visibility: failing tool call surfaces in lane evidence",
    steps: [
      {
        kind: "submit",
        // Wording calibrated live 2026-09-09 against the deployed launcher:
        // the bash error text ("No such file or directory") is the pinned needle.
        text: (n) =>
          `Use the bash tool to run: ls /nonexistent-bench15-${n} — then reply with the exact error line you saw, prefixed ERRDONE.`,
        pred: (v, _n, h) => {
          const text = pickText(v, h);
          return /ERRDONE/.test(text) && /No such file|not found|nonexistent/i.test(text) && QUIET(text);
        },
      },
    ],
  },
];

export function complexCaseById(id: string): ComplexCaseDef {
  const c = COMPLEX_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown complex case: ${id}`);
  return c;
}
