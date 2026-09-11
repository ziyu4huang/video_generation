## Arc plan — fill the gemma column of the spwf-ab matrix

**Current state, verified myself (2026-09-11, this machine):**

| Check | Result |
|---|---|
| Deployed pins | `0.10.3+gc172fd3` still exists, F2 directive grep in `ext/superpowers/ext.cjs` = **1** (PB-09 applied — string literal survives minification). Newer dirs `g7dc0192`/`g6423400` (= `current`) also grep 1; main tip is now `aaf829b6` |
| Committed harness | `wayfind/scripts/drive-case.ts` + `spwf-battery.sh` + `tests/drive-case-detector.test.ts` present; detector test **5/5 green**, 0 fail |
| LM Studio `/v1/models` NOW | gemma resident **✓** (`google/gemma-4-12b`, plus a `-qat` variant), but **4 large chat models** total (bonsai-27b, qwen3.8-27b, both gemmas) → **precondition RED at this instant** (closing map's 22:06–22:08 polls saw the same shape) |
| Worktree | Memory worktree **occupied**: `selfimprove-playbook` branch, 4 dirty files (devops SKILLs, arc-plan.ts, vault submodule) — no overlap with wayfind scripts, but PB-01/PB-02 force a dedicated worktree |
| Ledger | Last claim = self-arc 23; new effort is a content slug, **no series number to claim** |
| Prior receipts | No `output/spwf-battery/` exists — no partial gemma run to reconcile |

---

### Effort

**`.planning/2026-09-11-spwf-gemma-fill/`** (content slug, no ledger entry; dedicated worktree at origin/main tip; branch `spwf-gemma-fill`; touches only `.planning/` + scratch — zero overlap with the selfimprove-playbook sibling, PB-02).

### Destination

The gemma column of the A/B verdict matrix (`.planning/2026-09-10-spwf-drive-ab/map.md` §Verdict matrix) stops being `UNTESTED-infrastructure`: every cell (C2/C3/C5/C8 core, C4 stretch, C1 free) holds either a real verdict from a model-pinned, quiet-window receipt, or a **second dated defer note** naming the sibling blocker. Deltas vs glm are findings, never prompt re-rolls. Matrix flip + `Completed-by`-style cross-link on the drive-ab map cite committed evidence under this effort's `evidence/` (PB-18). Loop ritual closes: reviewer, PR, status flip + Shipped-as in the same PR (PB-05, PB-03, PB-04).

### The precondition check (D5, operationalized)

Poll `GET $LMSTUDIO_BASE_URL/v1/models` (default `127.0.0.1:1234`) at **t0, t0+60s, t0+120s** — 3 consecutive polls ≥60s apart, recorded as `evidence/polls.json`. Per poll, using drive-case.ts's own predicate (same ruler as the harness precheck — PB-12):

- **gemma resident** ⟺ `google/gemma-4-12b` in `data[].id`;
- **large-chat count** ⟺ non-embedding ids with param-count ≥ 7B (`LARGE_MODEL_MIN_B`).

**Green ⟺ all 3 polls: gemma resident AND count ≤ 1.** Max **2 windows**; on failure of both → dated defer (blocker is sibling-owned LM Studio churn; we do **not** unload sibling models), cells stay UNTESTED-infrastructure, done-when's "escalated with a second dated note" branch. Pre-registered mid-leg rule (PB-11): drive-case.ts's built-in contention precheck stamps every receipt — a leg that starts with `large>1` recorded is **SKIP/infra, preserved, never a red** (PB-13, PB-15); budget ≤2 legs/cell, no rewording (PB-14).

### Tickets

- **t01** Open effort: dedicated worktree from origin/main tip (`sync-default-branch` semantics via CLI twin), branch, map, this-plan commit; re-verify pin: `grep -c "check the available skills list" …/0.10.3+gc172fd3/ext/superpowers/ext.cjs` must be 1 (PB-08 — pin immutable dir, never `current`; **keep the gc172fd3 pin, not the newer deploys**: it's byte-identical to what the glm column ran, so model is the matrix's only variable).
- **t02** Precondition watch: run the D5 poll protocol (window 1; window 2 only if 1 fails). Receipts → `evidence/polls.json`. If red after 2 windows → t03a defer note instead of t03.
- **t03** Run the gemma legs (below); receipts + load-bearing session JSONLs → `evidence/gemma/` (trim to ≤256KB/file, ≤1MB/effort).
- **t04** Adjudicate + flip the drive-ab map's gemma column (D2/D3 detector semantics, batch-aware order check); cross-link both maps (PB-16); deltas = findings rows.
- **t05** Close-out: reviewer GLM-5.3 (PB-06), PR via devops chain, `effort-audit.ts` exit 0 (PB-20), status flip + Shipped-as in the landing PR, push-all before successor (PB-03), strict-v2 successor written → validated → LATEST repointed → doctor (PB-04). Successor head = session_compact leg, then detector refinements (stay in the queue head's ranked list, PB-19).

### How the gemma legs run

Invoke `drive-case.ts` **directly from the dedicated worktree** (not `spwf-battery.sh` — it hard-codes `cd` into the memory worktree, which is sibling-occupied), with flags and prompts lifted **verbatim** from the battery's gemma stanza (frozen, PB-11), scratch wiped before C2/C3/C4 exactly as the battery does:

```bash
D=<worktree>/bun-apps/s2-agent-ext-wayfind/scripts/drive-case.ts
PIN=/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/0.10.3+gc172fd3
bun $D --case C2 --leg deployed --dist $PIN \
  --pin-provider lm-studio --pin-model google/gemma-4-12b \
  --cap 300 --out evidence/gemma/C2.json \
  --prompt "<C2_PROMPT verbatim from spwf-battery.sh>" --expect-read brainstorming
```

- **Order** (short quiet windows respected): **C2 → C3 → C5 → C8 first** (D5 core), then C4 (`--env PI_SUPERPOWERS_SKILL_EXCLUDE=!,brainstorming --extra-arg -ns --forbid-read brainstorming`), then C1 (`--expect-reply YES`, one token — cheap column completeness).
- **C5 expectation** = the re-set read-any set: `--expect-read-any using-s2-agent-skills,to-spec,to-tickets,ask-matt` (F3 ruling, D8 of the closing map) — NOT the old mis-set to-spec-only that F6 found.
- **Attribution** (PB-12): every receipt's passive model field must read `google/gemma-4-12b`; mismatch voids the leg. "Model unloaded" / empty-assistant deaths → infra SKIP, preserved, retry within budget.
- **Fog of war:** gemma `-p` latency is unknown (A/B map Context) — cap 300 may be tight; one pre-registered bump to `--cap 480` on a timeout is a harness fix, not a prompt re-roll.

**Learnings applied:** #2 (label ≠ content — re-grepped the F2 literal in the pinned bundle rather than trusting "deployed gc172fd3"), plus #1-adjacent caution in pinning gc172fd3 over newer dirs so the matrix stays single-variable.