/**
 * report-frame.ts — shared validation + frame construction for report
 * producers. The two doors into the Report tab MUST emit identical frames:
 *   - render-routes.ts  POST /api/report   (external, cross-process door)
 *   - report-tool.ts    webui_report tool  (agent-side, in-process door)
 * Route semantics preserved verbatim from the pre-extraction inline block:
 * title trimmed to 1-200; EXACTLY ONE body mode; 16MB body cap; source
 * capped at 100 with a per-door default ("api" for the route, "agent" for
 * the tool).
 */
import type { WebFrame } from "./protocol.js";

export type ReportFrame = Extract<WebFrame, { type: "report" }>;
export type ReportFrameResult =
  | { ok: true; frame: ReportFrame }
  | { ok: false; status: number; error: string };

export function buildReportFrame(
  b: Record<string, unknown>,
  defaultSource = "api"
): ReportFrameResult {
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title || title.length > 200) return { ok: false, status: 400, error: "bad request" };
  const md = typeof b.markdown === "string" ? b.markdown : "";
  const html = typeof b.html === "string" ? b.html : "";
  if ((md ? 1 : 0) + (html ? 1 : 0) !== 1) return { ok: false, status: 400, error: "bad request" };
  // 16MB (user decision 2026-08-17): the 128KB text-era cap rejected HTML
  // artifacts (full archify renders ~600KB). 16MB covers them with headroom;
  // truly huge content belongs on disk behind /files references, not in frames.
  if (md.length > 16777216 || html.length > 16777216)
    return { ok: false, status: 413, error: "payload too large" };
  const source = typeof b.source === "string" && b.source ? b.source.slice(0, 100) : defaultSource;
  return {
    ok: true,
    frame: {
      type: "report",
      id: "report-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      title,
      source,
      ts: Date.now(),
      ...(md ? { markdown: md } : { html }),
    },
  };
}
