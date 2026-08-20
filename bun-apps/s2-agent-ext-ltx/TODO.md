# s2-agent-ext-ltx — TODO

Open work for this extension, roughly in priority order. See `README.md` for
the current command surface and `../../swift/ltx-video-director/PLAN.md` /
`docs/TODO.md` for the underlying Swift CLI's own roadmap (this package only
wraps that CLI — it doesn't own the generation logic).

## 1. `native-upscale`'s hd-mode result parsing is incomplete — DONE

`src/result.ts`'s `buildNativeUpscaleDetails` now also parses
`firstMatchLine(stdout, /\[restoration\]\s*\d+ frames:\s*(\S+)/)` into
`extraOutputs.restoredFrames`, alongside the existing `frames`/`mp4` keys.
Covered by a new hd-mode stdout fixture in `src/result.test.ts`.

## 2. `binary.ts`'s metallib build failure is silently swallowed — DONE

`buildMetallib` still treats a failed `setup-metallib.sh` run as best-effort
(no rejection — the right call, see `project_ltx_swift_native_port` memory),
but now checks whether `mlx.metallib` actually exists after the subprocess
resolves; if not, it forwards a clear `onProgress` warning (not a hard
failure) instead of leaving the agent to discover the real cause only when
the first MLX call crashes downstream.

## 3. `hd` mode is unverified against a real checkpoint — RESOLVED upstream

Resolved by PR #252: a real, non-gated restoration+upscale LoRA pair
(`joyfox/LTX2.3-ICEdit-Insight` on HuggingFace, Apache-2.0) was found,
downloaded, and externalized under `mlx-models/lora/ltx-2.3-restore/` —
same convention every other LoRA in this repo follows. `native-upscale
--mode hd` was run end-to-end through the raw Swift binary (109.2s wall,
visually confirmed correct: same scene, genuinely higher resolution).
`commands.ts`'s `mode` field description updated to drop the stale
"UNVERIFIED"/"gitignored, user-downloaded" language.

## 4. No test coverage for the hd-mode CLI fields on this side — DONE

`src/commands.test.ts` now covers `mp4: true`/`false` on both `native-i2v`
and `native-upscale` (inverted-flag path), and asserts
`restorationLora`/`upscaleLora` are in `pathFieldKeys(COMMANDS["native-upscale"])`
(i.e. validated by `validateOptionPaths` before ever reaching the binary).

## 5. `build:bundle` has never been run+verified for this package — DONE

Ran `bun run build:bundle` → produced
`dist/pi-extensions/s2-agent-ext-ltx.bundle.js` (6.44 MB) cleanly. Verified
end-to-end with `LTX_VIDEO_REPO_ROOT=<repo root> bun-apps/s2-agent/run.sh -e
dist/pi-extensions/s2-agent-ext-ltx.bundle.js -p "list installed LTX-2.3
transformer variants"` — a real `ltx models` call through the bundle
(not source mode), which correctly resolved `LTX_VIDEO_REPO_ROOT` and
listed all 3 installed transformer variants (`dev`/`distilled`/`dasiwa`).

## 6. `models` command has no structured output

`buildTextDetails` (the fallback for `models` and anything unrecognized)
just carries raw stdout — an agent asking "which transformer variants are
installed" gets a text blob to parse itself instead of a `string[]`. Low
priority (the raw text is small and stable), but if `models` output ever
needs to be *consumed* programmatically (e.g. an extension that validates a
`--transformer` value before calling `native-i2v`), this is the place to add
a dedicated `buildModelsDetails` parser.

## 7. `options` param serialized as a JSON string killed every tool call — DONE

Found via a real A/B upscale-verification run driven through the actual
`ltx` s2-agent tool (not `bun test`): `native-i2v` silently dropped
`--prompt` and `gate` rejected its `videos` array, both with confusing
errors. Root cause: `options` is declared `Type.Any()`, and the model/
provider pair in play serializes it as a JSON **string** rather than a
nested object — `key in options` then throws "options is not an Object" on
a string, discarding the whole call. `s2-agent-ext-flux2` had already hit
and fixed the identical issue (`coerceOptions()`); ported that fix verbatim
to `extensions/ltx.ts` + 3 regression tests in `pi-ltx.test.ts`. Reran the
exact same 3 tool calls afterward through the real `ltx` tool (no bypass) —
all succeeded. 96/96 tests pass.

## 8. `gate --json` misreported a valid file as "could not read/probe video" — DONE (swift-side, tracked here since it was found through this package's own tool)

Same A/B run: `gate` on `native-upscale`'s own mp4 output (video-only, no
`--refine-audio` given) returned `"could not read/probe video"` — but
`ffprobe`/a standalone AVFoundation probe both confirmed the file was
completely valid. Traced (not guessed) to the real cause: `VideoGateVerdict`
evaluates fine, but its `meanDBFS` field is `-.infinity` for audio-less
clips, and Swift's `JSONEncoder` throws `EncodingError.invalidValue` on any
non-finite `Double` — silently swallowed by `GateCommand.swift`'s `try?
encoder.encode(...)` and mapped to the wrong, misleading reason. Fixed with
`encoder.nonConformingFloatEncodingStrategy = .convertToString(...)`; see
`swift/ltx-video-director/docs/TODO.md` for the full writeup + regression
tests (`VideoGateTests.swift`). A grep for the same pattern found and fixed
a second, worse instance in `I2VCommand.swift`'s `--json-out` (silently
dropped the whole `gate` key instead of even printing a wrong error).

**Consequence to keep in mind when calling this tool**: `native-upscale`
without `refineAudio` produces a video-only mp4. Gate it with
`expectVoice:false` (or pass `refineAudio: <base>/audio.wav` to
`native-upscale` if you want the upscaled clip to carry audio) — gating it
with the default `expectVoice:true` will correctly FAIL on "no audio track
present," which is not a bug, just an honest result now.

## 9. Audit sibling s2-agent-ext-* packages for the same `Type.Any()` options bug — DONE

Grepped `bun-apps/s2-agent-ext-*/extensions/*.ts` and `src/*.ts` for
`options: Type.Any(` / any loosely-typed options param. Only 3 packages
exist: `s2-agent-ext-flux2` and `s2-agent-ext-ltx` share the exact
`options: Type.Any({...})` shape (both already fixed with `coerceOptions()`
— item 7). `s2-agent-ext-power-tool` (`src/index.ts`) types every tool's
parameters as an explicit `Type.Object({...})` with named, individually
typed fields — no catch-all `options: Type.Any()` bucket, so the
JSON-string-serialization failure mode this bug depends on (a provider
serializing a whole options blob as one string) doesn't apply there. No
further packages to fix; closing this out as a clean audit rather than a
found-and-fixed item.

## 10. Extend the live-e2e workflow with the A/B upscale + ffprobe cross-check that found items 7 & 8 — DONE

Added an opt-in `includeUpscaleAB` step to
`bun-apps/s2-agent/run-dir/workflows/ltx-live-e2e.js` (default `false` — real
generation + upscale, ~5-10 min of MLX compute, same reasoning as the
existing `includeVideo` gate). When set, it runs the exact chain that found
items 7 and 8 for real, through the actual `ltx` s2-agent tool:
1. `native-i2v` (upscale:false, mp4:true) → base clip.
2. `native-upscale` (mode:fast, mp4:true) → upscaled clip.
3. An **independent** `ffprobe -show_entries stream=width,height,nb_frames,duration`
   call on both mp4s directly (via `Bun.spawnSync`/child_process in the
   scratch script — deliberately not the tool's own self-reported dims) —
   asserts upscaled width/height are exactly 2× base in both dimensions and
   duration matches within 0.1s tolerance, with the actual measured numbers
   recorded in the step detail so a human can check the arithmetic.
4. `gate` both clips with `expectVoice:false` (per item 8's finding —
   `native-upscale` without `--refine-audio` is legitimately audio-less) —
   asserts neither reports a "could not read/probe video" false negative.

Usage: `workflow` tool, `background:false`, script =
`ltx-live-e2e.js`, `args: { includeUpscaleAB: true }` (combine with
`includeVideo: true` to also run the plain native-i2v smoke in the same
pass).

Actually ran the default lane + `includeVideo:true` for real (not just
type-checked) and it found two real bugs in the *workflow script itself* on
the first pass, both fixed and reverified:
- `gate` doesn't accept still images despite an earlier version of this
  script assuming "gate accepts images too" — confirmed by a real run: the
  binary rejected a t2i PNG with `"could not read/probe video"`. Fixed by
  dropping `gate` from the default (image-only) lane entirely and only
  running it under `includeVideo:true`, against `native-i2v`'s real mp4.
- `runLtx`'s path validator rejects `/tmp` outright (only the repo root,
  models root, or `../video_generation__output` are allowed —
  `src/paths.ts`'s `resolveOutputDir`). The script's scratch *code* file can
  stay in `/tmp`, but every path passed as a `runLtx()` option must resolve
  under the allowed output root. Fixed by computing `OUT_DIR` from
  `resolveOutputDir`'s convention and writing all generated artifacts there.
- (Also bumped the smoke config's `seconds` from `0.5` to `1.2` — the
  0.38s clip that `0.5` snaps to at LTX's 8k+1 stride legitimately fails
  `VideoGate`'s 1.0s minimum-duration check; that's correct gate behavior,
  not a bug, but it made the smoke's own `overallOk` red for the wrong
  reason.)

Final verification run (`includeVideo:true`, real MLX compute, ~200s):
`models` ok, `t2i` ok (4.3s), `native-i2v` ok (57.6s, real `video.mp4`),
`gate` ok (status=PASS) — **overallOk: true**.

Then ran `includeUpscaleAB:true` for real too (~460s, real generation +
upscale both ways) — found and fixed a **third** real bug the same way:
the prompt told the subagent to pass the base run's **mp4** as
`native-upscale`'s `--input`, but that field is actually a PNG
`frame_%04d.png` **directory** (`native-i2v`'s own `frames/` output) — see
`commands.ts`'s `native-upscale.fields.input` description. The subagent
self-corrected at runtime (used `frames/` instead, kept the mp4 only for
the ffprobe dimension baseline) and the run still passed, but the workflow
prompt itself was still wrong and would trip up a differently-behaved
model/run. Fixed by rewording step 2 in the `UpscaleAB` agent prompt to
name the `frames/` directory explicitly instead of leaving it to be
inferred.

**Full A/B result, with the actual independent ffprobe numbers** (not the
tool's self-report): base clip `640×960`, `1.041667s`; upscaled clip
`1280×1920`, `1.041667s`. All three assertions held — width exactly 2×,
height exactly 2×, duration matched within tolerance. `gate-base` and
`gate-upscaled` both passed cleanly (the exact upscaled-clip case that used
to trigger the JSON-encoder false negative before item 8's fix — confirmed
still fixed under real load). **overallOk: true** for the full workflow
(smoke + UpscaleAB combined).

Net: this session's real (not just type-checked) execution of `ltx-live-e2e.js`
found and fixed **three** genuine bugs in the workflow script itself (gate
vs. still-image input, `/tmp` vs. the allowed output root, mp4 vs. frames-dir
for `native-upscale --input`) before it could reliably serve as the
repeatable regression check item 10 set out to build. The workflow is now
proven to pass end-to-end, twice, with real MLX compute both times.

This is the three-tier test plan going forward for this package: `bun test`
(unit — args/parsing/paths), `ltx-live-e2e.js` default lane (wiring — real
binary via the real s2-agent tool), and `includeUpscaleAB` (semantic
correctness — did the generation actually do the right thing, verified
independently of the tool's own claims).

Looked into VMAF/SSIM-based quality scoring as a further-out idea (Netflix's
`libvmaf` via ffmpeg, used in video-encoder CI to catch perceptual
regressions, not just dimension/duration correctness) — deliberately not
added here: it needs a `libvmaf`-enabled ffmpeg build, careful
reference/distorted resolution alignment (never downscale the master —
upscale the distorted to match, per common CI pitfalls), and a real quality
threshold (e.g. `VMAF_mean >= 90`) that this repo hasn't established for its
own upscale path yet. Worth a dedicated follow-up item once
`native-upscale --mode hd` (item 3) has real checkpoint output to calibrate
against — grading a fast-mode upscale on VMAF today would just be inventing
a threshold with nothing to validate it.

## 11. Swift CLI gained `--second-stage` (N-stage upscale cascade) — not yet wrapped here

`native-upscale`/`native-i2v` on the Swift side (`swift/ltx-video-director`)
gained a `--second-stage x1.5|x2` flag (2026-07-04) that chains a second
neural-upscale+refine pass, mirroring the reference 3-stage FFLF workflow's
Stage #3 — see `PLAN.md`'s "True N-stage upscale cascade" milestone and
`docs/reference/comfyui_workflows/README.md`'s fifth pass in that package.
Not yet added to `src/commands.ts`'s `nativeUpscale`/`native-i2v` field
schemas here — this package only wraps whatever the Swift CLI exposes
(see "Not planned" below), and per this file's own convention (item 3),
wrapper coverage for new Swift-side flags is added when there's a concrete
need to drive them through the s2-agent tool, not automatically on landing.
**Next step if picked up**: add a `secondStage: { flag: "--second-stage",
type: "string", ... }` field to both commands' schemas, matching the
existing `mode`/`refinePrompt` field style.

## 12. ASR voice-content gate wired through — DONE (2026-07-04)

`output/new-goal-20260704-141422.md` item (A): `gate`'s field schema gained
`asrPrompt`/`expectedScript`, matching the Swift `--asr-prompt`/
`--expected-script` flags now exposed by `ltx-video gate` (native
`ASRGate.swift` + `CJKScript.swift` — the latter is a fully native
Traditional-vs-Simplified classifier, no ML model). `check:flags` confirms
0 drift on `gate`. Transcription itself still bridges to Python's
`mlx_whisper` via the new `run.py video asr-gate` subcommand — see
`swift/ltx-video-director/docs/TODO.md`'s matching entry for the full
native/bridged breakdown.

## 13. `s2-agent-ext-ltx-self-improve` workflow does not exist yet

`output/new-goal-20260704-141422.md` item (B), still open: no
`.claude/workflows/s2-agent-ext-ltx-self-improve.js` exists (compare to
`s2-agent-ext-flux2-self-improve.js`, the reference 3-lane template —
contract = `bun test` + `check:flags` drift guard; review = agent code
review with adversarial verify; live-e2e = drive the real binary). This
package already has the two deterministic gates that template's contract
lane would run (`bun test`, `check:flags`) and a live-e2e precedent
(item 10 above); what's missing is the workflow script itself gluing them
together. Sequencing note from the goal file: the live-e2e lane should
exercise the new ASR/zh-TW gate (item 12) once it existed — which it now
does, so this is unblocked.

## 14. Two whole subcommands (`native-t2a`, `segment`) were unwrapped — DONE

Prompted by a `/review and improve pi-ext-ltx, search ComfyUI workflow JSON`
request. `check:flags` reported "10/10 commands fully modeled" — misleadingly
green, because it only iterates `Object.entries(COMMANDS)` and checks each
*already-modeled* command for flag drift; it never checked whether
`ltx-video --help`'s own subcommand list contains commands NOT in
`commands.ts` at all. Cross-checking `LTXVideoDirectorCLI.swift`'s
`subcommands:` array directly found two real, already-shipped CLI commands
with zero wrapper coverage: `native-t2a` (pure text-to-audio, ported per the
ComfyUI research below) and `segment` (HSV-histogram scene-cut detection,
landed via PR #234). Fixed both ways:

1. **The drift guard's blind spot itself** — `check-flags.ts` now also diffs
   `ltx-video --help`'s declared subcommand set against `Object.keys(COMMANDS)`
   and fails with an explicit `unmodeled: [...]` list if the CLI has grown a
   subcommand this package doesn't know about at all, not just flag-level
   drift within known commands.
2. **Both commands added** to `commands.ts` (full field maps, cross-checked
   against `NativeT2ACommand.swift`/`SegmentCommand.swift`'s real `--help`
   output) and `result.ts` (`buildNativeT2ADetails`, `buildSegmentDetails` —
   the latter also gained a `LtxDetails.scenes: SceneEntry[]` field, the
   first command in this package with a real per-item result array outside
   of `gate`/`verify`). Verified via `check:flags` (12/12, no drift) and a
   real end-to-end run through the actual `runLtx()` path (not `bun test`
   mocks): `native-t2a` produced a real `audio.wav` (2.6s wall time),
   `segment` correctly detected 1 real scene in a real 15s clip and wrote
   its JSON report.
3. **A second, independent bug found by that same real end-to-end run**:
   `segment`'s `json` field (a WRITE target — the report path, which
   legitimately doesn't exist yet) was rejected by `validateOptionPaths`
   with "does not exist", because the `mustExist` check was a hardcoded
   `key === "output"` string comparison — any differently-named output-path
   field failed it. This is NOT new to this session: `i2v`'s pre-existing
   `jsonOut` field (`--json-out`) had the exact same bug, just never
   exercised end-to-end before. Fixed by adding an explicit
   `FieldSpec.isOutputPath?: boolean` and setting it on both `segment.json`
   and `i2v.jsonOut`, instead of relying on the field being literally named
   `"output"`.

96 -> 99 tests (2 new `native-t2a`/`segment` describe blocks in
`result.test.ts`, existing `commands.test.ts` registry-count assertions
updated 10 -> 12). `README.md`/`extensions/ltx.ts` doc counts and command
lists updated to match (also fixed a stale "no mp4 muxer yet" line for
`native-i2v` — mp4 muxing shipped in an earlier pass and the README hadn't
been updated).

## 15. First real run of `s2-agent-ext-ltx-self-improve` — 7 of 8 review findings fixed

The workflow (item 13, authored but never executed) was run for real for the
first time (`Workflow({scriptPath: ...})`, explicit user opt-in). All three
lanes green: contract (99/99 tests, 12/12 `check:flags`), live-e2e (real
`native-i2v` generation + real `mlx_whisper` ASR gate transcription — exit
paths both confirmed live), review (4 dimensions, adversarial-verified, 8
upheld findings). Fixed 7 of the 8:

1/8 (`result.ts`) — `buildGateDetails`/`summarize` never read the nested
   `asr` sub-object `gate --json` embeds, so an ASR content FAIL could read
   as `details.gate: "PASS"`. Fixed: `worseStatus()` folds `entry.status`
   AND `entry.asr?.status` into one worst verdict; `summarize()` now shows
   the ASR line and — importantly — runs its `gate`-specific branch BEFORE
   the generic `!d.ok` early-return (gate exiting non-zero because it found
   a real failure is the expected, informative case, not a crash to hide
   behind a raw stdout tail).
2/8 (`result.ts`) — `parseWallSeconds` took the FIRST "wall time:" line only,
   silently dropping any upscale/second-stage add-on's own timing line.
   Fixed: sums every occurrence (`allMatches`, not `firstMatch`).
3-5/8 (`paths.ts`, `validateExtraArgs`) — three related argv-injection gaps
   in the extraArgs escape hatch (agent-reachable via `extensions/ltx.ts`'s
   `extraArgs` param): `--flag=value` syntax bypassed validation on the value
   half entirely; a bare-word value (no `/`, no long extension) skipped
   `assertPathAllowed` under the old `looksPathy` heuristic — a symlink named
   e.g. `shortcut` dropped under an allowed root would escape undetected;
   and `--lora path:strength` values weren't stripped of their suffix before
   the exists-check, unlike the equivalent structured-field path. Fixed by
   always validating every non-flag value (relative bare words resolve
   harmlessly under `repoRoot`, so this doesn't reject legitimate scalars)
   and stripping `--flag=` values / `:strength` suffixes the same way the
   structured-field path already does. 4 new regression tests in
   `paths.test.ts` (including a real symlink escape).
6/8 (`index.ts`/`check-flags.ts`) — `EXTRA_ARG_ALLOW` (the flat, cross-command
   allow-list backing the extraArgs escape hatch) was invisible to
   `check:flags`, which only ever diffs `commands.ts`'s typed fields. Fixed:
   `EXTRA_ARG_ALLOW` exported, `check-flags.ts` now accumulates the union of
   every command's real `--help` flags and fails if any allow-list entry
   doesn't match one — the same "guard the guard" fix as item 14's
   subcommand check, applied to a second blind spot.
7/8 (`index.ts`) — `ensureBinary()` inside `runOnce` had no try/catch, so a
   fresh-checkout `swift build` failure would crash the caller with an
   unhandled rejection instead of the documented `details.ok=false`
   contract. Fixed: wrapped, converted to a synthetic failed `InvokeResult`
   run through the normal per-command `buildDetails` path. (No dedicated
   regression test — forcing a deterministic build failure without either a
   slow real `swift build` or risky process-global env mutation wasn't
   worth it; verified by code inspection + full suite still green.)

**8/8 NOT fixed, left as a known remaining gap**: if the ASR Python bridge
crashes internally (e.g. `mlx_whisper` not installed) and Swift's `try?`
swallows it, the JSON entry gets no `asr` key at all — and nothing on this
side can currently tell "ASR was requested via `asrPrompt` but silently
never ran" from "ASR wasn't requested," because `result.ts`'s `buildDetails`
only sees stdout, not the original `options`. Fixing this needs threading
`options.asrPrompt` through into `buildGateDetails` (a signature change to
`buildDetails`/`runOnce`), deferred as a separate, smaller follow-up rather
than folded into this pass.

99 → 105 tests (4 new in `paths.test.ts` for items 3-5, 2 new in
`result.test.ts` for item 1); `check:flags` still 12/12, no drift.

## 16. Item 15's gap 8/8 fixed — ASR silently-swallowed-crash detection

Threaded `options.asrPrompt` through `runOnce` -> `buildDetails` ->
`buildGateDetails` (signature changes to all three, as scoped in item 15).
When `asrPrompt` was passed but a `gate --json` entry has no `asr` key at
all (Swift's `try? ASRGate.evaluate(...)` swallowed a bridge crash — e.g.
`mlx_whisper` not installed — to `nil`), `buildGateDetails` now appends a
synthetic reason ("ASR requested (asrPrompt) but no asr result was
returned — likely a swallowed Python-bridge crash") and bumps that entry's
status to FAIL, rather than reporting whatever the video-only status alone
says. Without `asrPrompt`, a missing `asr` key is untouched (it just wasn't
requested). 2 new tests in `result.test.ts` covering both branches.

105 → 107 tests; `check:flags` still 12/12, no drift.

## 17. Flag drift from the native-relay/native-i2v-input-image/restore-lora session — DONE

A prior session's Swift-side work (`native-relay` built from scratch;
`native-i2v` gained `--input-image`; `native-upscale --mode hd`'s
restoration LoRA went from "doesn't exist" to real+externalized) silently
drifted this wrapper out of sync — nothing caught it until a later
self-reflection pass ran `check:flags` and found 3 concrete gaps:
`native-i2v` missing `inputImage`, `native-relay` unmodeled entirely, and
(pre-existing, not caused by that session but folded into this same pass)
`native-ingredients`/`native-restyle` also entirely unmodeled.

Fixed all four in one pass:
- Added `inputImage` (`--input-image`) to `native-i2v`'s fields, same shape
  as `lastFrame` (`isPath: true`).
- Modeled `native-relay` as a full new command: `prompts` (string[]),
  `firstImage`, `seconds`/`fps`/`width`/`height`/`seed`, `t2iTransformer`
  (`isPathComponent`), `textMaxLength`, `loras` (`isPathSpecArray`, same
  pattern as `native-i2v`), `output`, `relayAudio`, `relayTtsText`,
  `relayTtsVoice`, `relayTtsRate` (int, confirmed against the Swift
  `@Option var relayTTSRate: Int = 145`), and `variant` — the last one
  deliberately a plain `string[]`, NOT `isPathSpecArray`: its
  `name[=lora_path[:strength]]` format doesn't match the plain
  `path[:strength]` shape `pathSpecFieldKeys`'s validator assumes (a bare
  `"baseline"` would wrongly be checked as a real path). Path validation
  for the embedded LoRA path is left to the Swift binary's own
  `ValidationError`, matching this wrapper's existing pattern for
  Swift-side-validated sub-formats.
- Modeled `native-ingredients` and `native-restyle` as new commands
  (single-reference-image / V2V-restyle IC-LoRA adapters, both
  user-supplied — no bundled `lora` default, unlike every other LoRA path
  in this package).
- Updated `native-upscale`'s `mode` field description (item 3, above) to
  drop the stale "UNVERIFIED"/"gitignored, user-downloaded" language now
  that a real restoration+upscale LoRA pair is externalized and
  end-to-end-verified.
- README's command count/list and the `native-i2v` section updated to
  match (12 → 15 commands); added a `native-relay` /
  `native-ingredients` / `native-restyle` section.

107 → 111 tests (new `buildArgs` coverage for `native-i2v`'s `inputImage`,
`native-relay`'s array-flag expansion including `variant`'s
`name=path:strength` shape, and `native-ingredients`/`native-restyle`'s
required scalar flags; updated the 12-command and path-spec-field-keys
registry assertions to the new 15); `check:flags` now 15/15, no drift.

## Not planned

- Bit-exact parity between `native-upscale --mode hd` and the run.py-bridged
  `ltx-video upscale`'s IC-LoRA output — deliberately out of scope, see
  `NativeUpscaleStage.generateHD`'s doc comment in the Swift package. This
  wrapper will surface whatever the Swift CLI produces; it doesn't
  reimplement or second-guess the generation algorithm.
