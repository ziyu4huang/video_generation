# t03 first REAL input — the grader's v1 settle rule was MISCALIBRATED, and the
# receipts are the evidence (found live 2026-09-10):
#
# run 1 (exit 1): the grader flagged catalog/cc-parity/swarm settled snaps for
# live markers — but those are the PERSISTENT-BACKGROUND scenarios: background
# rows keep their spinner after the tested task settles (catalog's routed bg
# run, cc-parity's chain+reviewer children, swarm's batch). run 2 flagged
# viewer (follows a child run) and wf-pause (the workflow row itself).
#
# Fix: settledLike is per-scenario — null for the five persistent-background
# scenarios (their forced route/badge labels are the settle evidence),
# marker-absence for the five single-task ones (dispatch/parallel/agents/
# reload/workflow, all of which passed from run 1).
#
# Final run on the REAL 2026-09-10 sweep: 10/10 re-derived green, allAgree
# true, exit 0 — JSON below.

{
  "ok": true,
  "sweepDir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full",
  "scenarios": [
    {
      "scenario": "agents",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/agents",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "catalog",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/catalog",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "cc-parity",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/cc-parity",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "dispatch",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/dispatch",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "parallel",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/parallel",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "reload",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/reload",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "swarm",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/swarm",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "viewer",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/viewer",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "wf-pause",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/wf-pause",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    },
    {
      "scenario": "workflow",
      "dir": "/Users/huangziyu/proj/video_generation__memory/output/qualify19-full/workflow",
      "derivedPass": true,
      "problems": [],
      "selfPass": true,
      "agree": true
    }
  ],
  "problems": [],
  "allAgree": true
}
