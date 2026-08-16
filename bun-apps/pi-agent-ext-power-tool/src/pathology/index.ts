/**
 * pathology/ — failure-pathology diagnostics (F v1).
 *
 * Public surface for the package entry:
 *   - makeInspectPathologyTool() — the inspect_pathology tool (reads the
 *     accumulator + ctx token budget, runs analyzePathology, formats).
 *   - recordCallStart / recordCallEnd / resetAccumulator — the hook handlers
 *     the factory registers on tool_execution_start/end + session_start.
 *   - analyzePathology / argsSig / formatPathologyReport — pure, exported for
 *     unit testing and reuse.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportHeader } from "../report.js";
import { analyzePathology } from "./detector.ts";
import { formatPathologyReport } from "./format.ts";
import { getCalls, getTurnCount } from "./accumulator.ts";
import type { PathologyInput } from "./types.ts";

export { analyzePathology, argsSig } from "./detector.ts";
export { formatPathologyReport } from "./format.ts";
export { recordCallStart, recordCallEnd, getCalls, getTurnCount, recordTurnEnd, resetAccumulator } from "./accumulator.ts";
export { surfacePathologyWarning, resetWarning, makeWarner, pickWorstHighFinding, loopSignature } from "./warning.ts";
export type { ToolCallRecord, PathologyInput } from "./types.ts";

// ─── deterministic self-test output (mirrors the other inspect_* tools) ───────

const SELF_TEST_PATHOLOGY_OUTPUT = [
  ...reportHeader("Inspect Pathology"),
  "self_test: true",
  "Deterministic mock output — no live session state required",
  "inspect_pathology",
].join("\n");

/** Build the inspect_pathology tool. Stateless beyond the shared accumulator. */
export function makeInspectPathologyTool() {
  return defineTool({
    name: "inspect_pathology",
    gating: { gate: "inspect" }, // reference form (ticket 01) — family in GATE_DEFS["inspect"]
    label: "Inspect Pathology",
    description:
      "Diagnose how the agent is failing this session — detect retry loops, " +
      "tool error storms, and context saturation from recent tool-call history " +
      "accumulated this session. Severity-ranked report or JSON. Use this when " +
      "the agent seems stuck, repeating itself, or running into repeated errors. " +
      "For static extension/tool health use inspect_extensions; for token " +
      "breakdown use inspect_context.",
    parameters: Type.Object({
      return_json: Type.Optional(
        Type.Boolean({
          description: "Return machine-readable {findings, summary} JSON instead of a text report",
        }),
      ),
      loop_repeat_threshold: Type.Optional(
        Type.Number({
          description: "Identical (tool+args) repeats at/above this count within the window → retry loop (default 3)",
        }),
      ),
      error_rate_threshold: Type.Optional(
        Type.Number({
          description: "Per-tool error rate at/above which an error storm is flagged (default 0.5)",
        }),
      ),
      saturation_percent: Type.Optional(
        Type.Number({
          description: "Context fill percent at/above which saturation is flagged (default 85)",
        }),
      ),
      long_session_turn_threshold: Type.Optional(
        Type.Number({
          description: "Completed-turn count at/above which long-session recall risk is flagged (default 15)",
        }),
      ),
      self_test: Type.Optional(
        Type.Boolean({
          description: "When true, return a deterministic mock report without requiring live session state",
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.self_test) {
        return {
          content: [{ type: "text" as const, text: SELF_TEST_PATHOLOGY_OUTPUT }],
          details: null,
        };
      }
      const sid = ctx.sessionManager.getSessionId();
      const calls = getCalls(sid);
      const usage = ctx.getContextUsage();
      const contextPercent = usage?.percent ?? null;
      const input: PathologyInput = {
        calls,
        contextPercent,
        turnCount: getTurnCount(sid),
        loopRepeatThreshold: params.loop_repeat_threshold,
        errorRateThreshold: params.error_rate_threshold,
        saturationPercent: params.saturation_percent,
        longSessionTurnThreshold: params.long_session_turn_threshold,
      };
      const findings = analyzePathology(input);

      if (params.return_json) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ findings }, null, 2) },
          ],
          details: null,
        };
      }
      return {
        content: [
          { type: "text" as const, text: formatPathologyReport(findings, calls.slice(-10)) },
        ],
        details: null,
      };
    },
  });
}
