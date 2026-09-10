# t03 — Deployed verification: grep-asserted redeploy + steer drill + dispatch smoke

Effort: 2026-09-10-self-arc-23-subagent-steer-deploy · map D1/D5/D6
Runs AFTER the implementation PR merges. Receipts-only — no PR (map D5).
Status: open

## Problem

Both fixes must be proven on the SHIPPED tree, and the shipped tree must be proven
to be this arc's code BEFORE any driving (arc-19's lesson: a deploy that looks fresh
served stale bundles; learning #1 — grep the artifact, then trust the label).

## Work

1. **Redeploy with t01 live** via the devops chain (`deploy-cli` against the
   post-merge tree; explicit deploy — deploy timing is irrelevant by design,
   arc-19 D5 pattern). The run's JSON must carry t01's attestation results —
   treat any failed marker as a t01 regression, not a t03 obstacle: stop and file.
2. **Pre-drive grep-assert (manual form, independent of t01's guard):** for each
   rebuilt bundle, grep the DEPLOYED artifact for this arc's distinctive symbols —
   at minimum the t02 steer-outcome strings (e.g. the queued-after-current-tool
   wording) in `ext/subagent/ext.cjs`, and any t01 marker strings in the core.
   Record counts in the receipt folder BEFORE launching tui-drive. A zero count =
   stop; do not drive a stale tree.
3. **Steer drill, deployed:** `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts
   --sh <outRoot>/<target>/current/s2-agent.sh` (resolve the same way arc-19 t04
   did) — run the t02 steer drill scenario: background child with a long tool call →
   steer mid-tool with a marker → the receipt asserts the child's output CONTAINS
   the marker. glm-5.3 child; flash excluded by name (map D6).
4. **Dispatch smoke, deployed:** one dispatch scenario re-run to confirm no
   regression in the live call row (liveModelSlot latching, wrap-tolerant judge).
5. Receipts under `output/self-arc22-*` (scratch — never committed, map D6);
   each receipt must carry arc-19 t01's launcher provenance block and stay
   re-gradeable from primary evidence (arc-21 receipt-validator compatible).

## Done when

Deploy JSON shows attestation green; pre-drive grep counts recorded non-zero; steer
drill receipt PASS on the deployed tree (marker in child output); dispatch smoke
PASS; no flash anywhere in the receipts.

## Risks

- If the deploy serves stale content despite t01: STOP — that is a failing receipt
  and t01 evidence (never delete it); re-run t01's investigation on the new data.
- Long tool calls make the drill slow — budget the scenario timeout like arc-19's
  sleep-90 drill did (paced wall-clock retries, learning #3/#4 feeding rules).
