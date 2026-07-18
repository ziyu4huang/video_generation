---
type: grilling
status: closed
blocked by: 04
resolved: 2026-07-19 (by implementation)
---

# 05 — Verification criteria / probe (the spec's proof)

## Question

**What is the canonical proof that "the portable binary can run a workflow-pack",
and how is it reproduced?** The destination is a spec handed off; the spec must
define the verification the build session executes — otherwise "ensure it can
run" has no acceptance bar.

## Context (facts this decision stands on)

- **Probe prototype (2026-07-19).** The build probe already demonstrated the
  canonical proof shape end-to-end: compiled `dist/pi-agent-cli/pi-agent-cli`,
  invoked from a foreign cwd (`mktemp -d /tmp/pi-probe.*`, verified no repo
  ancestry) against the `echo` pack by **absolute path**, real run (no
  `--model` → pi-default) → `agents=1 1232ms … exit 0`, run-log persisted.
  So the *mechanism* is proven; this ticket mainly locks the **assertions**, the
  **representative pack**, and **where the test lives**.
- Ticket 04 fixes the pack-discovery model; the probe must exercise the chosen
  tier(s), not just the always-available absolute-path branch.
- Ticket 03 confirmed there is **no** existing compiled-binary / foreign-cwd
  coverage — this probe is greenfield. The transparent-passthrough mock pattern
  is reusable for capturing CLI forwarding, but the proof itself must run the
  **real compiled binary**.
- Standing pref: verify by **actually running**; test portable artifacts from a
  **foreign cwd** (a temp dir with NO repo ancestry, so `findRepoRoot` genuinely
  returns undefined — cwd == artifact masks the bug).

## To decide (grill one at a time)

- **Representative pack.** Which pack proves "general runner"? Candidates: the
  shipped `echo` / `args-demo` / `sample` (simplest), or a small synthetic pack
  that exercises `agent()` + `args` + manifest defaults (richer). Decide the
  minimal pack that proves the mechanism end-to-end.
- **Foreign-cwd setup.** A throwaway temp dir with no `.pi/workflows` and no
  `bun-apps` ancestor; invoke the compiled exe from there; assert exit 0 and the
  expected pack output. Decide the exact assertions + whether `--dry-run` (no
  LLM) suffices for the automated gate vs a real `agent()` run for the manual
  sign-off.
- **Where the probe lives.** A new test file under `bun-apps/pi-agent-cli/tests/`
  gated behind a compiled-artifact presence check (the repo's existing pattern
  for `--release`/`--portable`/bundle e2e tests), or a standalone script under
  `scripts/`. Decide so the handoff knows what to build.
- **Model config.** Confirm model resolution works portably (the
  Not-yet-specified fog). The probe likely runs `--dry-run` or a local
  (lm-studio) model to avoid network dependency — decide the model story for the
  proof.

## Resolution — Resolved by implementation (2026-07-19)

The verification probe is codified as
`bun-apps/pi-agent-cli/tests/workflow-portable-e2e.test.ts` (commit `eb9a4fc2`,
+ final-fix `eecea4c2`). It runs the COMPILED `dist/pi-agent-cli/pi-agent-cli` from
a **foreign** `mkdtemp` cwd (verified repo-less — `findRepoRoot` returns
undefined from `/tmp`), and asserts:

- **(a) name-resolution** via the new `<cwd>/workflows` tier: drops a synthetic
  `echo` pack in the foreign cwd, runs `workflow run echo` BY NAME → asserts
  exit 0, receipt contains `source: cwd-workflows`, stderr empty.
- **(b) absolute-path baseline**: runs the pack dir by absolute path → asserts
  exit 0, `source: path`, stderr empty.

2/2 pass (gated `describe.skipIf(!existsSync(EXE))`). The automated gate uses
`--dry-run` (no LLM); the 2026-07-19 build probe already did the real `agent()`
run (agents=1, exit 0). Representative pack = a synthetic `echo` pack.

**The map's destination is MET:** a portable single-exec binary runs a
user-supplied workflow-pack by name from a repo-less cwd, verified end-to-end.

## How to resolve

Grill the user on representative-pack + assertion bar first, then probe
location. Record the locked verification recipe as a `## Resolution` (concrete
enough that the build session can execute it verbatim). If the probe surfaces a
real model-config gap, graduate that fog into its own ticket.
