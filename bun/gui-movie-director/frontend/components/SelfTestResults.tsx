import React, { useState, useEffect, useCallback } from "react";
import type { JobInfo } from "../types";
import { CaptionScoreBar, parseCaptionScores, scoreColor } from "./CaptionScoreBar";
import { ImagePreview } from "./ImagePreview";
import { ParamBadge } from "./ParamBadge";

interface Props {
  job: JobInfo;
}

interface SelfTestVariant {
  filename: string;
  url: string;
  fullPath: string;
  params: Record<string, any>;
  run: Record<string, any> | null;
  caption: Record<string, any> | null;
  captionPath: string | null;
}

interface ResultsResponse {
  jobId: string;
  variants: SelfTestVariant[];
  htmlReviewUrl: string | null;
  variantCount: number;
}

/**
 * Renders self-test results after a self-test job completes: a variant grid
 * with inline VLM scores, parameter badges, winner highlighting, a "Score All"
 * batch button, and a link to the Python-generated HTML review.
 */
export function SelfTestResults({ job }: Props) {
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-variant caption overrides (updated after Score / Score All)
  const [captionOverrides, setCaptionOverrides] = useState<Record<string, Record<string, any> | null>>({});
  const [scoringAll, setScoringAll] = useState(false);
  const [scoringIdx, setScoringIdx] = useState<number | null>(null);
  const [preview, setPreview] = useState<SelfTestVariant | null>(null);

  const fetchResults = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/selftest/results?jobId=${encodeURIComponent(job.id)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setResults(data);
      })
      .catch((err) => setError(`Failed: ${err}`))
      .finally(() => setLoading(false));
  }, [job.id]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // Get the effective caption for a variant (override > fetched)
  const getCaption = (v: SelfTestVariant) =>
    captionOverrides[v.filename] !== undefined ? captionOverrides[v.filename] : v.caption;

  // Score a single variant via the caption API. Returns the new caption or null.
  const scoreOne = useCallback(
    async (v: SelfTestVariant): Promise<Record<string, any> | null> => {
      const res = await fetch("/api/caption/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: v.fullPath, style: "score" }),
      });
      const data = await res.json();
      if (data.ok && data.caption) {
        setCaptionOverrides((prev) => ({ ...prev, [v.filename]: data.caption }));
        return data.caption;
      }
      return null;
    },
    [],
  );

  const handleScore = async (v: SelfTestVariant, idx: number) => {
    setScoringIdx(idx);
    try {
      await scoreOne(v);
    } finally {
      setScoringIdx(null);
    }
  };

  const handleScoreAll = async () => {
    if (!results) return;
    const unscored = results.variants.filter((v) => !getCaption(v));
    if (unscored.length === 0) return;
    setScoringAll(true);
    for (let i = 0; i < unscored.length; i++) {
      setScoringIdx(results.variants.indexOf(unscored[i]));
      await scoreOne(unscored[i]);
    }
    setScoringAll(false);
    setScoringIdx(null);
  };

  // Compute winner: highest average score across scored variants
  const winnerFilename = (() => {
    if (!results) return null;
    let best: { file: string; avg: number } | null = null;
    for (const v of results.variants) {
      const cap = getCaption(v);
      const scores = cap ? parseCaptionScores(cap.caption) : null;
      if (!scores || !scores.overall) continue;
      if (!best || scores.overall > best.avg) {
        best = { file: v.filename, avg: scores.overall };
      }
    }
    return best?.file ?? null;
  })();

  const unscoredCount = results
    ? results.variants.filter((v) => !getCaption(v)).length
    : 0;

  if (loading) {
    return (
      <div style={{ marginTop: 20 }}>
        <div className="spinner" style={{ width: 14, height: 14, display: "inline-block", verticalAlign: "middle" }} />
        <span style={{ marginLeft: 8, color: "var(--text-dim)", fontSize: 13 }}>Loading self-test results…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ marginTop: 20, padding: 12, background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--error)" }}>
        <span style={{ color: "var(--error)", fontSize: 13 }}>{error}</span>
      </div>
    );
  }

  if (!results || results.variants.length === 0) {
    return (
      <div style={{ marginTop: 20, padding: 12, color: "var(--text-dim)", fontSize: 13 }}>
        No self-test output images found.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 14, color: "var(--text-bright)", margin: 0 }}>
          🧪 Self-Test Results ({results.variantCount} variants)
        </h3>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {unscoredCount > 0 && (
            <button
              type="button"
              className="btn"
              onClick={handleScoreAll}
              disabled={scoringAll}
              style={{ fontSize: 12, padding: "5px 12px" }}
              title="Run VLM quality scoring on all unscored variants"
            >
              {scoringAll ? (
                <><span className="spinner" style={{ width: 11, height: 11, display: "inline-block", verticalAlign: "middle" }} /> Scoring…</>
              ) : (
                `📊 Score All (${unscoredCount})`
              )}
            </button>
          )}
          {results.htmlReviewUrl && (
            <a
              href={results.htmlReviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
              style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none", display: "inline-block" }}
              title="Open the interactive A/B review HTML generated by Python"
            >
              📄 Open HTML Review ↗
            </a>
          )}
        </div>
      </div>

      {/* Winner banner */}
      {winnerFilename && (
        <div style={{ marginBottom: 10, padding: "6px 12px", background: "rgba(76,175,80,0.1)", border: "1px solid var(--success)", borderRadius: "var(--radius)", fontSize: 12, color: "var(--success)" }}>
          🏆 Winner: <b>{winnerFilename}</b>
        </div>
      )}

      {/* Variant grid */}
      <div className="gallery-grid">
        {results.variants.map((v, idx) => {
          const cap = getCaption(v);
          const scores = cap ? parseCaptionScores(cap.caption) : null;
          const isWinner = v.filename === winnerFilename;
          const isScoring = scoringIdx === idx;
          return (
            <div
              key={v.filename}
              className="gallery-card"
              style={{
                border: isWinner ? "2px solid var(--success)" : undefined,
                padding: 0,
              }}
            >
              {/* Thumbnail */}
              <div style={{ cursor: "pointer", position: "relative" }} onClick={() => setPreview(v)}>
                <img
                  src={v.url}
                  alt={v.filename}
                  loading="lazy"
                  style={{ width: "100%", display: "block", borderRadius: "var(--radius) var(--radius) 0 0" }}
                />
                {isWinner && (
                  <span style={{ position: "absolute", top: 6, left: 6, background: "var(--success)", color: "#fff", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 3 }}>
                    🏆 {scores?.overall}/10
                  </span>
                )}
                {scores && !isWinner && (
                  <span style={{ position: "absolute", top: 6, left: 6, background: "var(--bg)", color: scoreColor(scores.overall ?? 0), fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 3, opacity: 0.92 }}>
                    {scores.overall}/10
                  </span>
                )}
              </div>

              {/* Body */}
              <div style={{ padding: "8px 10px" }}>
                {/* Parameter badge */}
                <ParamBadge params={v.params} filename={v.filename} />

                {/* Scores */}
                {scores ? (
                  <CaptionScoreBar
                    scores={scores}
                    issues={scores.issues}
                    strengths={scores.strengths}
                    captured={scores.captured}
                    missed={scores.missed}
                    summary={scores.summary}
                  />
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleScore(v, idx)}
                    disabled={isScoring || scoringAll}
                    style={{ marginTop: 8, fontSize: 11, padding: "4px 10px", width: "100%" }}
                  >
                    {isScoring ? (
                      <><span className="spinner" style={{ width: 11, height: 11, display: "inline-block", verticalAlign: "middle" }} /> Scoring…</>
                    ) : (
                      "📊 Score"
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Lightbox preview */}
      {preview && (
        <ImagePreview
          url={preview.url}
          run={preview.run}
          caption={getCaption(preview)}
          captionPath={preview.captionPath}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

