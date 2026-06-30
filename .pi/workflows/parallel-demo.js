/**
 * parallel-demo — minimal demonstration of pi dynamic workflows.
 *
 * Pattern: PARALLEL FAN-OUT → SYNTHESIS CONCLUSION
 *   Phase 1 (Research)  : N independent agents run in `parallel()`, each
 *                         investigating one angle of a single topic.
 *   Phase 2 (Conclude)  : one synthesis agent reads all N findings and writes
 *                         a single, coherent conclusion.
 *
 * This is the canonical "research a broad question across many subagents,
 * then conclude" shape. Swap the topic / angles in `args` to reuse it:
 *
 *   args = { topic: "Why is Bun fast?",
 *            angles: ["JavaScriptCore engine", "native bundler (zig)", "runtime APIs"] }
 *
 * Output: { ok, topic, findings[], conclusion }
 */
export const meta = {
  name: 'parallel-demo',
  description: 'Demo: fan a topic out across parallel research agents, then synthesize one conclusion',
  phases: [
    { title: 'Research', detail: 'N agents investigate one angle each, in parallel' },
    { title: 'Conclude', detail: 'one agent synthesizes all findings into a single conclusion' },
  ],
}

// ── args (the runtime may deliver args as a JSON string; normalize) ──────────
let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch { _args = {} }
}
const A = _args ?? {}

const TOPIC = A.topic ?? 'Why is Bun (the JavaScript runtime) fast compared to Node.js?'
const ANGLES = Array.isArray(A.angles) && A.angles.length > 0
  ? A.angles
  : ['the JavaScriptCore (JSC) engine heritage',
     'the native bundler / transpiler written in Zig',
     'the built-in, zero-config runtime APIs (fs, http, sqlite)']

log(`topic: ${TOPIC}`)
log(`angles: ${JSON.stringify(ANGLES)}`)

// ── Phase 1: parallel research ──────────────────────────────────────────────
phase('Research')

const findings = await parallel(
  ANGLES.map((angle, i) => () => agent(
    [
      `You are a concise technical researcher.`,
      `Question to answer: "${TOPIC}"`,
      ``,
      `Focus ONLY on this one angle: ${angle}.`,
      `Do NOT repeat the other angles — another agent covers them.`,
      ``,
      `Return 3-5 bullet points of concrete, accurate facts (mechanisms, not marketing).`,
      `Keep it under 120 words. Plain text bullets, one per line, prefixed with "- ".`,
    ].join('\n'),
    {
      label: `research-${i + 1}-${angle.split(' ')[0]}`,
      tier: 'small',
    },
  )),
)

const valid = findings.map((f, i) => ({
  angle: ANGLES[i],
  ok: typeof f === 'string' && f.trim().length > 0,
  text: typeof f === 'string' ? f.trim() : `(no output)`,
}))
const okCount = valid.filter(v => v.ok).length
log(`research done: ${okCount}/${valid.length} angles returned content`)

// ── Phase 2: synthesize one conclusion ──────────────────────────────────────
phase('Conclude')

const bundle = valid
  .map((v, i) => `### Angle ${i + 1}: ${v.angle}\n${v.text}`)
  .join('\n\n')

const conclusion = await agent(
  [
    `You are the lead engineer writing the final conclusion.`,
    `The original question was:`,
    `"${TOPIC}"`,
    ``,
    `Three junior researchers each investigated one angle. Here are their raw notes:`,
    ``,
    bundle,
    ``,
    `Synthesize these into ONE coherent conclusion (150-250 words):`,
    `- Lead with the single most important reason.`,
    `- Weave in supporting facts from the other angles.`,
    `- Resolve any contradictions; prefer the technically correct view.`,
    `- End with a one-sentence takeaway.`,
  ].join('\n'),
  {
    label: 'synthesize-conclusion',
    tier: 'medium',
  },
)

const result = {
  ok: okCount === valid.length,
  topic: TOPIC,
  angles: valid.length,
  findings: valid,
  conclusion: typeof conclusion === 'string' ? conclusion.trim() : '(synthesis produced no output)',
}

log(`conclusion ready (${result.conclusion.length} chars)`)
return result
