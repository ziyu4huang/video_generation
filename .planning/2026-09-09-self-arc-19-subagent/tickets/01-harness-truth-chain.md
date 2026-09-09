# t01 — harness truth-chain: wrap-tolerant liveModelSlot, launcher provenance, boot gate, UI vocab table

Status: open
Files: `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts`, one new test file in
`bun-apps/s2-agent-ext-subagent/tests/` (e.g. `tui-drive-vocab.test.ts`)
Schema-cost: +0 by construction (dev script + test only; no shipped-runtime change —
map D1). Say so in the PR body.

## Goal

Make the TUI-drive harness unable to produce a false-FAIL or an unattributable PASS:
fix the wrapped-call-row false-FAIL, stamp every receipt with launcher provenance, gate
all scenario submits on rendered truth, and centralize the UI vocabulary into one
exported table pinned by a unit test.

## Verified facts (planner, 2026-09-09)

- False-FAIL: `scripts/tui-drive.ts:378-382` requires `spawn_subagent` AND `glm-5.3`
  on ONE physical line. Deployed proof: `output/self-arc14-deployed-dispatch-20260908/snap-10-running.txt`
  line 24 ends `▸ glm-5.3 ▸`, line 25 is bare `spawn_subagent` (COLS=100 wrap); that
  run's receipt.json never latched `liveModelSlot`.
- `Receipt` interface at `tui-drive.ts:316-327` has no launcher/sh/version/sha fields.
- Boot gate exists only in cc-parity (`tui-drive.ts:691-713`) + reload; bare
  `waitIdle(2500,45000)` submits at `tui-drive.ts:339,438,487,640,697,810,895` (+ last
  scenario) — 8 scenarios.
- Live-marker regex duplicated 4× (`:368,456,1146,1201`); vocab literals at
  `:502,526,603,656,572,860,870,959,835,923,979,1020,1091`.

## Work items

1. **Guard the main entry**: wrap the script's run path in `if (import.meta.main)` so
   the new exports are importable from tests without side effects (map D1).
2. **Wrap-tolerant liveModelSlot** (map D2): in the in-loop latch, when a line carries
   `spawn_subagent`, test the model segment against the joined pairs
   `lines[i-1]+lines[i]` and `lines[i]+lines[i+1]` (guard i bounds), preserving the
   flash-exclusion (`!/flash/`) and `sawTaskLine` semantics. COLS stays 100 — do NOT
   widen the terminal to dodge the wrap.
3. **Launcher provenance** (map D3): extend `Receipt` with
   `launcher: { sh?: string; shRealpath?: string; deployedVersion?: string | null; gitSha: string; tree: "source" | "deployed" }`.
   Populate: realpath via `fs.realpathSync` on the `--sh` value (absent ⇒ source tree),
   `gitSha` via `git rev-parse HEAD` in cwd at drive start, `deployedVersion`
   best-effort (`<sh> --version` capture; else parse the dist version-dir label from
   the realpath; else `null` — never fail the drive on it).
4. **Exported boot gate** (map D4): `awaitBootRendered(timeoutMs)` generalizing the
   cc-parity precedent — poll until the screen is non-empty and past boot flash, THEN
   the existing `waitIdle`. Call it before submit in ALL scenarios currently on bare
   `waitIdle` (the 8 sites above). Additive only; keep per-scenario settle logic.
5. **Exported UI vocab table** (map D5-adjacent): one `UI_VOCAB` object with the regex
   sources now scattered: `liveMarker` (Working…/esc to interrupt/spinner class),
   `runningRow` (`⌛ running`), `bgRow` (`bg\s{2,}●`), `abortConfirm`
   (`Abort this subagent\? y/N`), `pausedGlyph` (`‖`), `liveGlyph` (`◆`),
   `agentsDialogHeader` (`Agent types`), `deleteConfirm` (`y confirm delete`), batch
   header. Replace EVERY inline literal with a table reference (the 13+ sites above);
   no behavioral regex changes — same patterns, one home.
6. **Pinning unit test**: (a) each table regex matches a recorded real sample line
   (lift one from the arc-14 receipt snaps or reproduce the literal shapes); (b)
   readFileSync `scripts/tui-drive.ts` and assert each vocabulary pattern string
   appears exactly ONCE (the table) — a grep guard against re-scattering; (c)
   wrap-join helper unit test: given the snap-10 two-line shape, the model check
   latches; given `glm-5.3-flash` in the pair, it does not.

## Acceptance

- `bun run --cwd bun-apps/s2-agent-ext-subagent check && bun run --cwd bun-apps/s2-agent-ext-subagent typecheck && bun run --cwd bun-apps/s2-agent-ext-subagent test` green
  (use the package's canonical gate set — check the scripts before running).
- No vocabulary literal remains outside the table (test b enforces).
- `--self-dry` or a short local drive (if the script supports one) shows the receipt
  JSON now carries the `launcher` block.

## Out of scope

Any src/ change, any COLS change, send_message, depth cap (t02/t03). Do not delete or
edit existing receipts under `output/` — they are the evidence trail.
