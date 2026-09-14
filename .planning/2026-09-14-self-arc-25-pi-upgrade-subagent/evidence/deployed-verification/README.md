# t06 — deployed verification receipts (self-arc-25)

Date: 2026-09-14 · Driver: hands-on loop · Model policy: GLM-5.3 on every leg (D9); flash excluded BY NAME — no leg requested or resolved flash (durable run records stamp `model: zai/glm-5.3` on all three inspected child runs: `~/.pi/subagents/runs/mu1en7sb-r6hfc0.json`, `mu1emo5y-5esuuh.json`, `mu1ekheq-kaqtd8.json`).

## Deployed truth (PB-08)

- Deploy: `bun run deploy --no-freeze --force` from `bun-apps/s2-agent` at `9eb78efe` (post-t05 main) → PINNED dir `~/proj/dist/s2-agent-sh/darwin-arm64/0.10.3+g9eb78ef/` (never `current`).
- Deploy e2e verdict: `pass (boot:pass ext-load:pass cwd-independence:pass parity:pass tools-probe:pass providers-catalog:pass model-call:pass vision-call:pass file2md-ocr:pass tool-gate-fire:skip standalone-import:pass)`.
- pi-version chain of custody: dir label `+g9eb78ef` names the source commit whose `bun-apps/bun.lock` pins `@earendil-works/pi-* 0.85.1` (landed in #2277; chord in, pi-client/pi-protocol out). The bundle carries no grep-able pi version string (minified); the BEHAVIORAL 0.85 proof is scenario (a).

## Pre-drive bundle greps (PB-09) — on `ext/subagent/ext.cjs` + `s2-agent.js`

| Target | Expected | Result |
|---|---|---|
| t02 cap marker (template-literal pieces: `output capped at` / `bytes for the parent context` / `full output preserved in tool details and list_subagent_runs`) | present | ✅ 1/1/1 hits |
| t04 confirm title `Run project-local agents?` | present | ✅ 2 hits |
| t04 deny `is not approved for this project` | present | ✅ 1 hit |
| t04 `fileName` field | present | ✅ 5 hits |
| t05 `accrueUsage` symbol | present | ✅ ext.cjs + s2-agent.js |

## Scenarios (isolated work env: scratch git repo under `output/arc25-verify/repo`, gitignored; evil fixture at `/tmp/arc25-evil/repo`)

**(a) ctx.cwd delegation (t03) — PASS.** `scenario-a.log`: parent driven at the scratch repo; child dispatched with `cwd = <repo>/child-a`; child `pwd` reported the child dir and relative `note.txt` read resolved `FROM_CHILD_A`. Behavioral proof that the deployed tree runs pi ≥0.85 cwd semantics (and that removing the re-bind was safe).

**(b) child-output cap (t02) — PASS.** `scenario-b.log`: child produced 9000×"hello" (54,000 B); parent-visible result carried `[output capped at 51200 bytes for the parent context — full output preserved in tool details and list_subagent_runs]`; the driving model itself computed the truncation point (≈8,533 lines).

**(c) project-agent trust gate (t04) — GATE LATENT: recorded gap (PB-15; never a pass).**
- First attempt (`scenario-c.log`) ran from the scratch repo INSIDE the trusted ancestor `~/proj/video_generation__subagent` → gate correctly did not fire (fixture error).
- Re-run from a genuinely untrusted `/tmp/arc25-evil/repo` (`scenario-c2.log`): `agentType: "evil"` STILL RAN — the deny did not fire.
- Root cause (probed, not guessed): pi's library-level `SettingsManager.create(<untrusted cwd>).isProjectTrusted()` returns **TRUE** (bun probe: `isProjectTrusted: true`, `defaultProjectTrust: "ask"`); `projectTrusted` defaults true (`options.projectTrusted ?? true` in the shipped dist) and the s2-agent host never invokes pi's `resolveProjectTrusted()` flow (that is the pi CLI's interactive path, `dist/core/project-trust.js`). So `ctx.isProjectTrusted()` never reports false and the gate — whose policy IS unit-proven (10 tests, PR #2280) — can never bite in this host.
- Blast-radius note: wiring `resolveProjectTrusted()` into the host would also flip pi's project extension/prompt/skill loading (`projectTrusted && addResources("extensions"…)`), i.e. it gates far more than subagents and would change behavior on every machine not in `~/.pi/agent/trust.json`. That is a host-security design decision — **charted as the successor-arc head**, not improvised at arc tail (PB-14).

**(d) model proof — PASS.** See header: parent legs launched `--model zai/glm-5.3`; child run records stamp actual `zai/glm-5.3`; flash excluded by name.

## Discipline notes

- One retry consumed on scenario (b) (auth-key extraction typo in the driver, not the product); scenario (c) consumed its 2 runs (fixture error → genuine gap) — recorded, not thrashed (PB-13/PB-14).
- CI flake note (honesty log): PR #2280's local run of the deploy-e2e gate failed on `cross-target deploy (win32-x64)` under concurrent load; the identical gate passed on immediate re-run (`PI_AGENT_E2E=1 bun test tests/deploy-e2e.test.ts` → 7 pass / 0 fail) on the merged tree. The merge CLI had already merged on its own fresh green CI before the local result was read — chain ordering lesson recorded in the map corrections.
