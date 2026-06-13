#!/usr/bin/env python3
"""Workflow History Dashboard — aggregate & visualize run history across all workflows.

Reads JSON run history from .claude/workflows/history/<workflow-name>/*.json
and outputs summary tables, trends, and phase-failure analysis.

Usage:
    ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py
    ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --workflow mlx-movie-director-review-optimize
    ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --last 5
    ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --json
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Resolve project root (git repo root)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
HISTORY_ROOT = PROJECT_ROOT / ".claude" / "workflows" / "history"

# ── Data loading ──────────────────────────────────────────────────────────────


def load_all_history(last_n=None):
    """Load history JSONs from all workflow directories."""
    if not HISTORY_ROOT.exists():
        print(f"No history directory found: {HISTORY_ROOT}", file=sys.stderr)
        return {}

    by_workflow = {}
    for wf_dir in sorted(HISTORY_ROOT.iterdir()):
        if not wf_dir.is_dir():
            continue
        runs = []
        json_files = sorted(wf_dir.glob("*.json"), reverse=True)
        if last_n:
            json_files = json_files[:last_n]
        for jf in json_files:
            try:
                data = json.loads(jf.read_text(encoding="utf-8"))
                data["_file"] = str(jf)
                runs.append(data)
            except (json.JSONDecodeError, OSError) as e:
                print(f"  WARN: skip {jf.name}: {e}", file=sys.stderr)
        if runs:
            by_workflow[wf_dir.name] = runs
    return by_workflow


# ── Formatters ────────────────────────────────────────────────────────────────


def fmt_ts(ts_str):
    """Format ISO-ish timestamp for display."""
    if not ts_str:
        return "?"
    # Handle various formats: 2026-06-13T22-39-21 or 2026-06-13_082530
    for fmt in ("%Y-%m-%dT%H-%M-%S", "%Y-%m-%d_%H%M%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(ts_str, fmt)
            return dt.strftime("%Y-%m-%d %H:%M")
        except ValueError:
            continue
    return ts_str[:16]


def fmt_pct(n, total):
    return f"{n / total * 100:.0f}%" if total else "-"


# ── Overview table ────────────────────────────────────────────────────────────


def print_overview(by_workflow):
    """Print summary table: workflow name, run count, pass rate, last run."""
    print()
    print("  ═══ Workflow History Dashboard ═══")
    print()
    print(f"  {'Workflow':<48} {'Runs':>5} {'Pass%':>6} {'Last Run':>16}")
    print(f"  {'─' * 48} {'─' * 5} {'─' * 6} {'─' * 16}")

    for wf_name, runs in sorted(by_workflow.items()):
        total = len(runs)
        complete = sum(1 for r in runs if r.get("status") == "complete")
        partial = sum(1 for r in runs if r.get("status") == "partial")
        pass_rate = fmt_pct(complete, total)
        last_ts = fmt_ts(runs[0].get("started_at") or runs[0].get("run_id", ""))
        # Shorten workflow name for display
        display_name = wf_name
        if len(display_name) > 47:
            display_name = "…" + display_name[-46:]
        marker = " ✓" if partial == 0 else f" ⚠{partial}"
        print(f"  {display_name:<48} {total:>5} {pass_rate:>6} {last_ts:>16}{marker}")

    print()
    total_runs = sum(len(r) for r in by_workflow.values())
    total_complete = sum(1 for runs in by_workflow.values() for r in runs if r.get("status") == "complete")
    print(f"  Total: {total_runs} runs across {len(by_workflow)} workflows ({fmt_pct(total_complete, total_runs)} complete)")
    print()


# ── Per-workflow trend ────────────────────────────────────────────────────────


def print_trend(wf_name, runs):
    """Print run history trend for one workflow."""
    print(f"  Trends ({wf_name}):")
    print(f"  {'Run ID':<22} {'Status':<9} {'Phases OK':>10} {'Phases Fail':>12} {'Tags':<30}")
    print(f"  {'─' * 22} {'─' * 9} {'─' * 10} {'─' * 12} {'─' * 30}")

    for r in runs:
        run_id = r.get("run_id", "?")[:19]
        status = r.get("status", "?")
        phases_ok = len(r.get("phases_completed", []))
        phases_fail = len(r.get("phases_failed", []))
        tags = ", ".join(r.get("tags", [])[:3])
        if len(tags) > 29:
            tags = tags[:28] + "…"
        status_icon = "✓" if status == "complete" else "⚠" if status == "partial" else "✗"
        print(f"  {run_id:<22} {status_icon} {status:<7} {phases_ok:>10} {phases_fail:>12} {tags:<30}")

    print()


def print_result_summary(runs):
    """Print workflow-specific result highlights."""
    for r in runs[:5]:
        run_id = r.get("run_id", "?")[:19]
        result = r.get("result", {})
        # Try to show something useful based on the workflow type
        parts = []
        if "findings" in result:
            f = result["findings"]
            parts.append(f"findings={f.get('total', '?')}")
            parts.append(f"verified={f.get('verified', '?')}")
        if "fixes" in result:
            fx = result["fixes"]
            parts.append(f"applied={fx.get('applied', '?')}")
            parts.append(f"regressions={fx.get('regressions', '?')}")
        if "generation" in result:
            g = result["generation"]
            parts.append(f"images={g.get('totalImages', '?')}")
            parts.append(f"success={g.get('successCount', '?')}")
        if "imageCount" in result:
            parts.append(f"images={result['imageCount']}")
        if "modelCount" in result:
            parts.append(f"models={result['modelCount']}")
        if "allReady" in result:
            parts.append(f"ready={'✓' if result['allReady'] else '✗'}")

        if parts:
            print(f"    {run_id}: {' | '.join(parts)}")
    print()


# ── Phase failure analysis ───────────────────────────────────────────────────


def print_phase_failures(by_workflow):
    """Aggregate phase failures across all workflows."""
    phase_failures = defaultdict(int)
    phase_fail_wf = defaultdict(set)

    for wf_name, runs in by_workflow.items():
        for r in runs:
            for pf in r.get("phases_failed", []):
                phase_failures[pf] += 1
                phase_fail_wf[pf].add(wf_name)

    if not phase_failures:
        print("  Phase failures: none recorded (all runs clean or no tracking)")
        print()
        return

    print("  Phase Failure Frequency:")
    print(f"  {'Phase':<25} {'Count':>6} {'Workflows':<50}")
    print(f"  {'─' * 25} {'─' * 6} {'─' * 50}")
    for phase, count in sorted(phase_failures.items(), key=lambda x: -x[1]):
        wfs = ", ".join(sorted(phase_fail_wf[phase]))
        if len(wfs) > 49:
            wfs = wfs[:48] + "…"
        print(f"  {phase:<25} {count:>6} {wfs:<50}")
    print()


# ── JSON output ──────────────────────────────────────────────────────────────


def output_json(by_workflow):
    """Machine-readable JSON output."""
    output = {}
    for wf_name, runs in sorted(by_workflow.items()):
        output[wf_name] = [
            {
                "run_id": r.get("run_id"),
                "status": r.get("status"),
                "started_at": r.get("started_at"),
                "phases_completed": r.get("phases_completed", []),
                "phases_failed": r.get("phases_failed", []),
                "tags": r.get("tags", []),
                "args": r.get("args"),
                "result": r.get("result"),
            }
            for r in runs
        ]
    print(json.dumps(output, indent=2, ensure_ascii=False))


# ── Main ──────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Workflow History Dashboard")
    parser.add_argument("--workflow", "-w", help="Show trends for a specific workflow")
    parser.add_argument("--last", "-n", type=int, default=None, help="Show only last N runs per workflow")
    parser.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    by_workflow = load_all_history(last_n=args.last)

    if not by_workflow:
        print("No workflow history found.")
        sys.exit(0)

    if args.json:
        output_json(by_workflow)
        return

    # Overview
    print_overview(by_workflow)

    # Specific workflow detail
    if args.workflow:
        wf_name = args.workflow
        if wf_name in by_workflow:
            print_trend(wf_name, by_workflow[wf_name])
            print_result_summary(by_workflow[wf_name])
        else:
            # Try partial match
            matches = [k for k in by_workflow if args.workflow in k]
            if matches:
                for m in matches:
                    print_trend(m, by_workflow[m])
                    print_result_summary(by_workflow[m])
            else:
                print(f"  No history found for '{args.workflow}'")
                print(f"  Available: {', '.join(sorted(by_workflow.keys()))}")
                sys.exit(1)
    else:
        # Show brief trend for each workflow
        for wf_name, runs in sorted(by_workflow.items()):
            print_trend(wf_name, runs)
            print_result_summary(runs)

    # Phase failure analysis (aggregate)
    print_phase_failures(by_workflow)


if __name__ == "__main__":
    main()
