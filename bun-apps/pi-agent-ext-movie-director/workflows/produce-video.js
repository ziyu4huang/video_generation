/**
 * /produce-video — the full movie pipeline as one journaled-resumable workflow:
 * init → idea → research/proposal → script → scene_plan → assets → edit →
 * compose → publish. Composes /research-first, /scene-assets, /review-cut via
 * the workflow() global (resolved by movie-workflows.ts' loadSavedWorkflow).
 *
 * Scene/narration join: the scene_plan schema has NO narration field —
 * narration lives in the script's sections, linked by script_section_id. So
 * this workflow merges each scene's narration from its script section BEFORE
 * calling /scene-assets (which reads scene.narration for TTS).
 */
export const meta = {
  name: 'produce-video',
  description: 'Full movie pipeline (idea→publish) as a journaled-resumable workflow. Composes /research-first, /scene-assets, /review-cut.',
  phases: [
    { title: 'Init' }, { title: 'Idea' }, { title: 'Research+Proposal' },
    { title: 'Script' }, { title: 'Scene plan' }, { title: 'Assets' },
    { title: 'Edit' }, { title: 'Compose' }, { title: 'Publish' },
  ],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const concept = String(A.concept || A._ || '').trim()
if (!concept) throw new Error('produce-video: pass args.concept=<the idea>')
const pipeline = A.pipeline || 'animated-explainer'
const projectId = A.projectId || `wf-${concept.slice(0, 24).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`

phase('Init')
await call('movie.init-project', { projectId, pipeline })
log(`project: ${projectId} (${pipeline})`)

phase('Idea')
const idea = await agent(
  `Draft a one-paragraph idea brief for a short video about: ${concept}.`,
  { tier: 'medium', schema: { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'] }, label: 'idea-brief' },
)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'idea', status: 'in_progress', artifacts: { idea_brief: idea } })

phase('Research+Proposal')
const proposal = await workflow('research-first', { concept, projectId, pipeline })

phase('Script')
const script = await agent(
  `Write a production script for a short video about: ${concept}.\nProposal:\n${JSON.stringify(proposal)}\n` +
  `Return: sections[] (each {id, narration, durationSeconds}), top-level narration ('voiced'|'none'), and total_duration_seconds.`,
  {
    tier: 'big',
    schema: {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { type: 'object' } },
        narration: { type: 'string' },
        total_duration_seconds: { type: 'number' },
      },
      required: ['sections'],
    },
    label: 'write-script',
  },
)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'script', status: 'completed', artifacts: { script } })

phase('Scene plan')
const sectionById = new Map((script.sections || []).map((s) => [String(s.id), s]))
const scenePlan = await agent(
  `Break this script into scenes (one per section). Each scene MUST have: id, type ("generated"|"animation"|"broll"), ` +
  `description (a concrete visual prompt), start_seconds, end_seconds, and script_section_id (the matching section id).\n` +
  `Optionally add shot_language {shot_size, camera_movement, lighting_key} for richer visuals.\nScript:\n${JSON.stringify(script)}`,
  {
    tier: 'medium',
    schema: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' },
              start_seconds: { type: 'number' }, end_seconds: { type: 'number' }, script_section_id: { type: 'string' },
            },
            required: ['id', 'type', 'description', 'start_seconds', 'end_seconds'],
          },
        },
      },
      required: ['scenes'],
    },
    label: 'scene-plan',
  },
)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'scene_plan', status: 'completed', artifacts: { scene_plan: scenePlan } })

phase('Assets')
// Merge each scene's narration from its linked script section (scene_plan has no narration field).
const scenesWithNarration = scenePlan.scenes.map((sc) => {
  const sec = sc.script_section_id ? sectionById.get(String(sc.script_section_id)) : null
  return { ...sc, narration: sec?.narration ?? null }
})
await workflow('scene-assets', { projectId, pipeline, scenes: scenesWithNarration })

phase('Edit')
const cp = await call('movie.read-checkpoint', { projectId, pipeline, stage: 'assets' })
const editDecisions = cp?.checkpoint?.artifacts?.edit_decisions
if (!editDecisions || !Array.isArray(editDecisions.cuts)) throw new Error('assets stage produced no edit_decisions')
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'edit', status: 'completed', artifacts: { edit_decisions: editDecisions } })

phase('Compose')
const composed = await call('movie.compose-motion', {
  projectId,
  editDecisions,
  narrativeDurationSeconds: script.total_duration_seconds,
})
const mp4Path = composed?.outputPath || composed?.path || composed?.render_report?.outputPath
if (!mp4Path) throw new Error(`compose-motion produced no mp4 path: ${JSON.stringify(composed)}`)

phase('Publish')
const review = await workflow('review-cut', { mp4Path, script, projectId, pipeline, narration: script.narration })
if (review.verdict !== 'pass') throw new Error(`review-cut rejected the cut: ${JSON.stringify(review)}`)
await call('movie.write-checkpoint', { projectId, pipeline, stage: 'publish', status: 'completed' })

const cost = await call('movie.cost-snapshot', { projectId })
return { projectId, pipeline, mp4Path, review, cost }
