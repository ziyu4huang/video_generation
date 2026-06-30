import { loadLatestCodeReport } from "../lib/code-knowledge";

// GET /api/code-knowledge/report — latest code-health trend report aggregated
// from gui-movie-director-self-improve runs (openIssues trend, most bug-prone
// files, recurring finding dimensions, fix rate). Companion to
// /api/knowledge/report (generation quality) — the two share the
// knowledge-base/ root but live in separate subdirs (code/ vs records/reports/).
export async function handleCodeKnowledgeReport(_req: Request): Promise<Response> {
  const report = loadLatestCodeReport();
  return Response.json({ ok: true, report });
}
