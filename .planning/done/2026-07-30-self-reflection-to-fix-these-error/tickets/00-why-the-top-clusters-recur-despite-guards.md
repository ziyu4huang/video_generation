## Question

Why do the two top-recurrence failure-memory clusters keep recurring **despite** the guards/lessons already in place? Diagnose the precise gap for each, so the task tickets (01, 02) target a real root cause rather than a symptom.

Two sub-questions:

**(A) Test-hermeticity (local-pass / CI-fail).** The repo already has the portability audit (`scripts/test-portability-audit.sh`, P5 class added PR #945) + multiple stored conventions. Yet ~8 instances recurred (watchdog #937, hermes #938, config.test, tool-gate, …). Pin the gap:
- Does P5 catch **env-var leakage** (e.g. `PI_HERMES_CONSOLIDATING`, `TOOL_GATE_LOG_PATH`) or only config-loader / homedir reads?
- Does P5 catch **homedir / `~/.pi/*` reads**?
- Is the audit run **pre-push locally**, or only in CI (so authors don't see failures until CI)?
- What's the single highest-leverage gap letting new non-hermetic tests land?

**(B) Failure-store noise (near-duplication / re-bloat).** The `pi-memory-bulk-dedup` skill exists + the harness auto-offloads near the 40k-char limit. Yet near-dups keep accumulating (SurrealDB-subquery ×3, mupdf API ×3, …) and the store re-bloated 69%→98% in one session. Pin the gap:
- Is there **any automated near-dup detection** at write time, or is dedup purely manual (ad-hoc skill runs)?
- Do concurrent live sessions (4 now) write without coordination, amplifying dups?
- What's the actual current near-dup rate + the store's growth velocity?

**Output**: for each cluster, one root-cause statement + the candidate structural-fix shapes (which graduate into 01/02's scope). This is a **research** ticket — read the audit script, the dedup skill, the failure store; do not implement.

**claimed:** charting-session (2026-07-30) — ✅ CLOSED

## Resolution — root causes pinned for both clusters

### (A) Test-hermeticity recurrence — the audit has 3 holes

Read `scripts/test-portability-audit.sh` (P1–P5) against the ~8 failure instances:

1. **P3 only matches `*_API_KEY`/`*_TOKEN`** — harness-injected **config-mutating** env vars (`PI_HERMES_CONSOLIDATING`, `TOOL_GATE_LOG_PATH`) that silently change `loadConfig` defaults are **entirely undetected**. This is the exact #938 class (hermes `config.test.ts`). And P3/P4 are REVIEW-ONLY (never block under `--strict`).
2. **P5 deliberately excludes `loadConfig(` and `os.homedir(`** (script comment: "collides with local test helpers… benign path-construction"). Tests reading real `~/.pi` via those helpers slip through.
3. **The audit is CI-only** (`regression gates` job). No local pre-push gate → authors don't see failures until CI; the feedback lag is why the stored conventions keep getting ignored.

**Highest-leverage gap**: the config-mutating-env-var class (#938) has *zero* mechanical detection, and there's no fast local pre-flight.

**Candidate fix shapes for ticket 01** (pick/combine at resolution):
- (i) **New P6 class**: harness-injected config-mutating env-var reads — review-only first (like P3), flip to `--strict` once false-positive ≈ 0.
- (ii) **Local pre-push enforcement**: wire `bash scripts/test-portability-audit.sh --strict` into a pre-push hook / the push convention so authors hit it before CI.
- (iii) Both — recommended (detection + feedback-speed).

### (B) Failure-store noise — no write-time gate + near-dups never auto-removed

Read `pi-memory-bulk-dedup/SKILL.md` + measured the store (52 entries / 40,303 chars — essentially at the 40k limit):

1. **No write-time near-dup detection.** `memory add`/replace writes without checking for an existing near-identical entry in the target.
2. **`dedup.sh` HARD-DELETE only removes exact duplicates**; near-dups are REPORT-ONLY ("may encode real lessons", eyeball-only). So near-dups **accumulate** between manual passes.
3. **4 concurrent live sessions amplify** (each can log a near-dup of the same event). Worst cluster: **mupdf ×5** (PDF research effort). Plus SurrealDB ×2, ask_user_question-header ×2, web_search ×2.

**Candidate fix shapes for ticket 02** (pick at resolution):
- (i) **Write-time near-dup gate**: wrap the `memory` add path with a same-target similarity search before write; warn/merge/block on near-dup. Highest-leverage (stops accumulation at source). Feasibility: needs a hermes extension hook — check the write seam.
- (ii) **Automated near-dup compaction**: extend `dedup.sh` to auto-merge high-similarity clusters (beyond exact dups) as a periodic/CI step.
- (iii) **Check-before-write convention** enforced by a guard (agent must `memory_search` before `memory add`).
- Recommended: (i) if the hermes hook is feasible; else (ii).

Both task tickets now have concrete, root-caused scopes (not symptoms). The fog (exact fix shape) is graduated into 01/02.

**type:** research
