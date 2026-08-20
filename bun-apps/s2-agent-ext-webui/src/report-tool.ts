/**
 * report-tool.ts — the LLM-callable IN-PROCESS report producer (webui-v3
 * follow-up: "why does the agent need HTTP to talk to its own webui?").
 *
 * createWebuiReportTool({ onReport }) builds the webui_report ToolDefinition.
 * execute() builds the SAME frame the POST /api/report route emits (shared
 * buildReportFrame) and hands it to the onReport sink — in the wiring that is
 * the store-wrapped broadcaster, so semantics are identical on both doors:
 * live broadcast to connected browsers + store append (replay-eligible,
 * refresh-safe). Zero sockets — the agent and the webui server share one
 * process; the HTTP route stays for EXTERNAL producers (scripts, other
 * sessions).
 *
 * Fire-and-forget publish (nothing to await — unlike webui_present). Errors
 * return a tool RESULT (text + details.error), never a thrown crash — same
 * envelope discipline as present-tool.
 */
import { Type } from "typebox";
import { buildReportFrame, type ReportFrame } from "./report-frame.js";

export const WebuiReportParameters = Type.Object({
  title: Type.String({ description: "Report title (1-200 chars after trim), shown as the article header." }),
  markdown: Type.Optional(
    Type.String({ description: "Markdown body (DOM-built renderer). EXACTLY ONE of markdown|html." })
  ),
  html: Type.Optional(
    Type.String({ description: "HTML body (sandboxed iframe: allow-scripts, no same-origin). EXACTLY ONE of markdown|html." })
  ),
  source: Type.Optional(
    Type.String({ description: "Producer label shown in the header (<=100 chars; default 'agent')." })
  ),
});

export interface WebuiReportToolDeps {
  /** Receives the validated frame (wiring: store-wrapped broadcaster). */
  onReport: (frame: ReportFrame) => void;
}

export function createWebuiReportTool(deps: WebuiReportToolDeps) {
  return {
    name: "webui_report",
    label: "Report",
    // ALWAYS-ON core (same rationale class as webui_present): publishing a
    // report is the natural epilogue of generating content ("here is the
    // result") — the originating prompt carries no report keyword, so a
    // keyword gate would stay dormant exactly at publish time. A publish
    // primitive, not an on-demand capability. No no_client skip: the frame
    // is replay-eligible, so publishing with zero connected browsers is
    // still correct (it appears on the next connect/replay).
    gating: { core: true },
    description:
      "Publish a report into the webui Report tab — the in-process producer (no HTTP). " +
      "Body is markdown (DOM-built renderer) OR html (sandboxed iframe), exactly one. " +
      "The report is broadcast live to connected browsers AND appended to the replay store, " +
      "so it survives refreshes/reconnects. Use it to deliver generated content, summaries, " +
      "or galleries (e.g. inline-SVG icon reports) without leaving the agent process.",
    promptSnippet:
      "Use to publish generated content/summaries as a durable report in the webui Report tab (non-blocking).",
    parameters: WebuiReportParameters,
    async execute(_callId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      const r = buildReportFrame({ ...params }, "agent");
      if (!r.ok) {
        return {
          content: [{ type: "text", text: "webui_report rejected the input: " + r.error }],
          details: { error: r.error },
        };
      }
      deps.onReport(r.frame);
      return {
        content: [
          {
            type: "text",
            text: 'published report "' + r.frame.title + '" (id ' + r.frame.id + ") — Report tab",
          },
        ],
        details: { ok: true, id: r.frame.id },
      };
    },
  };
}
