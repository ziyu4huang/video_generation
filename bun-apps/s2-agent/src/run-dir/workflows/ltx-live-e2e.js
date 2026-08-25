/**
 * ltx-live-e2e — REAL end-to-end smoke test for bun-apps/s2-agent-ext-ltx.
 *
 * Runs the ACTUAL `ltx-video` Swift/MLX binary via `runLtx()` (no mocks),
 * through s2-agent's own dynamic-workflows engine — the same path a user
 * invokes with `bun-apps/s2-agent/run.sh -p "…"`. Mirrors
 * `.claude/workflows/s2-agent-ext-flux2-self-improve.js`'s `runLiveE2eLane()`
 * shape, scaled down to a one-shot smoke (no contract/review lanes, no
 * knowledge-base persistence — those belong to a future full self-improve
 * workflow for this package, not this exploration).
 *
 * DEFAULT steps (fast, well under a minute of real compute):
 *   1. models    — list installed transformer variants, no generation.
 *   2. t2i       — small/cheap image smoke (512x512, few steps).
 * `gate` is NOT run in the default lane: it only probes video containers
 * (an earlier version of this script fed it the t2i PNG on the assumption
 * "gate accepts images too" — that assumption was wrong, confirmed by an
 * actual run: the binary rejected the PNG with "could not read/probe
 * video". Gate only runs once there's a real video to gate — see below.
 *
 * OPTIONAL (args.includeVideo:true) adds:
 *   3. native-i2v — the flagship command, real video generation. Even at
 *      --seconds 1.2 --no-upscale --no-refine (1.2s requested, snapped to
 *      LTX's 8k+1 frame stride — clears gate's 1.0s minimum-duration floor,
 *      unlike an earlier 0.5s config that legitimately failed gate on
 *      duration) this is still several minutes of real MLX compute, so it
 *      stays opt-in.
 *   4. gate       — on native-i2v's actual video output (expectVoice:false,
 *      since this smoke config runs with --no-refine so it may not carry
 *      final-mix audio).
 *
 * OPTIONAL (args.includeUpscaleAB:true) adds the A/B upscale correctness
 * check that actually found two real bugs this way (see TODO.md items 7/8):
 *   5. native-i2v (mp4:true, no upscale)      -> base clip
 *   6. native-upscale (mode:fast, mp4:true)   -> upscaled clip
 *   7. ffprobe BOTH mp4s directly (not the tool's self-report) and assert
 *      upscaled width/height are exactly 2x base, duration/nb_frames match.
 *   8. gate BOTH clips with expectVoice:false (native-upscale doesn't carry
 *      audio unless --refine-audio is given — that's expected, not a bug)
 *      and assert neither reports a read/probe error.
 * This is real generation + upscale, ~5-10 minutes of MLX compute — opt-in,
 * independent of includeVideo (you can run the AB check without the plain
 * native-i2v smoke step, or both).
 *
 * Usage:
 *   Workflow tool / `workflow` tool, background:false, script = this file.
 *   args: { includeVideo: true } to also exercise native-i2v.
 *   args: { includeUpscaleAB: true } to also run the A/B upscale + ffprobe
 *   cross-check (semantic correctness, not just "did it exit 0").
 */
export const meta = {
  name: 'ltx-live-e2e',
  description: 'Real end-to-end smoke test for s2-agent-ext-ltx: runs the actual ltx-video binary via runLtx() (models/t2i/gate, optionally native-i2v and an A/B upscale+ffprobe correctness check) through s2-agent itself — not just bun test.',
  phases: [
    { title: 'Smoke', detail: 'models -> t2i -> gate (real ltx-video calls), optional native-i2v' },
    { title: 'UpscaleAB', detail: 'native-i2v -> native-upscale -> independent ffprobe cross-check -> gate' },
  ],
}

let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch { _args = {} }
}
const A = _args ?? {}
const INCLUDE_VIDEO = A.includeVideo === true
const INCLUDE_UPSCALE_AB = A.includeUpscaleAB === true

const LIVE_E2E_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          ok: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['name', 'ok'],
      },
    },
    overallOk: { type: 'boolean' },
  },
  required: ['steps', 'overallOk'],
}

phase('Smoke')

log(`ltx-live-e2e: includeVideo=${INCLUDE_VIDEO}`)

const result = await agent(
  `Run a REAL end-to-end smoke test for s2-agent-ext-ltx (bun-apps/s2-agent-ext-ltx) — actual ltx-video Swift/MLX binary calls via runLtx(), no mocks.

1. Bash("git rev-parse --show-toplevel") to get the repo root, call it REPO_ROOT. Compute OUT_DIR = REPO_ROOT + "/../video_generation__output/ltx-live-e2e-smoke" (runLtx's path validator only allows paths under the repo root, its models root, or this output root — NOT /tmp; see bun-apps/s2-agent-ext-ltx/src/paths.ts resolveOutputDir). Bash("mkdir -p '\${OUT_DIR}'").
2. Write a scratch bun script at /tmp/ltx-live-e2e-smoke.ts (the SCRIPT ITSELF can live in /tmp — only the paths passed as runLtx() output/input options must be under OUT_DIR) that:
   - imports { runLtx } from "\${REPO_ROOT}/bun-apps/s2-agent-ext-ltx/src/index.ts" via an absolute path
   - Step "models": runLtx({ command: "models" }) — record ok (details.ok), a short detail (which variants were listed).
   - Step "t2i": runLtx({ command: "t2i", options: { prompt: "a red apple on a white table, studio lighting", width: 512, height: 512, steps: 6, seed: 42, output: "\${OUT_DIR}/t2i.png" } }) — record ok, output path, wall seconds.
${INCLUDE_VIDEO ? `   - Step "native-i2v": runLtx({ command: "native-i2v", options: { prompt: "a red apple on a white table, studio lighting", seconds: 1.2, width: 640, height: 960, seed: 42, upscale: false, refine: false, mp4: true, output: "\${OUT_DIR}/native_i2v" } }) — record ok, the resolved mp4 (or frames dir) path, wall seconds. This step takes several minutes of real MLX compute — that's expected.
   - Step "gate": ONLY if native-i2v ok AND it produced an mp4 path — runLtx({ command: "gate", options: { videos: [<the native-i2v mp4 path>], json: true, expectVoice: false } }) — record ok, the gate status for that file. gate probes video CONTAINERS only — never point it at a still image (an earlier version of this script wrongly assumed "gate accepts images too" and it does not; confirmed by a real run rejecting a PNG with "could not read/probe video").` : '   - SKIP native-i2v and gate (includeVideo was not set) — note both explicitly as skipped steps with ok:true, detail:"skipped (includeVideo not set)".'}
   - Print a JSON array of { name, ok, detail } for every step (skipped steps included with ok:true and a "skipped" detail).
3. Bash("cd '\${REPO_ROOT}' && bun /tmp/ltx-live-e2e-smoke.ts 2>&1") — this performs REAL generation. Expect ${INCLUDE_VIDEO ? 'several minutes' : 'under a minute'} total. Capture the printed JSON array.
4. Bash("rm -f /tmp/ltx-live-e2e-smoke.ts") and Bash("rm -rf '\${OUT_DIR}'") to clean up the generated artifacts.
5. overallOk = true iff every step in the array has ok:true.
Return { steps: <the JSON array from step 3>, overallOk }.`,
  { label: 'live-e2e-smoke', phase: 'Smoke', schema: LIVE_E2E_SCHEMA },
)

if (result) {
  log(`Live E2E: ${result.overallOk ? 'PASS' : 'FAIL'} — ${(result.steps || []).map((s) => `${s.name}=${s.ok ? 'ok' : 'FAIL'}`).join(', ')}`)
}

let abResult = null
if (INCLUDE_UPSCALE_AB) {
  phase('UpscaleAB')
  log('ltx-live-e2e: running A/B upscale + independent ffprobe cross-check (~5-10 min of real MLX compute)')

  abResult = await agent(
    `Run the A/B upscale correctness check for s2-agent-ext-ltx (bun-apps/s2-agent-ext-ltx) — real ltx-video generation via runLtx(), then verify the result with an INDEPENDENT ffprobe call, not the tool's own self-reported dims/duration. This exact sequence previously found two real bugs (a JSON-string options-serialization bug and a gate JSON-encoder false negative on audio-less clips) — it is meant to be a genuine correctness check, not a smoke test.

1. Bash("git rev-parse --show-toplevel") to get the repo root, call it REPO_ROOT. Compute OUT_DIR = REPO_ROOT + "/../video_generation__output/ltx-upscale-ab" (runLtx's path validator only allows paths under the repo root, its models root, or this output root — NOT /tmp; see bun-apps/s2-agent-ext-ltx/src/paths.ts resolveOutputDir). Bash("mkdir -p '\${OUT_DIR}'").
2. Write a scratch bun script at /tmp/ltx-upscale-ab.ts (the SCRIPT ITSELF can live in /tmp — only paths passed as runLtx() output/input options must be under OUT_DIR) that:
   - imports { runLtx } from "\${REPO_ROOT}/bun-apps/s2-agent-ext-ltx/src/index.ts" via an absolute path
   - Step "native-i2v-base": runLtx({ command: "native-i2v", options: { prompt: "a red apple on a white table, studio lighting", seconds: 1.2, width: 640, height: 960, seed: 42, upscale: false, refine: false, mp4: true, output: "\${OUT_DIR}/base" } }) — record ok, and BOTH the resolved base mp4 path (for ffprobe/gate later) AND the resolved frames/ directory path (for native-upscale's input, next step) from details/extraOutputs.
   - Step "native-upscale": ONLY if native-i2v-base ok — runLtx({ command: "native-upscale", options: { input: <the base run's frames/ DIRECTORY, not the mp4 — native-upscale's --input takes a PNG frame_%04d.png sequence directory, e.g. "\${OUT_DIR}/base/frames">, mode: "fast", mp4: true, output: "\${OUT_DIR}/upscaled" } }) — record ok and the resolved upscaled mp4 path.
   - Step "ffprobe-crosscheck": ONLY if native-upscale ok — run \`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames,duration -of json <path>\` via Bun's \`Bun.spawnSync\` (or child_process) directly on BOTH the base and upscaled mp4 paths (NOT trusting runLtx's own reported dimensions — this is the whole point of the check), parse both JSON outputs, and assert: upscaledWidth === 2 * baseWidth, upscaledHeight === 2 * baseHeight, and duration matches within 0.1s tolerance between base and upscaled. Record ok=true only if all three assertions hold, and put the actual measured numbers (base WxH, upscaled WxH, both durations) in the detail string so a human can verify the arithmetic themselves.
   - Step "gate-base": runLtx({ command: "gate", options: { videos: [<base mp4 path>], json: true, expectVoice: false } }) — record ok and whether the parsed JSON verdict's status is anything other than a "could not read/probe video" reason.
   - Step "gate-upscaled": runLtx({ command: "gate", options: { videos: [<upscaled mp4 path>], json: true, expectVoice: false } }) — same check on the upscaled clip (this is the exact file that used to trigger the JSON-encoder false negative before it was fixed).
   - Print a JSON array of { name, ok, detail } for all 5 steps.
3. Bash("cd '\${REPO_ROOT}' && bun /tmp/ltx-upscale-ab.ts 2>&1") — this performs REAL generation + upscale. Expect several minutes total. Capture the printed JSON array.
4. Bash("rm -f /tmp/ltx-upscale-ab.ts") and Bash("rm -rf '\${OUT_DIR}'").
5. overallOk = true iff every step in the array has ok:true.
Return { steps: <the JSON array from step 3>, overallOk }.`,
    { label: 'live-upscale-ab', phase: 'UpscaleAB', schema: LIVE_E2E_SCHEMA },
  )

  if (abResult) {
    log(`Upscale A/B: ${abResult.overallOk ? 'PASS' : 'FAIL'} — ${(abResult.steps || []).map((s) => `${s.name}=${s.ok ? 'ok' : 'FAIL'}`).join(', ')}`)
  }
}

return {
  steps: [...(result?.steps || []), ...(abResult?.steps || [])],
  overallOk: (result?.overallOk ?? false) && (INCLUDE_UPSCALE_AB ? (abResult?.overallOk ?? false) : true),
}
