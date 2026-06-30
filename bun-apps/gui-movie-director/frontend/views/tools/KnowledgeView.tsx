import React, { useState, useCallback, useEffect } from "react";
import type { ViewDescriptor } from "../registry";
import { scanKnowledge, captionMissing, analyzeKnowledge, getKnowledgeReport, deleteKnowledgeReport } from "../../api/knowledge";

// Inline types matching lib/knowledge-types.ts (frontend can't import lib/ Node.js modules)
interface KnowledgeRecord {
  stem: string;
  dirIdx: number;
  imagePath: string;
  run: { prompt: string; pipeline: string; lora_path: string | null; lora_scale: number; steps: number; cfg_scale: number } | null;
  manifest: { status: string; elapsed_seconds: number } | null;
  caption: { overall: number; [k: string]: unknown } | null;
  hasCaption: boolean;
  qualityScore: number | null;
  pipeline: string;
}

interface KnowledgeReport {
  generatedAt: string;
  model: string;
  recordCount: number;
  avgQualityScore: number;
  markdown: string;
  structured: Record<string, unknown>;
}

type TabId = "scan" | "captions" | "report";
type ReportSubTab = "markdown" | "json";

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span style={{ color: "var(--text-dim)", fontSize: 12 }}>—</span>;
  const color = score >= 8 ? "var(--success)" : score >= 6 ? "var(--warning)" : "var(--error)";
  return (
    <span style={{
      display: "inline-block", minWidth: 28, textAlign: "center",
      padding: "1px 6px", borderRadius: 4, fontSize: 12, fontWeight: 600,
      color, background: `${color}18`,
    }}>
      {score}
    </span>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "10px 16px", background: "var(--bg-elevated)",
      borderRadius: "var(--radius)", border: "1px solid var(--border)", minWidth: 80,
    }}>
      <span style={{ fontSize: 18, fontWeight: 700, color: color ?? "var(--text-bright)" }}>{value}</span>
      <span style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{label}</span>
    </div>
  );
}

function ScanTab({
  records, scanning, onScan,
}: { records: KnowledgeRecord[] | null; scanning: boolean; onScan: () => void }) {
  const total = records?.length ?? 0;
  const withCaption = records?.filter((r) => r.hasCaption).length ?? 0;
  const missing = total - withCaption;
  const avgScore = records && withCaption > 0
    ? Math.round((records.reduce((s, r) => s + (r.qualityScore ?? 0), 0) / withCaption) * 10) / 10
    : null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button className="btn btn-primary" onClick={onScan} disabled={scanning}>
          {scanning ? "⏳ Scanning…" : "🔍 Scan Output Folders"}
        </button>
        {scanning && <div className="spinner" style={{ width: 18, height: 18 }} />}
      </div>

      {records && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <StatBadge label="T2I Records" value={total} />
            <StatBadge label="Have Caption" value={withCaption} color="var(--success)" />
            <StatBadge label="Missing Caption" value={missing} color={missing > 0 ? "var(--warning)" : "var(--text-dim)"} />
            {avgScore !== null && <StatBadge label="Avg Score" value={avgScore} color="var(--accent)" />}
          </div>

          {records.length > 0 ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 110px 60px 60px 180px",
                gap: 8, padding: "8px 12px", background: "var(--bg-elevated)",
                borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 600,
                color: "var(--text-dim)", textTransform: "uppercase" as const,
              }}>
                <span>File</span><span>Pipeline</span><span>Score</span><span>Caption</span><span>LoRA</span>
              </div>
              <div style={{ maxHeight: 500, overflowY: "auto" }}>
                {records.map((rec) => (
                  <div key={`${rec.dirIdx}:${rec.stem}`} style={{
                    display: "grid", gridTemplateColumns: "1fr 110px 60px 60px 180px",
                    gap: 8, padding: "7px 12px",
                    borderBottom: "1px solid var(--border)", alignItems: "center", fontSize: 12,
                  }}>
                    <span style={{ color: "var(--text)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {rec.stem}
                    </span>
                    <span style={{ color: "var(--text-dim)" }}>{rec.pipeline}</span>
                    <ScoreBadge score={rec.qualityScore} />
                    <span style={{ fontSize: 14 }}>{rec.hasCaption ? "✓" : "✗"}</span>
                    <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {rec.run?.lora_path ? rec.run.lora_path.split("/").pop() : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 32 }}>
              No T2I records found in output folders.
            </div>
          )}
        </>
      )}

      {!records && !scanning && (
        <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40, fontSize: 14 }}>
          Click "Scan Output Folders" to discover T2I generation records.
        </div>
      )}
    </div>
  );
}

function CaptionsTab({
  records, onGenerate, generating, genLog,
}: { records: KnowledgeRecord[] | null; onGenerate: () => void; generating: boolean; genLog: string[] }) {
  const missing = records?.filter((r) => !r.hasCaption) ?? [];

  if (!records) {
    return (
      <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40, fontSize: 14 }}>
        Scan first to discover records needing captions.
      </div>
    );
  }
  if (missing.length === 0) {
    return (
      <div style={{ color: "var(--success)", textAlign: "center", padding: 40, fontSize: 14 }}>
        ✓ All {records.length} records have captions.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button className="btn btn-primary" onClick={onGenerate} disabled={generating}>
          {generating ? "⏳ Generating captions…" : `▶ Generate Missing Captions (${missing.length} images)`}
        </button>
        {generating && <div className="spinner" style={{ width: 18, height: 18 }} />}
      </div>

      <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 16 }}>
        Runs <code>run.py caption --style review</code> via LM Studio (Qwen3-VL 4B). Requires LM Studio running locally.
      </p>

      {genLog.length > 0 && (
        <div style={{
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", padding: "10px 14px",
          fontFamily: "monospace", fontSize: 12, color: "var(--text-dim)",
          maxHeight: 200, overflowY: "auto", marginBottom: 16,
        }}>
          {genLog.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}

      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        <div style={{
          padding: "8px 12px", background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border)", fontSize: 11,
          fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" as const,
        }}>
          {missing.length} records without captions
        </div>
        <div style={{ maxHeight: 400, overflowY: "auto" }}>
          {missing.map((rec) => (
            <div key={`${rec.dirIdx}:${rec.stem}`} style={{
              padding: "7px 12px", borderBottom: "1px solid var(--border)",
              fontSize: 12, color: "var(--text-dim)", fontFamily: "monospace",
            }}>
              {rec.stem} <span style={{ fontSize: 11 }}>({rec.pipeline})</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReportTab({
  report, analyzing, analyzeError, onAnalyze, onDelete,
}: {
  report: KnowledgeReport | null;
  analyzing: boolean;
  analyzeError: string | null;
  onAnalyze: (minScore: number, maxRecords: number) => void;
  onDelete: () => void;
}) {
  const [subTab, setSubTab] = useState<ReportSubTab>("markdown");
  const [minScore, setMinScore] = useState(7);
  const [maxRecords, setMaxRecords] = useState(60);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={() => onAnalyze(minScore, maxRecords)} disabled={analyzing}>
          {analyzing ? "⏳ Analyzing with DeepSeek…" : "🧠 Analyze with DeepSeek"}
        </button>
        {report && (
          <button className="btn" onClick={onDelete} style={{ color: "var(--error)", borderColor: "var(--error)" }}>
            🗑 Clear Report
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6 }}>
          Min score:
          <input type="number" min={0} max={10} step={0.5} value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            style={{ width: 52, padding: "3px 6px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12 }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6 }}>
          Max records:
          <input type="number" min={5} max={200} step={5} value={maxRecords}
            onChange={(e) => setMaxRecords(Number(e.target.value))}
            style={{ width: 60, padding: "3px 6px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12 }}
          />
        </label>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          (Requires <code>DEEPSEEK_API_KEY</code> env var or config.json)
        </span>
      </div>

      {analyzeError && (
        <div style={{
          background: "var(--error)18", border: "1px solid var(--error)",
          borderRadius: "var(--radius)", padding: "10px 14px",
          color: "var(--error)", fontSize: 13, marginBottom: 16,
        }}>
          ❌ {analyzeError}
        </div>
      )}

      {analyzing && (
        <div style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 16 }}>
          Sending up to {maxRecords} records to DeepSeek… this may take 15–30 seconds.
        </div>
      )}

      {report && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)" }}>
            <span>Generated: {new Date(report.generatedAt).toLocaleString()}</span>
            <span>•</span>
            <span>Records: {report.recordCount}</span>
            <span>•</span>
            <span>Avg score: {report.avgQualityScore}</span>
            <span>•</span>
            <span>Model: {report.model}</span>
          </div>

          <div style={{ display: "flex", gap: 0, marginBottom: 0, borderBottom: "2px solid var(--border)" }}>
            {(["markdown", "json"] as ReportSubTab[]).map((t) => (
              <button key={t} onClick={() => setSubTab(t)} style={{
                padding: "7px 18px", background: "transparent", border: "none",
                borderBottom: subTab === t ? "2px solid var(--accent)" : "2px solid transparent",
                color: subTab === t ? "var(--accent)" : "var(--text-dim)",
                fontSize: 13, fontWeight: subTab === t ? 600 : 400, cursor: "pointer", marginBottom: -2,
              }}>
                {t === "markdown" ? "📄 Guide" : "{ } JSON"}
              </button>
            ))}
          </div>

          {subTab === "markdown" ? (
            <pre style={{
              background: "var(--bg-elevated)", border: "1px solid var(--border)",
              borderTop: "none", borderRadius: "0 0 var(--radius) var(--radius)",
              padding: "16px 20px", maxHeight: 600, overflowY: "auto",
              fontSize: 13, lineHeight: 1.7, color: "var(--text)",
              whiteSpace: "pre-wrap", fontFamily: "monospace", margin: 0,
            }}>
              {report.markdown}
            </pre>
          ) : (
            <pre style={{
              background: "var(--bg-elevated)", border: "1px solid var(--border)",
              borderTop: "none", borderRadius: "0 0 var(--radius) var(--radius)",
              padding: "16px 20px", maxHeight: 600, overflowY: "auto",
              fontSize: 12, color: "var(--text)", overflowX: "auto", margin: 0,
            }}>
              {JSON.stringify(report.structured, null, 2)}
            </pre>
          )}
        </>
      )}

      {!report && !analyzing && !analyzeError && (
        <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40, fontSize: 14 }}>
          Click "Analyze with DeepSeek" to generate a prompt engineering guide from your T2I history.
        </div>
      )}
    </div>
  );
}

export function KnowledgeView() {
  const [activeTab, setActiveTab] = useState<TabId>("scan");
  const [records, setRecords] = useState<KnowledgeRecord[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genLog, setGenLog] = useState<string[]>([]);
  const [report, setReport] = useState<KnowledgeReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const data = await scanKnowledge();
      if (data.ok) setRecords(data.records ?? []);
    } finally {
      setScanning(false);
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenLog([]);
    try {
      const data = await captionMissing();
      if (data.ok) {
        setGenLog(data.logs ?? []);
        await handleScan();
      }
    } finally {
      setGenerating(false);
    }
  }, [handleScan]);

  const handleAnalyze = useCallback(async (minScore: number, maxRecords: number) => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const data = await analyzeKnowledge({ minScore, maxRecords });
      if (data.ok) {
        setReport(data.report);
      } else {
        setAnalyzeError(data.error ?? "Analysis failed");
      }
    } catch (e: any) {
      setAnalyzeError(e.message ?? "Network error");
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const handleDeleteReport = useCallback(async () => {
    await deleteKnowledgeReport();
    setReport(null);
  }, []);

  useEffect(() => {
    getKnowledgeReport()
      .then((d) => { if (d.ok && d.report) setReport(d.report); })
      .catch(() => {});
  }, []);

  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "scan", label: "Scan", icon: "🔍" },
    { id: "captions", label: "Captions", icon: "🖼" },
    { id: "report", label: "Report", icon: "🧠" },
  ];

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-bright)", margin: 0 }}>
          🧠 T2I Knowledge
        </h2>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Extract prompt engineering insights from your generation history
        </span>
      </div>

      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "2px solid var(--border)" }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: "8px 20px", background: "transparent", border: "none",
            borderBottom: activeTab === t.id ? "2px solid var(--accent)" : "2px solid transparent",
            color: activeTab === t.id ? "var(--accent)" : "var(--text-dim)",
            fontSize: 14, fontWeight: activeTab === t.id ? 600 : 400,
            cursor: "pointer", marginBottom: -2,
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {activeTab === "scan" && <ScanTab records={records} scanning={scanning} onScan={handleScan} />}
      {activeTab === "captions" && (
        <CaptionsTab records={records} onGenerate={handleGenerate} generating={generating} genLog={genLog} />
      )}
      {activeTab === "report" && (
        <ReportTab report={report} analyzing={analyzing} analyzeError={analyzeError} onAnalyze={handleAnalyze} onDelete={handleDeleteReport} />
      )}
    </div>
  );
}

export const knowledgeDescriptor: ViewDescriptor = {
  id: "knowledge",
  group: "Tools",
  label: "T2I Knowledge",
  icon: "🧠",
  component: KnowledgeView,
};
