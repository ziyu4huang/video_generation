/**
 * /research-first — research a concept across the web (parallel angles),
 * cross-check with verify(), then synthesize a proposal_packet. Writes the
 * proposal checkpoint when projectId is given. Uses web_search (the run is
 * given web tools by movie-workflows.ts, like /deep-research).
 */
export const meta = {
  name: 'research-first',
  description: 'Web research (parallel angles) + adversarial cross-check → proposal_packet for the movie pipeline.',
  phases: [{ title: 'Research' }, { title: 'Cross-check' }, { title: 'Proposal' }, { title: 'Checkpoint' }],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const concept = String(A.concept || A._ || '').trim()
if (!concept) throw new Error('research-first: pass args.concept=<the idea>')
const projectId = A.projectId
const pipeline = A.pipeline || 'animated-explainer'

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    angle: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings'],
}

phase('Research')
const angles = Array.isArray(A.angles) && A.angles.length
  ? A.angles
  : ['visual style references', 'subject matter background', 'audience and tone', 'comparable examples']
const raw = await parallel(angles.map((ang) => () =>
  agent(
    `Research the video concept "${concept}" focused on: ${ang}. Use web_search with 2-3 varied-query angles. ` +
    `Return concise bullet findings plus the source URLs you actually used.`,
    { tier: 'medium', schema: FINDINGS_SCHEMA, label: `research-${String(ang).slice(0, 20)}` },
  ),
))

phase('Cross-check')
const verified = await verify(
  { concept, angles: raw },
  { reviewers: 3, threshold: 0.66, lens: `For the concept "${concept}": are the findings on-topic and the sources real/non-duplicated? Default real=false if a finding is off-topic or a source looks fabricated.` },
)
log(`cross-check: trustworthy=${verified?.real} (${verified?.realCount}/${verified?.total})`)

phase('Proposal')
const proposal = await agent(
  `Synthesize a production proposal for a SHORT video about: ${concept}.\n` +
  `Use these verified research findings (trustworthy=${verified?.real}):\n${JSON.stringify(raw)}\n` +
  `Return: title, logline, target_duration_seconds, visual_style, tone, and key_scenes (3-5 items; each with id, prompt, durationSeconds, narration).`,
  {
    tier: 'big',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        logline: { type: 'string' },
        target_duration_seconds: { type: 'number' },
        visual_style: { type: 'string' },
        tone: { type: 'string' },
        key_scenes: { type: 'array', items: { type: 'object' } },
      },
      required: ['title', 'logline', 'key_scenes'],
    },
    label: 'synthesize-proposal',
  },
)

phase('Checkpoint')
if (projectId) {
  await call('movie.write-checkpoint', {
    projectId, pipeline, stage: 'proposal', status: 'completed',
    artifacts: { proposal_packet: proposal },
  })
  log(`wrote proposal checkpoint for ${projectId}`)
}
return proposal
