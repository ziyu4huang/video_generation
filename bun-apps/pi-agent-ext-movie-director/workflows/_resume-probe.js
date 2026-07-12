// _resume-probe.js — deterministic, model-free resume-replay probe (TEST-ONLY).
//
// Underscore-prefixed so the structural test (movie-workflows.test.ts) skips it:
// it uses call('test.*') refs that are NOT in the movie host-fn registry.
//
// Uses ONLY call() host-fns (no agent()) so it runs with a stub agent and zero
// tokens. Its result is a pure function of `steps`, so a resumed run — which
// replays cached call() results for the unchanged prefix — MUST deep-equal a
// clean run. That property IS the resume-correctness assertion.
export const meta = {
  name: 'resume-probe',
  description: 'deterministic resume-replay probe (test-only)',
  phases: [{ title: 'steps' }],
}

const A = (typeof args === 'object' && args !== null) ? args : {}
const N = (typeof A.steps === 'number' && A.steps > 0) ? A.steps : 4

const out = []
for (let i = 0; i < N; i++) {
  const r = await call('test.step', { id: i })
  out.push(r)
}
return out
