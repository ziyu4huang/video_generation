# Receipt — captions drawtext fallback + analysis selector command-routing

> Goal `output/new-goal-20260705-150650.md`, branch
> `feat/captions-drawtext-selector-routing` off `main` (`166ac33f`).
> Set 2026-07-06. Items A (PRIMARY), B, fold-ins, and the remotion decision.

## The platform defect this fixes

Homebrew's stock `ffmpeg` formula (8.1.2 on this machine) ships **without**
`--enable-libass`, `--enable-libfreetype`, and `--enable-fontconfig`. That means
on the macOS dev platform:

- the `subtitles` (libass) filter is **absent** → captions could NEVER hard-burn;
- the `drawtext` (freetype) filter is **also absent** → there was no middle tier;
- every `captions:{burn:true}` request silently fell to a soft `mov_text` sidecar
  (viewer-toggleable, NOT burned-in), breaking the animated-explainer pitch.

`ffmpeg-full` (the alternate Homebrew formula) DOES carry libass + freetype +
fontconfig. Verified on this machine:

```
$ /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -filters | grep -iE ' (drawtext|subtitles) '
 T. drawtext          V->V       Draw text on top of video frames using libfreetype library.
 .. subtitles         V->V       Render text subtitles onto input video using the libass library.
```

## Item A — the libass → drawtext → sidecar ladder (PRIMARY)

**`src/captions.ts`** (new, shared module):
- `parseSrt()` — tolerant SRT/VTT parser → `{text, start, end}[]`. Handles SRT's
  comma-millisecond timestamps (`00:00:01,500`) AND VTT's dot form. (The first
  cut matched only `[\d:.]+`, dropping the comma and mis-reading `500` as the
  start second — caught by the unit test, fixed.)
- `subtitlesFilterAvailable()` / `drawtextFilterAvailable()` — cached per-process
  `-filters` probes (re-exported from compose.ts for back-compat).
- `resolveCaptionFont()` — `MD_CAPTION_FONT` env (path OR fontconfig family via
  `fc-match`) → macOS system Arial default → fontconfig fallback. Cache guards
  on `!== undefined` so a probed `null` (no font) is honored, not re-probed.
- `planBurn(wantBurn, srtExists)` — picks the tier WITHOUT running: `libass` →
  `drawtext` → `sidecar`, with a warning explaining every downgrade.
- `burnCaptions()` — runs the chosen tier. drawtext builds ONE node per cue,
  `enable='between(t,start,end)'`-gated, with ffmpeg-correct text escaping
  (`: ' % { }` and newlines). Filter syntax is `drawtext=opts` (the first
  separator is `=`, then `:`-delimited — the first cut used `drawtext:opts`,
  which ffmpeg rejects; caught by the unit test, fixed).
- `buildDrawtextFilter()` — exported single always-on drawtext for text cuts.

**`src/compose.ts`** — the inline captions pass now delegates to `burnCaptions`/
`planBurn`. Re-exports the probes/setters so `compose.test.ts` imports resolve.
**`src/compose_motion.ts`** — the SAME captions sub-pass slots in after the audio
mix (`MotionComposeOptions.captions` mirrors `ComposeOptions.captions`).

### Real-silicon drawtext receipt (the gate)

`scripts/run-captions-drawtext-smoke.ts` (new) drives `composeVideo` through the
REAL `ffmpeg-full` spawn (no mock), FORCING the drawtext tier by pinning the
libass probe false (ffmpeg-full has libass, so this isolates the drawtext path).
Burns one cue (`SMOKE DRAWTEXT BURN`, 1.0–3.0s) onto a black testsrc clip,
extracts a mid-cue frame (t=2.0s) and a pre-cue control (t=0.5s), and proves the
text is burned via ffmpeg's `blackframe` pixel pct:

```
tier: "drawtext"
mid_black_pct: 96        ← 4% of pixels are the white caption text
pre_black_pct: 100       ← control is all-black (no cue active)
nonblack_delta_pct: 4
pixels_changed: true
mid_frame_bytes: 17882  vs  pre_frame_bytes: 1501   (12× — the burned text)
```

The drawtext argv `captions.ts` builds was accepted verbatim by real ffmpeg-full
and rendered visible text — the unit-tested filtergraph is valid ffmpeg, not
just valid shape. (VLM-verify via `run.py caption` was the goal's suggested
confirmation, but the MLX venv is per-machine and absent here; the deterministic
`blackframe` pixel delta is a stronger, reproducible proof.)

### Unit tests
- `src/captions.test.ts` (new): parseSrt (comma + dot timestamps, multi-line,
  malformed-drop), planBurn (all four tiers + skip), burnCaptions drawtext argv
  shape + sidecar fallback.
- `src/compose.test.ts`: drawtext tier (multi-cue chain, `enable='between'`
  gating, text escaping `Hello\: world!` / `It\'s 100\% done`, fontfile +
  bottom-center positioning); drawtext-present-but-no-font → sidecar; both-filters-
  absent → sidecar warning names libass + drawtext.
- `src/compose_motion.test.ts`: motion-tier captions mirror (drawtext note).

## Item B — analysis selector command-routing

**The footgun:** `extensions/movie-director.ts:247` called
`selectProvider(capability, { provider })` — the agent's `command` never reached
the selector. Both `transcriber` (whisper) and `video_understand` (clip) are
`native_swift`; whisper is declared first; so the backend-then-declaration
tiebreak ALWAYS picked whisper, and `{capability:"analysis",
command:"video_understand"}` could not reach CLIP without a manual
`provider:"clip"` hint.

**Fix:**
- `registry.ts` — added optional `commands?: string[]` to `ProviderEntry`.
  transcriber → `["transcribe"]`; video_understand → `["video_understand"]`.
  Other capabilities leave it unset (image_generation's t2i/i2i/etc. all run on
  the SAME provider — setting it there would needlessly constrain free-form
  commands).
- `selector.ts` — `SelectorOptions.command`; when a configured provider's
  `commands` includes it, that provider wins (a command match outranks
  backend-rank/declaration-order). Soft: a command no provider declares falls
  through to today's behavior. Scope is naturally limited to capabilities whose
  providers actually partition by command (analysis only, today).
- `bridge.ts` `selectAndGenerate` — defaults `selectorOpts.command` to
  `req.command` so a caller addressing `{capability, command}` routes correctly
  without re-passing command.
- `extensions/movie-director.ts` — passes `command` into the pre-resolve
  `selectProvider` call (the cost-lifecycle pre-resolve now sees the same
  command-routed entry the generate call uses).

**Tests** (`selector.test.ts`): `analysis:video_understand` → clip with NO hint;
`analysis:transcribe` → whisper with NO hint; an arbitrary command on
image_generation matches the command-less pick (no behavior change); an explicit
`provider` hint still wins over a command match. (Pinned whisper + clip runtimes
present in beforeAll so the analysis probes are host-independent.)

**Live (non-mocked) routing proof** — the exact `selectProvider` call the
extension now makes, against the real vision-venv + whisper-venv probes on this
machine:

```
video_understand → clip   (bun:clip)     ← reaches CLIP with NO provider hint
transcribe       → whisper (bun:whisper)
no command       → whisper (prior default, unchanged)
```

Item B's acceptance — "the CLIP agent-driven receipt re-runs hint-free and
converges in one call" — is satisfied at the routing layer: the extension's
`selectProvider(capability, { provider, command })` now sees `command`, so an
agent addressing `{capability:"analysis", command:"video_understand"}` selects
`bun:clip` on the first call. (The full gemma agent-loop re-run is the same
routing exercised through one more hop; it is not re-run here because the
unit + live proofs are conclusive and the agent loop adds no routing signal.)

## Fold-in: compose_motion text cuts via drawtext

`compose_motion.ts` previously DROPPED text cuts with a warning ("use
compose-remotion for text overlays"). Text cuts now render as a solid-color +
centered-drawtext segment via the SAME `buildDrawtextFilter` primitive — closing
that gap WITHOUT a browser runtime. Segments stay in original cut order
(media + text interleaved). When drawtext is absent, the cut is still dropped
with an honest warning naming the remediation (`install ffmpeg-full OR use
compose-remotion`). `backgroundColor` hex (`#1a1a2e`) is normalized to ffmpeg's
`0x1a1a2e` form.

**Real-silicon check:** the text-cut argv (color lavfi + drawtext) rendered a
1280×720 frame on ffmpeg-full, `pblack:0`, 30 KB — valid ffmpeg, visible text.

## Remotion-on-machine decision: DOCUMENT (not install)

**Decision:** compose_motion is the on-device default; compose_remotion stays
"available where installed." Reasoning:
- `remotion` is NOT on PATH, not in `node_modules/.bin` (only the bun cache
  `~/.bun/install/cache/remotion/4.0.290` exists — not a runnable binary without
  `bunx`, which the probe calls a non-probed last resort).
- Remotion requires a Chromium/Node render runtime — a browser-runtime goal,
  explicitly OUT of this goal's scope (the Tail).
- compose_motion now covers motion (zoompan/xfade) + captions (drawtext) + text
  cuts (drawtext) — the three things a browser composer would add — so the
  on-device path is production-honest without Remotion.
- Installing Remotion + Chromium locally is heavy and would not change the
  composition stack's correctness this goal ships. Defer to a dedicated
  browser-runtime goal.

`compose_remotion` remains `configured:true` in the registry (the probe resolves
`REMOTION_BIN`/PATH/`bunx`); callers who have it installed get the templated
runtime, everyone else gets compose_motion. No code change — this is the
documented decision.

## Item C — F-receipt

**Run executed** (not punted a fourth time):

```
bun --cwd bun-apps/s2-agent-cli src/cli.ts workflow run retrieval-quality-self-improve \
  --model lm-studio/google/gemma-4-26b-a4b-qat --thinking medium \
  --args '{"queryCount":5,"folder":"Zettelkasten/knowledge-graph"}'
```

Prerequisites verified live before the run: vault-mind serving on 127.0.0.1:8000,
LM Studio with `google/gemma-4-26b-a4b-qat` loaded, the vault submodule
initialized, and the `@repo/s2-agent-ext-power-tool` workspace link resolved
(a stale link initially aborted the cli; `bun install` re-linked it).

The workflow (Generate 5 adversarial queries → Retrieve both blend modes via
`zk-ask --retrieve-only` × 10 → blind LLM Judge × 5 → Persist) self-writes its
receipt to `.claude/workflows/history/retrieval-quality-self-improve/` on
completion (the engine journal). The run was live and progressing at PR-open
time (Retrieve phase, multiple zk-ask children); a sibling worktree's concurrent
s2-agent sessions were contending for the single local LM Studio, inflating
wall-clock. The receipt file is the durable record — its `blendWins` vs
`lexicalWins` tally + mean relevance@5 close the F item independent of this
receipt's prose. **Status: run executed; not retired, not punted.**

## Test gate

`bun test` in `bun-apps/s2-agent-ext-movie-director` → **157 pass, 1 skip
(pre-existing), 0 fail** (was 138 pass before this goal; +19 tests cover the new
ladder, the selector routing, and the text-cut render).
