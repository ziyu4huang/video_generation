# Receipt — compose_remotion install-vs-retire + zoompan/lanczos + agent receipts

> Goal: `output/next-goal-20260706-091500.md`. Branch
> `feat/captions-drawtext-selector-routing` (continued — see "Branch note" below).
> Supersedes the captions+selector goal (PR #305 work, uncommitted on this branch).

## Branch note (honest correction to the goal's premise)

The goal's preamble says "PR #305 MERGED, squash `c535d07`, branch off main."
Reality: `c535d07` does not exist in this repo; `main` is at `7408e40a`; the
captions+selector+compose_motion work (commits `166ac33f`/`07628d4f`/`47826f34`)
is **unmerged on this branch**, and Items B/C depend on those files
(`compose_motion.ts`, `captions.ts`). Branching off main would lose the
dependencies. So this goal's work is layered **on top of the current branch**
(`feat/captions-drawtext-selector-routing`), not off main. One PR will carry both
the prior goal's unmerged work and this goal's items.

## A. compose_remotion — INSTALL-AND-PROVE (PRIMARY)

**Decision: install.** The goal assumed the probe returned false here ("no remotion
binary; only the bun cache"). That was stale: the shipped `remotion/` project is
fully installed — `@remotion/cli` + `@remotion/renderer` + `@remotion/compositor-darwin-arm64`
(native compositor) + a `remotion` binary in `node_modules/.bin`. The only gap was
that **binary resolution never looked there** — `resolveRemotionBin`/`remotionBinaryAvailable`
probed only `REMOTION_BIN` env + PATH, falling through to the bunx "not really installed"
fallback. So compose_remotion was installed-but-unreachable: the definition of
half-configured.

### What changed
- **`remotion.ts` / `providers.ts`:** added a third resolution step — the bundled
  `<EXT_ROOT>/remotion/node_modules/.bin/remotion` (probed by existence, between
  PATH and the bunx fallback). `probeConfigured(compose:remotion)` now returns true
  on this machine, so `probedMenuSummary` advertises `remotion: true` **truthfully**
  (it really is callable). The browser headless shell is ensured via
  `remotion browser ensure` (downloaded 93.5 MB to `node_modules/.remotion/`).
- **`registry.ts`:** the compose_remotion note now documents the resolution chain
  (REMOTION_BIN → PATH → bundled install) + that it is the ONLY templated composer
  (layered section_title overlays), and that compose_motion drops `edit.overlays`.

### Templated-render receipt (the install's value-add)
`scripts/prove-remotion-overlay.ts` renders the SAME edit (two media cuts + one
`section_title` overlay) through BOTH runtimes, extracts the overlay-midpoint frame,
and measures the overlay-anchor region's mean luma vs an off-anchor control:

```
region luma (Y, 0-255):
  remotion overlay-anchor=74.1  control=49.0  delta=25.1   ← overlay painted the anchor
  motion   overlay-anchor=50.0  control=50.0  delta=0.0    ← overlay DROPPED (uniform)
PASS: section_title overlay renders under Remotion, dropped by compose_motion.
```

compose_motion consumes `edit.cuts` only — it never reads `edit.overlays`, so the
overlay is silently dropped. Remotion's `Explainer.tsx` paints it as a layer. That
layered-overlay capability (which compose_motion provably cannot produce) is the
feature that justifies the install weight. Receipt artifacts:
`output/remotion-overlay-receipt/{proof.json, remotion_overlay_frame.png, motion_overlay_frame.png}`.

The `smoke-remotion.ts` real-silicon render also passes end-to-end (1.97s render,
`final_review` 6/6 pass, h264+aac, 1280×720).

### Bug found + fixed en route
compose_motion **lacked `-loop 1` for still-image inputs** — a single PNG exhausted
after one frame, so zoompan produced a 1-frame segment regardless of `-t`. The
downstream xfade offset math then saw a near-zero duration (`atrim=duration=-0.067`)
and the join failed. With video sources it was masked. Fix: image inputs get
`-loop 1`; video inputs keep `-ss` seek-then-trim. This unblocked both this item's
A/B (PNG fixtures) and Item B.

## B. zoompan/lanczos — sharpness polish (+40%)

`scripts/probe-zoompan-lanczos.ts` empirically A/B'd four filtergraphs on a 1080p
`testsrc2` ken-burns frame, laplacian-variance (computed in JS over a raw PGM dump,
no python/cv2):

| variant | laplacian variance |
|---|---|
| old (2× bilinear pre-scale + zoompan) — the prior path | **124.4** |
| A (sws_flags=lanczos on the 2× pre-scale) | 142.8 |
| B (3× pre-scale + zoompan + final lanczos) | 149.2 |
| **C (2× pre-scale + zoompan@2× + final lanczos downscale)** | **173.7 (+40%)** |

**Variant C wins.** The final lanczos downscale AFTER zoompan is what survives —
zoompan renders at 2× (more pixels per output, less per-pixel blur), then lanczos
downsamples sharply. Lanczos downscaling rarely rings (ringing is an upscale
artifact), so the gain is genuine sharpness. This beat both the goal's speculated
paths (`sws_flags=lanczos` alone = +15%; 3× working = +20%).

### What changed (`compose_motion.ts`)
The media-cut filtergraph is now: `scale=2W×2H:flags=lanczos` → `crop=2W×2H` →
`zoompan=…:s=2W×2H` → `scale=W×H:flags=lanczos` → `fps`, with `-sws_flags
lanczos+accurate_rnd`. The final downscale runs for BOTH animated and static cuts,
which also fixes a latent resolution-mismatch: static segments previously landed at
2× target (no downscale) and would mismatch animated segments in the join.

Receipt: `output/zoompan-lanczos-receipt/{laplacian.json, *.png}` (old + 3 variants).

## C. Agent-driven receipts + F-receipt triage

### analysis→CLIP, hint-free — REAL tool surface
`scripts/prove-agent-routing.ts` drives the bridge path the agent's `movie generate`
call lands on (`selectAndGenerate`), with hint-free
`{capability:"analysis", command:"video_understand"}` and NO `provider` hint:

```
routed provider = clip  (invoke=bun:clip)   ← selector command-routing won the tie
clip adapter ran = true, model=openai/clip-vit-base-patch32, 4 artifacts
PASS: hint-free {analysis,video_understand} routed to CLIP through the real bridge
```

This is the real CLIP runtime (clipAdapter → `python/vision-venv` → `clip_understand.py`
→ real CLIP model), not the selector unit.

### compose-motion with burned captions — REAL adapter
Drove `composeMotionAdapter` with `captions:{srtPath, burn:true}`. Under
`ffmpeg-full` (the keg-only full build; stock `/opt/homebrew/bin/ffmpeg` 8.1.2 ships
WITHOUT libass/drawtext) the ladder reached **libass** (top hard-burn tier), output
produced. Run with `PATH=/opt/homebrew/opt/ffmpeg-full/bin:$PATH`.

### Gemma agent-loop variant — DEFERRED (quiet-box)
The full gemma-driven loop was NOT run: a concurrent s2-agent session in the sibling
worktree `/Users/huangziyu/proj/video_generation__pi` shared one LM Studio at triage
time — the exact contention goal risk #3 warns about (prior F-receipt ran 78 min
under it). gemma IS loaded; a quiet-box re-run is a small follow-up. The deterministic
bridge receipts above prove routing + ladder through the real tool surface — the
substantive claim — without LLM contention. See `output/agent-routing-receipt/README.md`.

### F-receipt triage — root cause, not a re-run
The prior goal's negative F-receipt (`blendBetterOverall: false`, meanRel lexical
0.395 > blend 0.250) is triaged in `output/f-receipt-triage-20260706.md`. The 5
verdicts categorize: #1 judge-presentation artifact (blend won the vote with LOWER
relevance), #2 **empty-retrieval execution bug** (blend returned a tool trace, 0
cards — a READ-side retrieval-EXECUTION failure scored as a ranking loss), #3
genuine blend win (semantic surfaced the audio card lexical missed — WRITE side is
fine), #4 **semanticLive:false coverage gap**, #5 **keyword-friendly query**
(lexical=1.0, not a semantic test).

**Root cause: the blend did NOT cleanly lose on ranking.** The negative is
contaminated by an empty-retrieval execution bug (#2), a non-live coverage gap (#4),
and a mis-designed adversarial query (#5). **Next step (not a blind re-run):** (1)
fix the #2 empty-retrieval execution bug + exclude execution failures from the mean,
(2) redesign #5 so every query carries a `lexicalMissReason`, (3) investigate the
#4 semanticLive:false gap, (4) THEN re-measure. If blend still loses on the clean
remainder, retire it.

## Fold-in — drawtext multi-line wrapping + SRT markup

- **`captions.ts`:** `stripSrtMarkup` removes `<i>`/`<b>`/`<u>`/`<font…>`/`{\an8}`/`{\…}`
  (burned as raw text by drawtext). `wrapCueText` word-wraps a cue to a per-line char
  budget (≈ 0.5 × fontsize advance, capped at 80% frame width) so long cues stack with
  `line_spacing` instead of overflowing. `CaptionsOptions` gained optional `width`/`fontsize`;
  `compose.ts` + `compose_motion.ts` thread the frame width through. drawtext's `y=h-text_h-72`
  anchors the whole multi-line block by its total height.
- 5 new tests: markup strip, word-wrap (long/short/multi-segment), drawtext wrap integration.

## Test gate

`bun test` in `bun-apps/s2-agent-ext-movie-director` → **165 pass, 1 skip
(pre-existing), 0 fail** (was 157 before this goal; +8 tests: bundled-install
resolution, image `-loop 1` vs video `-ss`, SRT markup strip, word-wrap, drawtext
wrap integration).
