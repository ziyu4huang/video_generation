# Arc-26 planning task — host project-trust wiring (make #2280's latent gate real)

You are the arc planner for self-arc-26 of this repo's self-develop loop. Read the repo from the root. Produce a strict wayfinder map + tickets in `.planning/2026-09-15-self-arc-26-project-trust-wiring/plan.md`. Effort folder exists; evidence goes in `evidence/`.

## User directive

"Do it" — execute the validated successor next-goal (`output/next-goal-20260914-234500.md`, queue head): **host project-trust wiring** so the #2280 project-agent trust gate can actually deny. The design decision is ALREADY MADE and user-approved: **option (b), a subagent-scoped trust source** — read pi's trust store for the dispatch cwd ourselves and feed the existing `AgentTrustSurface`; ctx continues to supply only the UI (hasUI/confirm). Do NOT re-litigate toward option (a) (full resolveProjectTrusted at session setup) — it also gates project extensions/prompts and is charted as a separate future host-security arc.

## Verified recon (do not re-derive; you may spot-check)

- `node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.d.ts` exports a PUBLIC `ProjectTrustStore` class: `new ProjectTrustStore(agentDir)`, `get(cwd): boolean | null`, `getEntry`, `set`, `setMany`. Semantics (read from shipped `trust-manager.js`): `findNearestTrustEntry` walks from `normalizeCwd(cwd)` UP through ancestors; the FIRST `true`/`false` value wins; none → `null`. `readTrustFile`: missing file → `{}`; corrupt JSON → THROWS (wrapper must catch and degrade).
- Agent dir resolution: `getAgentDir()` from pi-coding-agent (already imported in `bun-apps/s2-agent-core-runtime/src/agent.ts:443`) — the store file is `<agentDir>/trust.json` (`~/.pi/agent/trust.json` on this machine; current content has 6 trusted paths, all under /Users/huangziyu/proj/...).
- The gate + surface exist: `bun-apps/s2-agent-ext-subagent/src/agent-trust.ts` — `AgentTrustSurface { isProjectTrusted(), hasUI, confirm }`, `trustSurfaceFromCtx(ctx)` (current default: `ctx?.isProjectTrusted?.() ?? true` = fail-open, which is WHY the gate is latent — pi's SettingsManager defaults projectTrusted=true and the host never resolves trust). Both tools accept injectable `options.agentTrust` (`subagent-tool-schema.ts` SubagentToolOptions, `subagents-tool.ts` SubagentsToolOptions).
- Unit policy tests (10, PR #2280) in `bun-apps/s2-agent-ext-subagent/tests/agent-trust.test.ts` — they must stay green.
- Arc-25 deployed finding + probe: `.planning/2026-09-14-self-arc-25-pi-upgrade-subagent/evidence/deployed-verification/README.md` scenario (c) + the bun probe showing `SettingsManager.create("/tmp/arc25-evil/repo").isProjectTrusted() === true`.

## Decision semantics to encode (verify these against the dist, then ticket them)

1. Store `get(cwd)` returns `true` → trusted, no gate.
2. Store returns `false` → untrusted → gate fires (hasUI confirm / no-UI default-DENY) — existing policy code, unchanged.
3. Store returns `null` (no entry, pi's "ask") → in a HEADLESS host this must map to UNTRUSTED for the gate (our documented timeout-default-DENY precedent; this is the secure flip that makes the arc worth shipping). In a TUI host the confirm dialog IS the ask.
4. Store unreadable/corrupt (constructor/get throws) → degrade to the old ctx default (`ctx?.isProjectTrusted?.() ?? true`), documented fail-open for availability; add a test pinning it.
5. hasUI/confirm still come from ctx (the parent owns the UI; `trustSurfaceFromCtx` already reads them).

## Known-open design details (adjudicate in the map)

- Where the store-backed surface is constructed: a small factory in `agent-trust.ts` (e.g. `createAgentTrustSurface({ agentDir, cwd, ctx })`) that both tools default to via `options.agentTrust ?? createAgentTrustSurface(...)` — keep the existing injectability (tests pin fake surfaces).
- Whether `getAgentDir()` is called at tool-execute time (fresh) or registration time — per-dispatch freshness wins if cheap (the store can change mid-session via the TUI).
- Performance: `ProjectTrustStore.get` reads+parses the JSON per call (file lock inside) — a dispatch is one call, fine; do NOT add caching this arc.
- The TUI confirm path (`hasUI` true, untrusted): confirm text should name the store fix (`~/.pi/agent/trust.json` or the host trust command) — align with the existing `trustError` text.
- NOT in scope: pi's own extension/prompt gating, SettingsManager wiring, session-setup changes (option (a) blast radius — charted only).

## Constraints

- GLM-5.3 everywhere (never flash); devops CLIs own git phases; branch `self-arc-26-project-trust-wiring` already claimed (ledger 28 entries, arc-26 active).
- Receipts: committed evidence under the effort folder; deployed verification at the END re-runs the arc-25 evil.md scenario on a FRESH pinned deploy (`/tmp/arc25-evil/repo` fixture, planted `.pi/agents/evil.md`) — the deny must fire naming `evil.md`; also a trusted-store positive control (a path listed true in `~/.pi/agent/trust.json` must NOT gate).
- Schema-cost: no tool-description changes expected; state the check.
- Biome: warnings ≠ failures; never `--unsafe`; never pipe-gate exit codes. Merge CLI gated ONLY on the programmatic CI verdict.
- Keep tickets small and independently mergeable: likely t01 (store-backed surface + tests), t02 (deployed verification + receipts), t03 (close-out).

## Deliverable

`plan.md`: wayfinder map (status, goal, scope-in/out with reasons, tickets with file surfaces + tests + verification clauses, decisions, fog-of-war, successor sketch).
