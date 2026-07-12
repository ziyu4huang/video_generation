/**
 * /review-cut — adversarial review of a composed cut. Runs the deterministic
 * movie.final-review probe, then verify() the cut against the script intent.
 * verdict pass/fail gates publish. Uses verify() (known signature from the
 * kcard sample); judgePanel is an optional alternative.
 */
export const meta = {
  name: 'review-cut',
  description: 'Adversarial review of a composed cut: movie.final-review probe + verify() against the script. Gates publish.',
  phases: [{ title: 'Probes' }, { title: 'Adversarial review' }, { title: 'Verdict' }],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = (typeof A === 'object' && A !== null) ? A : {}

const mp4Path = String(A.mp4Path || '')
if (!mp4Path) throw new Error('review-cut: pass args.mp4Path=<path to composed mp4>')
const script = A.script
const projectId = A.projectId
const pipeline = A.pipeline || 'animated-explainer'
const transcriptPath = A.transcriptPath
const narration = A.narration // 'voiced' | 'none' | undefined

phase('Probes')
const fr = await call('movie.final-review', {
  mp4Path,
  ...(transcriptPath ? { transcriptPath } : {}),
  ...(narration ? { narration } : {}),
})
log(`final-review verdict: ${fr?.verdict}`)

phase('Adversarial review')
const verified = await verify(
  { mp4Path, script, finalReview: fr },
  {
    reviewers: 3,
    threshold: 0.66,
    lens: `Does this cut fulfill the script's intent? Watch for: frozen-frame padding, narration/visual mismatch, pacing problems, missing scenes. The deterministic final-review verdict was "${fr?.verdict}". Default real=false (i.e. the cut is bad) if you spot any of those problems.`,
  },
)
log(`adversarial: cut-ok=${verified?.real} (${verified?.realCount}/${verified?.total})`)

phase('Verdict')
const pass = fr?.verdict === 'pass' && verified?.real === true
const result = { verdict: pass ? 'pass' : 'fail', finalReview: fr, adversarial: verified }
if (projectId) {
  await call('movie.write-checkpoint', { projectId, pipeline, stage: 'compose', status: 'completed', review: result })
}
return result
