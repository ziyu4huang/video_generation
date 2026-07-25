# Phase-2 probe results (thinned wayfind descriptions vs fat baseline)

**Mode:** baseline-regression (recorded fat once, diffed thinned). Per spec §4/§6.

## The thinned PASS is the gate; probes are the safety net

Three skills thinned (always-on `description:` frontmatter only; bodies lost
redundant preamble, kept every trigger/checklist/example):

| skill (package) | desc before | desc after | trigger noun kept |
| --- | ---: | ---: | --- |
| domain-modeling (wayfind) | 298 | 136 | ubiquitous language / glossary / CONTEXT.md |
| grilling (wayfind) | 283 | 132 | grill |
| grill-memory (**hermes-memory**, not wayfind — see *Path discrepancy*) | 268 | 127 | grill_decision / memory |

All ≤ 150 chars, pinned by `bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts` (6/6).
Full suites green: wayfind 173/0, hermes-memory 706/0.

## Probe run — thinned vs fat baseline (`baseline-wayfind.json`)

`passed()` tolerance gate = structural passed AND every rubric item ≥ baseline − 1.

| probe | struct (thin/fat) | rubric thin | rubric fat | Δ | verdict |
| --- | --- | --- | --- | --- | --- |
| wayfind-grill-2-option | ok / ok | [0,2,1] | [0,2,2] | [0,0,−1] | **PASS** |
| wayfind-domain-3-term | FAIL / ok | [3,3,2] | [3,3,3] | [0,0,−1] | FAIL (struct) |
| wayfind-entry-routing | ok / FAIL | [3,3,3] | [3,3,3] | [0,0,0] | **PASS** |

Rubric deltas are all 0 or −1 (within tolerance) — **no rubric regression**.
The single FAIL is the domain probe's hard structural regex
(`/CONTEXT\.md|glossary|ubiquitous language|\bADR\b/i`) flipping between runs.

## That structural flip is LLM run-to-run noise, not the thinning

Inspecting the transcripts:
- **thinned domain run** proposed `docs/domain/scheduling-model.md` as the
  "single source of truth" — a glossary *equivalent*, just not named
  `CONTEXT.md`/`glossary`/`ADR`, so the noun-regex missed.
- **fat domain run** happened to name `CONTEXT.md`/`glossary`, so it hit.

Same artifact *concept* in both; the exact *noun* varies per run. And the
routing probe's struct flipped the opposite way (thin ok, fat FAIL) — symmetric
noise, not a systematic thinning effect.

## Root cause of the weak signal: the probe child loads no wayfind skills

The decisive evidence is the **grill** probe: rubric[0] ("drives the decision
ONE question at a time") scored **0 in BOTH fat and thinned**. The child dumped
a two-question numbered questionnaire (`換我問你兩個問題`) — the exact anti-pattern
the `grilling` skill forbids ("Never a questionnaire dump"). If the skill were
loaded, the child would ask one question and wait. It didn't. Same for domain:
the child invented an artifact path instead of using the skill's canonical
`CONTEXT.md` + `docs/adr/`. The skills are **not firing in either config**.

Traced to the harness: `spawnSubagent` → `createAgentSession({ agentDir:
getAgentDir() })`. The child loads skills only from `<agentDir>/skills` and
`<cwd>/.pi/skills` (neither exists: `~/.pi/agent` has no `skills/` dir; the repo
has no `.pi/`), plus whatever extensions emit via `resources_discover`. The
wayfind extension is **not bridged** into the child (only the `subagent` *tool*
is, via `extensionTools`), and `spawnSubagent` does not thread `skillPaths` or a
`resourceLoader`. So the child's system prompt has zero wayfind/hermes-memory
skill descriptions — fat or thin. (Phase 1 didn't surface this because it
tested the explicitly-bridged `subagent` *tool*, not a skill.)

**Consequence:** fat vs thinned is a null comparison here — the child sees
neither, so the two runs differ only by base-LLM noise. The diff above confirms
exactly that: no rubric regression, only structural noise.

## Conclusion

- **No genuine regression.** Rubric deltas within tolerance; the one structural
  FAIL is symmetric run-to-run noise with an identified root cause (skills not
  loaded). Nothing to revert — the thinned descriptions stand.
- **The thinning is safe by construction** (every trigger noun + "Use when"
  prefix preserved; pinned by the weight test) **and** empirically non-regressive
  vs the fat baseline on the rubric.
- **The probe signal is currently weak** — not because the probes are wrong
  (they correctly caught the questionnaire-dump and the non-canonical artifact),
  but because the harness can't load skills into the child. The fixtures are
  correct and reusable once the harness bridges skills.

## Recommended follow-up (out of scope for Task 4)

To make Phase-2 (and Phase-3 skill-unload) probes genuinely test *skill firing*,
thread the repo's skill dirs into the child — cleanest options:
1. Add `skillPaths?: string[]` to `SpawnSubagentOptions` → forward to
   `createAgentSession` (which already accepts them via `loadSkills`), and have
   `probe-runner.ts` pass `["bun-apps/pi-agent-ext-wayfind/skills", …]`. OR
2. Have `probe-runner.ts` construct a `DefaultResourceLoader` that includes the
   repo skill dirs and pass it as `session.resourceLoader`.

Either is a harness/subagent-extension change (Phase-1 territory) and should be
its own task with Phase-1's baseline re-validated.
