import React, { useState } from "react";
import { CaptionScoreBar, parseCaptionScores } from "./CaptionScoreBar";

interface ReviewButtonProps {
  /** Absolute path to the image file on disk */
  imagePath: string;
  /** Original T2I prompt (for "review" style adherence evaluation) */
  prompt?: string;
  /** Already-loaded caption data (from gallery API) */
  existingCaption?: Record<string, any> | null;
}

/**
 * Small button to run VLM caption (score/review) on an image.
 * Shows results inline as score bars. Results persist as .caption.json.
 */
export function ReviewButton({ imagePath, prompt, existingCaption }: ReviewButtonProps) {
  const [running, setRunning] = useState(false);
  const [style, setStyle] = useState<"score" | "review">("score");
  const [showDropdown, setShowDropdown] = useState(false);
  const [result, setResult] = useState<Record<string, any> | null>(existingCaption ?? null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async (selectedStyle: "score" | "review") => {
    setShowDropdown(false);
    setRunning(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        image: imagePath,
        style: selectedStyle,
      };
      if (selectedStyle === "review" && prompt) {
        body.prompt = prompt;
      }
      const res = await fetch("/api/caption/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok && data.caption) {
        setResult(data.caption);
      } else {
        setError(data.error || "Caption failed");
      }
    } catch (err) {
      setError(`Failed: ${err}`);
    } finally {
      setRunning(false);
    }
  };

  // Parse scores from caption
  const scores = result ? parseCaptionScores(result.caption) : null;

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}>
        <button
          type="button"
          onClick={() => setShowDropdown(!showDropdown)}
          disabled={running}
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text)",
            fontSize: 11,
            padding: "3px 10px",
            cursor: "pointer",
          }}
          title="Run VLM quality analysis"
        >
          {running ? (
            <><span className="spinner" style={{ width: 10, height: 10, display: "inline-block", verticalAlign: "middle" }} /> Scoring…</>
          ) : (
            "📊 Review"
          )}
        </button>

        {error && <span style={{ fontSize: 11, color: "var(--error)" }}>{error}</span>}

        {showDropdown && (
          <div style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 2,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            zIndex: 50,
            overflow: "hidden",
          }}>
            <button type="button" onClick={() => handleRun("score")}
              style={{ display: "block", width: "100%", padding: "6px 12px", background: "none", border: "none", borderBottom: "1px solid var(--border)", color: "var(--text)", textAlign: "left", fontSize: 11, cursor: "pointer" }}>
              📊 Score — quality metrics (1-10)
            </button>
            {prompt && (
              <button type="button" onClick={() => handleRun("review")}
                style={{ display: "block", width: "100%", padding: "6px 12px", background: "none", border: "none", color: "var(--text)", textAlign: "left", fontSize: 11, cursor: "pointer" }}>
                ✅ Review — prompt adherence
              </button>
            )}
          </div>
        )}
      </div>

      {/* Score display */}
      {scores && (
        <CaptionScoreBar
          scores={scores}
          issues={scores.issues}
          strengths={scores.strengths}
          captured={scores.captured}
          missed={scores.missed}
          summary={scores.summary}
        />
      )}
    </div>
  );
}
