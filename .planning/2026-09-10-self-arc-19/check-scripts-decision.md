# Check-script standardization — DECISION (self-arc-19 t05, 2026-09-10)

Closes arc-17's systemic finding ("~19/26 packages define no `check` script and
local_ci resolves gates by script NAME, so lint is silently skipped") as a
recorded adopt-or-reject per class. Input: the committed audit JSON
(`.planning/2026-09-09-self-arc-17/evidence/self-arc17-audit-result.json`,
synthesis.improvementRoom) cross-checked against TODAY's package.json scripts
(this session's enumeration; the audit predates arc-18's hermes fix — drift
recorded below). The house triple = `check` (real biome) + `typecheck` (tsc) +
`test`, the arc-18 hermes recipe (`bun-apps/s2-agent-ext-hermes-memory` is the
specimen: wayfind's biome.json copied, findings fixed properly, zero
biome-ignore).

## Classes and decisions

- **Class A — house triple already in place (6): ADOPTED, nothing to do.**
  file2md, hermes-memory, subagent, superpowers, ultracode, wayfind.
- **Class B — `check` lies (aliases tsc), so the lint row silently runs tsc
  (1): ADOPT — split into real biome `check` + `typecheck`, via the hermes
  recipe, as a queued successor maintenance arc.** Package: devops.
  Rationale: this is exactly the lying-gate class arc-18 fixed in hermes;
  devops is the most gate-critical package in the repo, so lint blindness
  there is the most expensive instance. Not fixed in THIS arc (t05 is a
  decision, not a sweep).
- **Class C1 — no `check` script at all, real src+test surface (18):
  ADOPT per package, each via its own successor maintenance arc** (biome.json
  from the wayfind specimen + house triple + fix findings properly). Packages:
  archify, btw, compact, flux2, hyperframes, knowledge-card, krea2, ltx,
  movie-director, obsidian, power-tool, prompt-history, research-tool,
  sv-analyzer, task, tool-gate, web-access, webui.
  Rationale: each adoption requires running biome for the first time and
  fixing what it finds properly — the recon list is a floor, not a ceiling
  (arc-18 lesson: the manual inventory said ~12 findings, the real run had
  more); that is a full arc of work each, not a line item.
- **Class C2 — no `check` script, NO src surface (1): REJECT the full triple.**
  Package: zai-mcp (src=0, 2 test files).
  Rationale: a biome gate over tests-only is ceremony, not a gate; record
  `typecheck: tsc --noEmit` if/when real src appears. Revisit on first src
  addition.

## Drift since the audit (arc-17 JSON, 2026-09-09)

The audit's "~19/26" was measured before arc-18: hermes-memory has since moved
to Class A, and file2md's/hyperframes' audit REDs were proven FAKE by #2237
(stale install / vendored-test sweep). Today's reality: 26 ext packages =
6 A + 1 B + 18 C1 + 1 C2.

## Vehicle

Adopted classes are queued work for successor maintenance arcs (one package
per arc, hermes arc-18 as the recipe), seeded into the next goal's ranked list
— NOT this arc's code. ZERO packages' scripts were touched by this arc
(sv-analyzer's test-file loud-skip conversion is t05's one allowed code
change, receipted here: both wasm-gated describes now announce
`[env-gated] SKIP (sv-analyzer wasm absent …)` on stderr; 11 pass / 0 fail on
2026-09-10).

| package | class | today's `check` | decision |
| --- | --- | --- | --- |
| archify | C1 | absent | adopt (queued arc) |
| btw | C1 | absent | adopt (queued arc) |
| compact | C1 | absent | adopt (queued arc) |
| devops | B | `tsc --noEmit` (lies) | adopt — split gates (queued arc) |
| file2md | A | `biome check .` | done |
| flux2 | C1 | absent | adopt (queued arc) |
| hermes-memory | A | `biome check .` | done (arc-18) |
| hyperframes | C1 | absent | adopt (queued arc) |
| knowledge-card | C1 | absent | adopt (queued arc) |
| krea2 | C1 | absent | adopt (queued arc) |
| ltx | C1 | absent | adopt (queued arc) |
| movie-director | C1 | absent | adopt (queued arc) |
| obsidian | C1 | absent | adopt (queued arc) |
| power-tool | C1 | absent | adopt (queued arc) |
| prompt-history | C1 | absent | adopt (queued arc) |
| research-tool | C1 | absent | adopt (queued arc) |
| subagent | A | `biome check .` | done |
| superpowers | A | `biome check .` | done |
| sv-analyzer | C1 | absent | adopt (queued arc); loud-skip done here |
| task | C1 | absent | adopt (queued arc) |
| tool-gate | C1 | absent | adopt (queued arc) |
| ultracode | A | `biome check .` | done |
| wayfind | A | `biome check .` | done |
| web-access | C1 | absent | adopt (queued arc) |
| webui | C1 | absent | adopt (queued arc) |
| zai-mcp | C2 | absent | reject — no src surface; revisit on first src |
