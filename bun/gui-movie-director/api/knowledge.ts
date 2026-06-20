import { parsePostJson } from "../lib/requestUtils";
import {
  scanOutputDirs,
  generateMissingCaptions,
  callDeepSeek,
  loadReport,
  saveReport,
  deleteReport,
} from "../lib/knowledge-extractor";

let _scanCache: ReturnType<typeof scanOutputDirs> | null = null;

export async function handleKnowledgeScan(_req: Request): Promise<Response> {
  _scanCache = scanOutputDirs();
  return Response.json({ ok: true, records: _scanCache });
}

export async function handleKnowledgeCaptionMissing(req: Request): Promise<Response> {
  const body = await parsePostJson<{ limit?: number }>(req);
  if (body instanceof Response) return body;

  // Use cached scan or do a fresh one
  const records = _scanCache ?? scanOutputDirs();
  _scanCache = records;

  const missing = records.filter((r) => !r.hasCaption);
  if (missing.length === 0) {
    return Response.json({ ok: true, message: "No missing captions", generated: 0, failed: 0 });
  }

  const logs: string[] = [];
  const { generated, failed } = await generateMissingCaptions(
    records,
    (p) => {
      if (p.current) logs.push(`[${p.done + 1}/${p.total}] ${p.current}`);
    },
    body.limit,
  );

  // Refresh cache after generation
  _scanCache = null;

  return Response.json({ ok: true, generated, failed, logs });
}

export async function handleKnowledgeAnalyze(req: Request): Promise<Response> {
  const body = await parsePostJson<{ minScore?: number; maxRecords?: number }>(req);
  if (body instanceof Response) return body;

  const records = _scanCache ?? scanOutputDirs();
  _scanCache = records;

  try {
    const report = await callDeepSeek(records, {
      minScore: body.minScore,
      maxRecords: body.maxRecords,
    });
    saveReport(report);
    return Response.json({ ok: true, report });
  } catch (err: any) {
    console.error("[knowledge] analyze error:", err);
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return Response.json(
      { ok: false, error: isTimeout ? "DeepSeek request timed out (>90s)" : err.message ?? "Analysis failed" },
      { status: isTimeout ? 504 : 500 },
    );
  }
}

export async function handleKnowledgeGetReport(_req: Request): Promise<Response> {
  const report = loadReport();
  return Response.json({ ok: true, report });
}

export async function handleKnowledgeDeleteReport(_req: Request): Promise<Response> {
  deleteReport();
  _scanCache = null;
  return Response.json({ ok: true });
}
