"""scoring — local, no-reference frame quality scoring (feature-weight rubric).

Step 4 of next-goal-20260708-230000 (the OM ``lib/`` intelligence layer). Ports
OpenMontage's frame-scoring concept: a feature-weighted rubric over the quality
signals a frame's caption produces, so the planner can rank / gate frames
locally (constraint 1 + 3: no cloud, the orchestrator reads TEXT/number
judgments never pixels).

OM's rubric up-weights features by capability: a capability the stack genuinely
has (e.g. inpainting, now backed by ``run.py image inpaint`` — Step 2) carries a
heavier weight because a frame exercising it is more diagnostic. The default
weight table includes the documented ``("inpainting", 1.5)`` plus the standard
photographic axes.

This is the no-reference (no golden image) scorer. The signals come from
``run.py caption --style score`` (the local VLM judge) or the deterministic
``app/quality_metrics.py`` metrics — both produce ``{feature: number}`` dicts.
``score_frame`` is a pure function over such a dict; it does no IO of its own.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ─── Default feature-weight rubric (OM shape) ─────────────────────────────────
# weight 1.0 = standard photographic axis. >1.0 = a capability-weighted axis
# (inpainting is heavier because Step 2 just unlocked masked redraw locally).
# Unknown features in a signals dict still count, at weight 1.0.
DEFAULT_FEATURE_WEIGHTS: dict[str, float] = {
    "sharpness": 1.0,
    "exposure": 1.0,
    "contrast": 1.0,
    "composition": 1.0,
    "color": 1.0,
    "detail": 1.0,
    "artifact": 0.7,        # lower: artifact is a defect axis, not a capability
    "inpainting": 1.5,      # capability-weighted (Step 2); seam/region coherence
    "identity": 1.3,        # capability-weighted (character consistency, Step 2/3)
}

DEFAULT_PASS_THRESHOLD = 0.6   # weighted score [0,1] at/above which a frame passes


@dataclass
class ScoreBreakdown:
    """One feature's contribution to the weighted score."""
    feature: str
    value: float          # the raw signal in [0,1] (clamped)
    weight: float         # the rubric weight applied
    weighted: float       # value * weight


@dataclass
class ScoreReport:
    """The weighted-score verdict for one frame (the planner / closed-loop input)."""
    score: float                       # weighted aggregate in [0,1]
    passed: bool                       # score >= threshold
    threshold: float
    breakdown: list[ScoreBreakdown] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)   # rubric features absent from signals

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 4),
            "passed": self.passed,
            "threshold": self.threshold,
            "breakdown": [
                {"feature": b.feature, "value": round(b.value, 4),
                 "weight": b.weight, "weighted": round(b.weighted, 4)}
                for b in self.breakdown
            ],
            "missing": list(self.missing),
        }


def _clamp01(x: float) -> float:
    if x is None:
        return 0.0
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    if v < 0:
        return 0.0
    if v > 1:
        return 1.0
    return v


def score_frame(
    signals: dict[str, Any] | None,
    weights: dict[str, float] | None = None,
    threshold: float = DEFAULT_PASS_THRESHOLD,
) -> ScoreReport:
    """Score a frame's quality signals under a feature-weight rubric.

    Args:
        signals: ``{feature: value}`` where value is in [0,1] (values outside are
            clamped). May be ``None`` / empty (yields score 0, passed False) — a
            frame with no judge is treated as failing, never as passing silently.
        weights: Feature-weight overrides. Defaults to :data:`DEFAULT_FEATURE_WEIGHTS`.
            Features present in ``signals`` but absent from the weight table count
            at 1.0 (so adding a new signal never silently drops it).
        threshold: Weighted score at/above which the frame ``passes``.

    Returns:
        A :class:`ScoreReport` carrying the weighted aggregate, the per-feature
        breakdown, and the missing-feature list. Pure — no IO.
    """
    weights = weights if weights is not None else DEFAULT_FEATURE_WEIGHTS
    signals = signals or {}

    breakdown: list[ScoreBreakdown] = []
    missing: list[str] = []
    seen: set[str] = set()

    for feature, raw in signals.items():
        if feature in ("score", "overall", "summary", "issues"):
            continue  # meta keys from caption --style score are not axes
        seen.add(feature)
        value = _clamp01(raw)
        weight = float(weights.get(feature, 1.0))
        breakdown.append(ScoreBreakdown(feature=feature, value=value,
                                        weight=weight, weighted=value * weight))

    for feature in weights:              # rubric features the signals omitted
        if feature not in seen:
            missing.append(feature)

    total_weight = sum(b.weight for b in breakdown)
    if total_weight <= 0:
        score = 0.0
    else:
        score = sum(b.weighted for b in breakdown) / total_weight

    return ScoreReport(
        score=score,
        passed=score >= threshold,
        threshold=threshold,
        breakdown=breakdown,
        missing=missing,
    )


def rank_frames(
    frames: list[dict[str, Any]],
    signals_key: str = "signals",
    weights: dict[str, float] | None = None,
) -> list[tuple[dict[str, Any], ScoreReport]]:
    """Rank a frame list by weighted score (best first).

    Each frame dict is scored under its ``signals_key`` sub-dict (default
    ``"signals"`` — the shape a caption-score ingest writes). Frames missing the
    key score 0 and sort last. Stable: ties keep input order. Pure.
    """
    scored = [(f, score_frame(f.get(signals_key), weights=weights)) for f in frames]
    scored.sort(key=lambda pair: pair[1].score, reverse=True)
    return scored
