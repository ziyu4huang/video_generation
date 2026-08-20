# Receipt — Item C: agent-driven CLIP video_understand (parity with ESRGAN)

**Date:** 2026-07-05 14:59 UTC
**Goal:** Mirror the ESRGAN agent-driven receipt (`agent-upscale-20260705.md`) for
CLIP — a real **gemma-4-26b agent** drives `movie generate {analysis,
video_understand}` and reasons over the returned `{score, prob_mean, frames[]}`.
Closes the asymmetry the prior goal flagged (ESRGAN had an agent-driven receipt;
CLIP was deterministic-e2e only).

## Verdict: SUCCESS

| Gate | Result |
|---|---|
| Agent-driven CLIP scores (gemma issues the `movie` call) | ✅ 1 `movie generate` call; `success:true`, provider `clip`, model `openai/clip-vit-base-patch32` |
| Real CLIP ran (torch MPS, frame×prompt cosine) | ✅ 5.26s, $0 (local), ranked the test-pattern clip against two labels |
| Parity with ESRGAN receipt | ✅ same invocation shape, same single-tool thesis |

## Runtime configuration
- `bun bun-apps/s2-agent/src/cli.ts --no-extensions -e …/movie-director.ts`
- Provider `lm-studio`, model `google/gemma-4-26b-a4b-qat`, **thinking `medium`**
- `--no-builtin-tools` → the agent had **only** the `movie` tool.
- `BUN_PI_LOAD_RUN_DIR=FALSE`.

## Two friction points (both pre-empted in the prompt, both real)
1. **Double-nested options** (the Item I class). `generate` puts capability/command
   at the top of `options` but the director's per-command args (`video`, `prompt`,
   `labels`) live in an INNER `options.options` bag. The prompt stated the exact
   shape → the agent nested correctly first try.
2. **Provider routing** (NEW finding, not in the ESRGAN run). The `analysis`
   capability has TWO configured providers: `whisper` (transcriber) and `clip`
   (video_understand). `selectProvider("analysis")` is **backend-ranked then
   declaration-ordered** — both are `native_swift`, and `transcriber` is declared
   before `video_understand` in the registry, so **the default pick is whisper**.
   The first CLIP run (without a provider hint) mis-routed to whisper and failed
   with `audio missing or not found: (none)` (the whisper adapter ignores the
   `command` field). The fix: pass `"provider": "clip"` at the top level of
   `options`. With the hint, the run converged to the right provider in one call.

   > **UX note:** `command:video_understand` cannot reach CLIP without an explicit
   > `provider:clip` hint today. A future selector refinement could let `command`
   > break capability ties (whisper owns `transcribe`, clip owns `video_understand`)
   > — out of scope for this goal, recorded here.

## Generated artifact (proof)
The agent's final report (verbatim):
> The CLIP analysis has been successfully completed.
> - **Success**: `true`  • **Provider**: `clip`
> - **Model**: `openai/clip-vit-base-patch32`  • **Command**: `video_understand`
> - **Duration**: `5.26s`  • **Cost**: `$0.00`

The agent noted it could not read the `clip_scores.json` artifact directly (it had
only the `movie` tool, no `read`). The deterministic `run-clip-e2e.ts` receipt
(`receipts/clip-e2e-20260705.md`, same run) carries the numeric detail:
**score=0.291, prob_mean=0.978, ranked=true** — the test-pattern clip scores high
for "a colorful test pattern" vs "a solid black screen", as expected.

## Fold-in surfaced live: repo-root litter (same class as transcribe)
The agent's report referenced `clip_scores.json` at the **REPO ROOT**
(`/Users/…/video_generation__image_workflow/clip_scores.json`) — the CLIP adapter
defaulted `outDir = req.outputDir ?? process.cwd()`, and the agent omitted
outputDir, so `clip_scores.json` + 4 sampled `clip_frames/*.png` + the per-call
`clip_<pid>_<n>.json` scratch files all landed in the repo root. This is the SAME
drift class the goal named for `transcribe` (providers.ts:414). Fix extended to
ALL three subprocess adapters:
- `whisperAdapter`, `clipAdapter`, `esrganAdapter` now default to a per-call
  `mkdtempSync(join(tmpdir(), "md-<kind>-"))` instead of `process.cwd()`. Unit
  tests for whisper + clip lock the temp-dir default; esrgan's scratch JSON uses
  the same path.

## Conclusion
CLIP now has agent-driven parity with ESRGAN: a real gemma-4-26b agent at thinking
`medium` drove `movie generate {analysis, video_understand, provider:clip}` end-to-
end and produced real scores (success:true, clip provider, $0 local). The run
surfaced two routing/nesting friction points (both pre-empted by the prompt) AND a
third live defect — the same repo-root-litter drift transcribe had — which is now
fixed across all three subprocess adapters. Combined with the deterministic
`run-clip-e2e.ts` receipt, CLIP is fully proven.
