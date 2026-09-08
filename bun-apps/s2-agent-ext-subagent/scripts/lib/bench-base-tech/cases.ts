/**
 * Shared case catalog (spec §3) — evidence predicates, per-lane PASS rules,
 * caps, and stimulus builders. Every lane gets byte-identical stimulus text
 * for a given nonce; nonces are unique per rep/sweep to defeat caching.
 */

import { LIVE_MARKER_RE } from "./screen.js";
import type { SettleView, TechId } from "./types.js";

export type CaseId =
  | "boot-to-ready"
  | "trivial-ask"
  | "subagent-dispatch"
  | "state-probe"
  | "tui-gesture"
  | "robustness-3x";

export interface CaseDef {
  id: CaseId;
  capMs: number;
  /** Stimulus text for the given nonce (empty = no prompt stimulus). */
  stimulus: (nonce: string) => string;
  /** Screen-lane PASS predicate over the settled view. */
  screenPred: (v: SettleView, nonce: string) => boolean;
  /** rpc-lane PASS predicate over the structured view (D8: null = unreachable). */
  rpcPred: ((v: SettleView, nonce: string, helper: RpcCaseHelper) => boolean) | null;
  metric: string;
}

export interface RpcCaseHelper {
  /** Driver fetches this POST-settle (get_last_assistant_text) and hands it to the predicate. */
  lastAssistantText: string;
}

export const CASES: CaseDef[] = [
  {
    id: "boot-to-ready",
    capMs: 120_000,
    stimulus: () => "",
    screenPred: (v) => /\(zai\)\s*glm-5\.3/.test(v.screen ?? ""),
    rpcPred: () => true, // ready == first get_state success (driver-orchestrated)
    metric: "spawn→ready ms",
  },
  {
    id: "trivial-ask",
    capMs: 180_000,
    stimulus: (n) => `Reply with exactly BENCHPONG-${n} and nothing else.`,
    screenPred: (v, n) => {
      const s = v.screen ?? "";
      return s.includes(`BENCHPONG-${n}`) && !LIVE_MARKER_RE.test(s);
    },
    rpcPred: (v, n, h) => {
      const settled = Boolean((v.structured as { agentSettled?: boolean } | null)?.agentSettled);
      return settled && h.lastAssistantText.includes(`BENCHPONG-${n}`) === true;
    },
    metric: "submit→settled ms",
  },
  {
    id: "subagent-dispatch",
    capMs: 300_000,
    stimulus: (n) =>
      "Call the spawn_subagent tool NOW, exactly once, with background set to true and agentType hard-problem. " +
      `task: run sleep 3 in the current directory, then reply BENCHSUB-${n}. ` +
      "Do not answer anything yourself and use no other tool.",
    screenPred: (v, n) => {
      const s = v.screen ?? "";
      return /<task-notification>|status: done/.test(s) || s.includes(`BENCHSUB-${n}`);
    },
    rpcPred: (v, n, h) => {
      const st = v.structured as { agentSettled?: boolean; notification?: boolean } | null;
      const settled = Boolean(st?.agentSettled);
      const notif = Boolean(st?.notification);
      const marker = h.lastAssistantText.includes(`BENCHSUB-${n}`) === true;
      return settled && (notif || marker);
    },
    metric: "submit→notification ms",
  },
  {
    id: "state-probe",
    capMs: 60_000,
    stimulus: () => "",
    // Screen: status-bar model line carries glm-5.3, flash absent BY NAME.
    screenPred: (v) => {
      const s = v.screen ?? "";
      return /\(zai\)\s*glm-5\.3/.test(s) && !s.includes("flash");
    },
    rpcPred: null, // driver calls stateProbe() directly (no stimulus/settle)
    metric: "capability probe",
  },
  {
    id: "tui-gesture",
    capMs: 60_000,
    stimulus: () => "",
    screenPred: (v) => /Subagent runs/.test(v.screen ?? ""),
    rpcPred: null, // D8: expected-unreachable under rpc — recorded, not failed
    metric: "open→rendered ms",
  },
  {
    id: "robustness-3x",
    capMs: 3 * 180_000,
    // Reps carry DISTINCT framing (matrix run 2026-09-08: identical literal
    // repeats made the model drop the exact sentinel on rep 3 across every
    // lane — that measured model compliance, not lane robustness).
    stimulus: (n) =>
      `This is a repeated formatting drill (token ${n}). Reply with exactly BENCHPONG-${n} and nothing else.`,
    screenPred: (v, n) => {
      const s = v.screen ?? "";
      return s.includes(`BENCHPONG-${n}`) && !LIVE_MARKER_RE.test(s);
    },
    rpcPred: (v, n, h) =>
      Boolean((v.structured as { agentSettled?: boolean } | null)?.agentSettled) &&
      h.lastAssistantText.includes(`BENCHPONG-${n}`) === true,
    metric: "success n/3 + ms spread",
  },
];

export function caseById(id: CaseId): CaseDef {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown case: ${id}`);
  return c;
}

/** Lanes structurally capable of each case (for eligibility, spec §8.1). */
export const CASE_CAPABILITY: Record<CaseId, TechId[]> = {
  "boot-to-ready": ["bun-terminal", "bun-pty", "tmux", "rpc"],
  "trivial-ask": ["bun-terminal", "bun-pty", "tmux", "rpc"],
  "subagent-dispatch": ["bun-terminal", "bun-pty", "tmux", "rpc"],
  "state-probe": ["bun-terminal", "bun-pty", "tmux", "rpc"],
  "tui-gesture": ["bun-terminal", "bun-pty", "tmux"],
  "robustness-3x": ["bun-terminal", "bun-pty", "tmux", "rpc"],
};
