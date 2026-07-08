"""verify_scene_pacing — the scene-pacing gate (OM motion.pacing_rules).

Step 4 of next-goal-20260708-230000 (the OM ``lib/`` intelligence layer, pure-
python). OpenMontage's playbook pins a pacing envelope every scene must fit
inside (``motion.pacing_rules.min_scene_hold_seconds`` /
``max_scene_hold_seconds`` / ``text_card_hold_seconds``); this module checks a
scene plan against it and reports violations. The planner consumes the report's
``ok`` flag as a scene-plan gate (reject / re-plan when pacing is off).

LOCAL ONLY: pure arithmetic over (start_seconds, end_seconds, type) — no
generation, no LLM. The OM canonical scene_plan carries these fields verbatim
(see ``data/schemas/artifacts/scene_plan.schema.json``).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.planning.playbook import PacingRules


@dataclass
class PacingViolation:
    """One scene that broke a pacing rule."""
    scene_id: str
    rule: str            # "min_hold" | "max_hold" | "text_card_hold" | "ordering"
    hold_seconds: float
    detail: str


@dataclass
class PacingReport:
    """The pacing verdict for a whole scene plan."""
    ok: bool
    violations: list[PacingViolation] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "violations": [
                {"scene_id": v.scene_id, "rule": v.rule,
                 "hold_seconds": round(v.hold_seconds, 3), "detail": v.detail}
                for v in self.violations
            ],
        }


def _hold(scene: dict[str, Any]) -> float | None:
    """The scene's duration in seconds, or None when the timing fields are absent."""
    try:
        start = float(scene.get("start_seconds"))
        end = float(scene.get("end_seconds"))
    except (TypeError, ValueError):
        return None
    return end - start


def verify_scene_pacing(
    scenes: list[dict[str, Any]],
    pacing: PacingRules | None = None,
) -> PacingReport:
    """Check a scene plan against the playbook's pacing envelope.

    Args:
        scenes: OM scene_plan ``scenes[]`` dicts (need ``id``, ``type``,
            ``start_seconds``, ``end_seconds``). Scenes missing timing are skipped
            (a transition-only check would be noise).
        pacing: The playbook's pacing rules. ``None`` → :data:`PacingRules`
            defaults (so the gate still runs on a playbook-less plan).

    Returns:
        A :class:`PacingReport`. ``ok`` is False when any scene under-holds, over-
        holds, or a text_card under-holds its stricter floor. Ordering violations
        (end < start, or a scene starting before the prior ended) are also flagged.
        Pure — no IO.
    """
    pacing = pacing or PacingRules()
    violations: list[PacingViolation] = []
    prev_end: float | None = None

    for scene in scenes:
        sid = str(scene.get("id", "?"))
        stype = scene.get("type", "")
        hold = _hold(scene)

        start = scene.get("start_seconds")
        end = scene.get("end_seconds")
        # Ordering: end must be >= start; scenes must not overlap the prior.
        if hold is not None and hold < 0:
            violations.append(PacingViolation(
                scene_id=sid, rule="ordering", hold_seconds=hold,
                detail=f"end_seconds ({end}) < start_seconds ({start})"))
        if prev_end is not None and start is not None:
            try:
                if float(start) + 1e-6 < float(prev_end):
                    violations.append(PacingViolation(
                        scene_id=sid, rule="ordering", hold_seconds=hold or 0.0,
                        detail=f"starts ({start}) before prior scene ended ({prev_end})"))
            except (TypeError, ValueError):
                pass

        if hold is None:
            continue  # no timing to gate

        # text_card has its own (usually longer) floor.
        if stype == "text_card":
            if hold + 1e-6 < pacing.text_card_hold_seconds:
                violations.append(PacingViolation(
                    scene_id=sid, rule="text_card_hold", hold_seconds=hold,
                    detail=f"text_card held {hold:.2f}s < floor "
                           f"{pacing.text_card_hold_seconds}s"))
        else:
            if hold + 1e-6 < pacing.min_scene_hold_seconds:
                violations.append(PacingViolation(
                    scene_id=sid, rule="min_hold", hold_seconds=hold,
                    detail=f"held {hold:.2f}s < min {pacing.min_scene_hold_seconds}s"))
        if hold - 1e-6 > pacing.max_scene_hold_seconds:
            violations.append(PacingViolation(
                scene_id=sid, rule="max_hold", hold_seconds=hold,
                detail=f"held {hold:.2f}s > max {pacing.max_scene_hold_seconds}s"))

        if end is not None:
            try:
                prev_end = float(end)
            except (TypeError, ValueError):
                pass

    return PacingReport(ok=not violations, violations=violations)
