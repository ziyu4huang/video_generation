/**
 * /scene-assets — parallel asset generation per scene.
 *
 * Per scene: T2I still → I2V clip (chained when scene duration > one practical
 * call ~8s) → TTS narration. All scenes run in parallel via parallel().
 * Deterministic steps use call('movie.*'); the only agent() calls are ffmpeg
 * last-frame extractions (tier:small) for I2V continuation.
 *
 * Scene shape (canonical scene_plan): {id, type, description, start_seconds,
 * end_seconds, script_section_id?, shot_language?, narration?, image?, prompt?}
 *   visual prompt  ← scene.prompt  OR scene.description (+ shot_language vocab)
 *   duration       ← scene.durationSeconds OR (end_seconds − start_seconds) OR 8s
 *   narration      ← scene.narration (populated by /produce-video from the script)
 * A simplified {id, prompt, durationSeconds, narration} shape also works.
 */
export const meta = {
  name: 'scene-assets',
  description: 'Parallel per-scene asset generation: T2I still → I2V clip (chained for long scenes) → TTS narration. Deterministic via call("movie.*").',
  phases: [{ title: 'Setup' }, { title: 'Generate' }, { title: 'Report' }],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const projectId = A.projectId
const pipeline = A.pipeline || 'animated-explainer'
const outputDir = A.outputDir
const PRACTICAL_CLIP_SEC = 8 // hardware ceiling per I2V call (see dispatch generate notes)
const FPS = 25

/** Build the visual prompt for a scene from canonical fields + shot vocabulary. */
function visualPrompt(s) {
  if (s.prompt) return s.prompt
  let p = s.description || ''
  const sl = s.shot_language || {}
  const vocab = [
    sl.shot_size, sl.camera_movement, sl.lighting_key, sl.lens_mm ? sl.lens_mm + 'mm' : null,
    sl.depth_of_field ? sl.depth_of_field + ' dof' : null, sl.color_temperature,
  ].filter(Boolean)
  if (vocab.length) p += `. Cinematography: ${vocab.join(', ')}.`
  return p
}

/** Resolve a scene's target duration in seconds (canonical start/end, simplified, or default). */
function sceneDuration(s) {
  if (typeof s.durationSeconds === 'number') return s.durationSeconds
  if (typeof s.end_seconds === 'number' && typeof s.start_seconds === 'number') {
    return Math.max(0.5, s.end_seconds - s.start_seconds)
  }
  return PRACTICAL_CLIP_SEC
}

phase('Setup')
let scenes = Array.isArray(A.scenes) ? A.scenes : null
if (!scenes && projectId) {
  const cp = await call('movie.read-checkpoint', { projectId, pipeline })
  scenes = cp?.checkpoint?.artifacts?.scene_plan?.scenes ?? null
}
if (!scenes || scenes.length === 0) {
  throw new Error('scene-assets: pass args.scenes[] or args.projectId with a completed scene_plan checkpoint')
}
log(`scenes: ${scenes.length}; projectId: ${projectId || '(none)'}`)

phase('Generate')
const results = await parallel(scenes.map((s) => () => generateScene(s)))

phase('Report')
// Build edit_decisions.cuts: one cut per generated clip, consecutive sub-clips
// for chained (multi-call) scenes named cut-<sceneId>-a/b/...
const editCuts = []
for (let i = 0; i < results.length; i++) {
  const r = results[i]
  if (!r || !r.clipPaths || r.clipPaths.length === 0) continue
  if (r.clipPaths.length === 1) {
    editCuts.push({ id: `cut-${scenes[i].id}`, source: r.clipPaths[0], in_seconds: 0, out_seconds: r.durationSeconds, type: 'video' })
  } else {
    let off = 0
    for (let j = 0; j < r.clipPaths.length; j++) {
      const dur = Math.min(PRACTICAL_CLIP_SEC, r.durationSeconds - off)
      editCuts.push({ id: `cut-${scenes[i].id}-${String.fromCharCode(97 + j)}`, source: r.clipPaths[j], in_seconds: 0, out_seconds: dur, type: 'video' })
      off += dur
    }
  }
}
if (projectId) {
  await call('movie.write-checkpoint', {
    projectId, pipeline, stage: 'assets', status: 'completed',
    artifacts: { edit_decisions: { version: '1', render_runtime: 'ffmpeg', cuts: editCuts } },
  })
}
return { scenes: scenes.length, results, editCuts }

async function generateScene(s) {
  // 1. T2I still (or reuse a provided image path)
  let stillPath = s.image
  if (!stillPath) {
    const t2i = await call('movie.generate', {
      capability: 'image_generation', command: 't2i',
      options: { prompt: visualPrompt(s) }, projectId, outputDir,
    })
    stillPath = t2i?.result?.artifacts?.[0]?.path
  }
  if (!stillPath) throw new Error(`scene ${s.id}: T2I produced no still`)

  // 2. I2V — chain multiple calls when the scene is longer than one practical clip
  const targetSec = sceneDuration(s)
  const clipPaths = []
  let frame = stillPath
  let elapsed = 0
  const prompt = visualPrompt(s)
  while (elapsed < targetSec) {
    const chunk = Math.min(PRACTICAL_CLIP_SEC, targetSec - elapsed)
    const i2v = await call('movie.generate', {
      capability: 'video_generation',
      options: { prompt, image: frame, frames: Math.round(chunk * FPS), fps: FPS },
      projectId, outputDir,
    })
    const clipPath = i2v?.result?.artifacts?.[0]?.path
    if (!clipPath) throw new Error(`scene ${s.id}: I2V produced no clip at elapsed=${elapsed}`)
    clipPaths.push(clipPath)
    elapsed += chunk
    if (elapsed < targetSec) {
      // continue motion: feed clip's last frame into the next I2V call
      const lf = await agent(
        `Run: Bash("ffmpeg -y -sseof -1 -i '${clipPath}' -frames:v 1 '${clipPath}.lastframe.png' && test -s '${clipPath}.lastframe.png' && echo ${clipPath}.lastframe.png"). Return the echoed path verbatim, or null on failure.`,
        { tier: 'small', label: `lastframe-${s.id}-${clipPaths.length}` },
      )
      frame = (typeof lf === 'string' ? lf : '').trim() || `${clipPath}.lastframe.png`
    }
  }

  // 3. TTS narration (tracked path — never raw say/edge-tts)
  let narrationPath = null
  if (s.narration) {
    const tts = await call('movie.generate', { capability: 'tts', options: { text: s.narration }, projectId, outputDir })
    narrationPath = tts?.result?.artifacts?.[0]?.path
  }
  return { id: s.id, stillPath, clipPaths, durationSeconds: targetSec, narrationPath }
}
