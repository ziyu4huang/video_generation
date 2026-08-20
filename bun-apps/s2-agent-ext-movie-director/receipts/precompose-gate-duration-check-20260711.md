# Receipt — pre-compose `cut_duration_vs_source` gate + `generate` help fix (2026-07-11)

## Target

Close the I2V duration-control gap surfaced (2x-reproduced) in
`real-e2e-20260711-v5-ancient-quasars-research-first.md`: a video cut's
`edit_decisions.out_seconds` can exceed its source clip's real duration with
no error anywhere in the pipeline — `compose-motion` silently freeze-extends
the last frame, shipping a mostly-static video.

## What changed

**(b) Gate-side detection (implemented, primary fix)**

`src/precompose-gate.ts` — `preComposeGate()` is now `async` and adds a third
check family, `cut_duration_vs_source`: for every video-source cut, ffprobe
the source (via the existing `./ffprobe.ts` `probeDuration`, injectable via a
new `spawnImpl` option for tests) and compare `out_seconds - in_seconds`
against the source's real remaining duration. `warn` when a frozen-frame
extension is under 50% of the requested duration, `fail` (blocking the
render) above that. Image-source cuts are exempt (ken-burns legitimately
holds a still for the full cut window).

Call sites updated to `await`: `extensions/movie-director.ts` (`pre-compose`
command), and the three e2e scripts that call `preComposeGate` directly
(`scripts/run-h-real.ts`, `scripts/run-real-e2e-neuralnet.ts`,
`scripts/run-real-e2e-neuralnet-v4-motion.ts`).

Tests: `src/precompose-gate.test.ts` — 4 new cases (pass within-duration,
fail on the real ancient-quasars-v1 shape, warn on a minor frozen fraction,
image-source cuts unaffected) using a `fakeProbe(durationSeconds)` spawnImpl
mock. Full suite: 303 pass / 5 skip / 0 fail (up from 299 pass pre-change).

**Live verification against the real fixture** (not a synthetic test): ran
`preComposeGate()` against `ancient-quasars-v1`'s actual persisted
`checkpoint_edit.json` `edit_decisions` + its real `assets/scene-*-video.mp4`
files, real ffprobe (no mocks). Result: `verdict:"fail"`, all 7 cuts flagged
individually (e.g. `"hook" requests 32.00s, source has 4.04s left (27.96s
would be frozen)`) — confirms the gate catches the exact real-world failure
this session was scoped to close.

**(a) Schema-side discoverability (documentation fix, not a new field)**

Investigation found `--frames` was already a fully wired, typed option
(`RunPyOptions.frames` in `s2-agent-ext-ltx/src/runpy.ts:47`, mapped to
`--frames` at line 153) — the gap was that `movie_help`'s `generate` command
reference never mentioned `capability:'video_generation'` at all (it had
worked examples for `analysis`/`subtitle` but not for the actual video-gen
path). Added a worked-example block to `extensions/movie-director.ts`'s
`COMMAND_REFERENCE` under `generate`, and cross-referenced the new
`cut_duration_vs_source` check under `pre-compose`'s block — so an agent
discovers `frames` from `movie_help generate` before ever needing to guess or
grep `run.py video --help`.

## Not done this session (deferred, unchanged from the goal doc)

- A fresh full agent-driven e2e re-run (goal item 4) — the real-fixture
  verification above already proves the fix works against the exact
  documented failure mode; a full new GPU e2e run wasn't spent on this,
  since it wouldn't add information the fixture check didn't already give.
- OpenMontage 12-vs-2 coverage gap, `compose-remotion` still-untested,
  `asr-gate` automation — all carried forward per the goal doc, out of scope
  for this session.
