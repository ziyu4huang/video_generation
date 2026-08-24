---
effort: 2026-08-24-s2-agent-simplify
created: 2026-08-24
last: 2026-08-24
status: active
---

# s2-agent simplify — dedup, dead-code removal, arg unification (user priority)

## Destination

`bun-apps/s2-agent` carries no in-package duplication that a shared leaf could kill: one settings reader, one agent-dir resolver, one transcript-discovery module, one table printer, one repo-root derivation; every flag parses through `flag-spec.ts`; dead surface (broken scripts, unparsed advertised flags, dead branches, unreferenced workflow files) is gone. Behavior identical except flagged bugfix drift (PI_CODING_AGENT_DIR honored where hardcoded before; ext-doctor surfaces manifest read failures). Same quality bar: every ticket merges through package gates + independent reviewer + local_ci.

## Context

Measured 2026-08-24 on this machine (three read-only explore agents + one plan agent over 164 files / ~16k non-test LOC; plan approved by user same day).

- **User priority (2026-08-24)**: "hands on first priority is simplified codebase of bun-apps/s2-agent — re-org code, less duplicate keep simple, yet same quality." Scope confirmed via questions: steady-full (dedup + dead code + arg unification); defineCommand help regeneration and makeMockPi cross-package dedup are follow-ups.
- **Duplication census**: settings.json reader ×4 (patches/default-model-env.ts:182, force-response-language.ts:152, subagent-model-floor.ts:70, cli/sessions/shared.ts:451 — comments cite each other); agent-dir resolution ~10 ways with env drift (memory.ts:142, memory-to-vault.ts:30, knowledge-pipeline.ts:38, ensure-model-tiers.ts:60 hardcode `~/.pi/agent` with NO PI_CODING_AGENT_DIR); transcript scan ×3 (tools-metrics.ts:396/417, agent-trends.ts:91/86 — different env var PI_SESSIONS_DIR, sessions.ts:107 — no env); ~15 flags parsed from `parsed.rest` via hand-rolled takeFlag/hasFlag/flag/num in tools-metrics/agent-trends/doctor while flag-spec.ts exists as the canonical table; printTable ×2; repo-root derivation ×5; bun-install self-heal ×2.
- **Dead surface**: package.json `verify` targets a deleted test file (broken today); sessions.ts `--cwd` advertised but never parsed; chat.ts:93 `sessionManager: … : undefined` both-branches-dead; flag-spec `blend` row zero readers (NOTE `save` row is NOT dead — s2-agent-ext-web-access/extensions/cli-subcommand.ts:87 reads `(parsed as any).save === true`); patches/index.ts:262 double `break;`; run-dir/workflows/{ltx-live-e2e,parallel-demo}.js unreferenced; ext-doctor.ts:90-100 comment/code contradiction (manifest read failure swallowed).
- **Re-org constraint census** (why mass file moves are out): registry-config.ts zero-import (equivalence test); manifest.json derived + freshness byte-compare; patch-outcome.test.ts scans patches/*.ts non-recursively; cli-intercept-order.test.ts pins "./cli/dispatch.ts" + intercept ordering; external pins on src/cli.ts, src/cli-sh.ts, src/patches/, src/static-extensions.ts, src/run-dir/{manifest.json,check-deps.ts}, sh/{host-modules,ext-loader}.ts, pre-load-providers.ts, run-dir/registry.ts (devops ci-deploy-gate + deploy libs + run.sh:155 + movie-director PI_BIN); ParsedArgs optional fields are a hidden ext API (`(parsed as any).` readers in ext cli-subcommands).
- Verified free-to-move: listSessionFiles/resolveSessionsDir/loadSessionFiles have ZERO importers outside their own files; patches/lib/ subdir would be scan-safe (shared leaf goes in src/ anyway).

## Tickets

**Execution order:** 01 → 02 → 03 → 04 → 05 → 06 (04 depends on 03; 06 depends on 02; each an independently mergeable PR)

### Phase A — shrink

- [x] 01 — Dead code & stale surface (complete 2026-08-24 branch s2-agent-simplify-t01-dead-code: all items landed; `.agents/` premise false — tracked content, kept; ltx-live-e2e.js kept — ltx TODO references it; chat help corrected to honest in-memory claim; gates 1043 pass + e2e 57 pass; receipt in ticket)
- [x] 02 — `src/paths.ts` shared leaf: resolveAgentDir + readAgentSettings + findRepoRoot (node-builtins only); rewire 3 patch readers + ~6 agent-dir sites + 5 repo-root sites (complete 2026-08-24 branch s2-agent-simplify-t02-paths-leaf: ensure-model-tiers charted-but-rejected — reader keys on $HOME only; gates 1046 pass + bundle-anchor; reviewer READY; receipt in ticket)

### Phase B — consolidate

- [x] 03 — `cli/sessions/discover.ts` (transcript discovery ×3 → 1) + `cli/format.ts` (printTable ×2 → 1, snippet clip ×2 → 1) (complete 2026-08-24 branch s2-agent-simplify-t03-discover-format: 4,730-file walk equivalence proven; printTable byte-identity re-verified by reviewer over 4,000 adversarial cases; env precedence unified PI_SESSIONS_DIR→agentDir; gates 1048 pass; reviewer READY)
- [x] 04 — Arg unification: rest-parsed flags (tools-metrics takeFlag/hasFlag, agent-trends flag/has/num, doctor rest.includes) → flag-spec rows + typed ParsedArgs (complete 2026-08-24 branch s2-agent-simplify-t04-flag-spec: 16 flags migrated, 93-flag table 0 duplicates, 20-case regression test, full ext parsed.* enumeration = zero readers of new fields; DELIBERATE change flagged: garbage numerics fail fast exit 1, was silent default; reviewer READY — audit table in ticket)
- [x] 05 — Session-tail dedup (resolveLLMFromArgs → shared.ts, runPassthrough/runAgentSession tail, printModel→modelLabel), applyVaultEnv in vault-paths.ts, run-dir bun-install self-heal + workspacePackageNames walk (complete 2026-08-24 branch s2-agent-simplify-t05-session-vault-rundir: printModel merge REJECTED with evidence — session-resolved vs args pair diverges on shorthand --model; gating not unified — opposite intents; gates 1070 pass; reviewer READY — receipt in ticket)
- [ ] 06 — Patches boilerplate: envFlag adoption ×11, patchApplied helper, footer-extension-status-notify keep/remove decision (depends 02)

## Decisions

- **D1 — Logic consolidation over file moves.** The re-org touches what code shares, not where pinned files live. Reason: the external pin census (devops ci-deploy-gate, deploy libs, run.sh, ext PI_BIN resolution, freshness byte-compares) makes mass moves high-cost/high-risk with no quality gain; duplication is in logic, not layout.
- **D2 — defineCommand help regeneration is OUT (follow-up).** Replacing ~1900 lines of hand-written `details:` help with flag-spec-generated text churns 30+ tests and e2e help-text pins. Reason: user chose steady-full; the risk/benefit is its own effort.
- **D3 — makeMockPi (19 copies across exts) is OUT (follow-up effort).** Touches 15+ ext packages' test files, each with its own canonical gates. Reason: keep this effort inside s2-agent.
- **D4 — `save` flag row stays; `blend` goes.** web-access reads `(parsed as any).save === true` (verified 2026-08-24); blend has zero readers. Reason: ParsedArgs optional fields are a hidden ext API — removal requires the `(parsed as any)` census done in 01/04.
- **D5 — Agent-dir unification honors PI_CODING_AGENT_DIR everywhere (flagged behavior delta).** memory.ts / memory-to-vault.ts / knowledge-pipeline.ts / ensure-model-tiers.ts currently hardcode `~/.pi/agent`; the canonical resolver keeps the env override. Reason: the drift is a real bug for PI_CODING_AGENT_DIR-set roots; PRs flag it.
- **D6 — Shared leaf modules are import-light by construction.** src/paths.ts uses node builtins only (patches must not gain @earendil-works imports); cli/format.ts and cli/sessions/discover.ts stay inside the cli namespace (never enters the cli-sh cjs bundle — verified before trusting import.meta.dir in 02).
- **D7 — Exit convention unified as process.exitCode=1 in commands** (die() stays for dispatch-time arg errors). Reason: dispatch.ts already honors both; one convention kills the mixed styles.

## Frontier

**Ticket 01 (dead code & stale surface)** — lowest risk, highest immediate shrink; every later ticket diffs against a cleaned baseline, so it goes first.

## Fog of war

- Whether cli/ files are truly excluded from the cli-sh cjs bundle — RESOLVED in 02: real bundle build greps 0 cli/ paths; cli-sh.ts static import closure holds.
- agent-trends.ts:86 reads env `PI_SESSIONS_DIR` — likely a typo of pi's actual `PI_CODING_SESSION_DIR` (pi config.js ENV_SESSION_DIR); pre-existing, ticket 03 must decide keep-alias vs fix while consolidating discovery.
- ensure-model-tiers env-honor charted-but-rejected in 02 (reader `getModelTierConfigPath` keys on $HOME only — writer-side honor would be a silent no-op); revisit only if core-runtime honors the agent dir.
- footer-extension-status-notify patch ("REDUNDANT BUT RETAINED") — removal needs a receipts/docs check (ticket 06); may stay with a one-line justification.
- lazy-extensions dead path (manifest.lazyExtensions always {}) — removal touches registry-config zero-import + manifest types; charted as its own follow-up effort, not ticketed here.
- chat /clear re-create and --no-session persistence semantics — smallest-honest-fix in 01 (drop dead opts); real REPL session management is unmeasured scope.

## Cross-effort links

- `Builds-on: 2026-08-21-s2-agent-rename` lineage (pi-agent → s2-agent): the pi-legacy leftovers census came from its naming decision; PI_*/BUN_PI_* env names and ~/.pi/agent state dir stay unchanged by design (cited, not re-decided).
- `Shares-decision-with: 2026-08-22-context-lifecycle` — D3 embed canonical (LM Studio bge-m3) is untouched by this effort; 02's paths leaf must not drift SEMANTIC_EMBED resolution (embedding-leaf.ts owns it).
