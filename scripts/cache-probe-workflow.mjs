#!/usr/bin/env bun
/**
 * Goal 4 — empirical cache probe + analytical break-even for workflow gating.
 * Run: ( cd /Users/huangziyu/proj/video_generation__ext && ZAI_API_KEY=$ZAI_API_KEY bun run scripts/cache-probe-workflow.mjs )
 *
 * Question: does removing the workflow tool's always-on surface (~722t guidelines
 * in the system prompt; 1535t total incl. tool schema) cost more in cache-miss
 * reprocessing than it saves? Measures the REAL zai prefix-cache behavior.
 *
 * Sequence (identical user msg; only the system prompt toggles):
 *   A1  big prefix  (with workflow guidelines)   → expect cacheWrite (cold)
 *   A2  big prefix  (SAME)                        → expect cacheRead  (warm) = always-on steady state
 *   B1  small prefix (without guidelines)         → prefix changed → cacheWrite
 *   B2  small prefix (SAME)                       → cacheRead = gated steady state
 *   C1  big prefix again (after B2)               → TRANSITION (re-activate) cost
 */
// No import — the guidelines text is inlined VERBATIM from buildSimplifiedGuidelines()
// (avoids pulling the SDK + typebox across package boundaries from scripts/).
const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const MODEL = process.env.CACHE_PROBE_MODEL ?? "glm-4.5-flash"; // cheap text model
const R = 3.7;
const tok = (s) => Math.round(s.length / R);

if (!API_KEY) { console.error("ZAI_API_KEY not set"); process.exit(1); }

// The real always-on workflow guidelines (exact 12 bullets, ~722t system-prompt tax).
const WF_GUIDELINES = [
  "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
  "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
  "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
  "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
  "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, and budget. Every workflow must call agent() at least once.",
  "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
  "For workflow, failed agent(), parallel(), or pipeline() branches return null — always filter nulls before synthesizing conclusions.",
  "For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; the defaults are unbounded.",
  "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
  "For workflow, runs are background by default: the tool returns immediately with a run ID, and the result is delivered back into the conversation when it finishes. Pass background: false only when you must use the result inline in this same turn.",
  "For workflow, the user configures per-tier models, so TAG EVERY agent with opts.tier by role: 'small' for lightweight exploration/search/inventory, 'medium' for balanced analysis, 'big' for synthesis/judgment/decision. opts.tier ('small'|'medium'|'big') is enforced at runtime. If the user named a specific model, pass it verbatim as opts.model (provider/id); opts.model always overrides opts.tier. An agent with neither falls back to the user's medium tier — don't rely on that, tag explicitly. Call workflow_help({topic:\"models\"}) for the exact list of currently-available model IDs.",
  "For workflow, advanced reference is NOT inlined here — call workflow_help({topic}) on demand: \"helpers\" (verify/judgePanel/loopUntilDry/completenessCheck), \"budget\" (tokenBudget/phase budget/retry/gate), \"phases\" (phase() tracking), \"patterns\" (pipeline()/opts.schema/synthesis), \"models\" (full available-model list).",
].join("\n");

const BASE_SYS =
  "You are a coding assistant. Follow the user's instructions precisely and reply concisely.";
const USER_MSG = "Reply with exactly: ok";

const sysBig = BASE_SYS + "\n\n" + WF_GUIDELINES;   // with workflow surface
const sysSmall = BASE_SYS;                            // without

async function call(label, system) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: USER_MSG }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(`${label} ERROR ${res.status}:`, JSON.stringify(data).slice(0, 300)); process.exit(1); }
  // zai reports cacheRead/cacheWrite flat in usage (seen: cacheRead:65536). Also handle OpenAI nested shape.
  const u = data.usage ?? {};
  const cacheRead = u.cacheRead ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const input = u.prompt_tokens ?? u.input ?? 0;
  const out = { label, input, cacheRead, cacheWrite, output: u.output ?? u.completion_tokens ?? 0, sysTok: tok(system) };
  console.log(
    `  ${label.padEnd(4)} sys=${String(out.sysTok).padStart(4)}t  input=${String(input).padStart(5)}  cacheRead=${String(cacheRead).padStart(5)}  cacheWrite=${String(cacheWrite).padStart(5)}`,
  );
  // tiny pause to let cache settle
  await new Promise((r) => setTimeout(r, 400));
  return out;
}

console.log(`╔══ Goal 4 cache probe — model=${MODEL}, endpoint=zai ══╗`);
console.log(`   workflow guidelines block = ${tok(WF_GUIDELINES)} tok (the always-on system-prompt tax)`);
console.log(`   (full workflow surface incl. tool schema = 1535 tok — scale analytically)\n`);
console.log("── sequence (temperature 0, identical user msg) ──");
const A1 = await call("A1", sysBig);
const A2 = await call("A2", sysBig);
const B1 = await call("B1", sysSmall);
const B2 = await call("B2", sysSmall);
const C1 = await call("C1", sysBig);   // transition small→big
const C2 = await call("C2", sysSmall); // back to small
const D1 = await call("D1", sysBig);   // transition small→big AGAIN
const D2 = await call("D2", sysSmall); // back to small

// ── derive real cache economics from the probe ──
const steadyReadBig = A2.cacheRead;        // tokens served from cache at steady state (big)
const steadyReadSmall = B2.cacheRead;      // (small)
const surfaceServedFromCache = Math.max(0, steadyReadBig - steadyReadSmall); // ≈ workflow surface cached

console.log("\n── measured cache economics ──");
console.log(`   steady-state cacheRead (big prefix)    = ${steadyReadBig} tok`);
console.log(`   steady-state cacheRead (small prefix)  = ${steadyReadSmall} tok`);
console.log(`   workflow surface served from cache     ≈ ${surfaceServedFromCache} tok/turn (always-on re-reads this every turn)`);
console.log(`   transitions C1/D1 cacheWrite           = ${C1.cacheWrite} / ${D1.cacheWrite} tok`);
console.log(`   transitions C1/D1 cacheRead (re-activate)= ${C1.cacheRead} / ${D1.cacheRead} tok`);
const multiEntry = C1.cacheRead > steadyReadBig * 0.8 && D1.cacheRead > steadyReadBig * 0.8;
console.log(`   multi-entry cache detected (big stays cached across small calls)? ${multiEntry ? "YES ⚠️ → transitions ≈ FREE" : "no (single-entry; transitions cost cacheWrite)"}`);

// ── analytical break-even ──
// Provider rates (OpenAI-compat typical): cacheRead ≈ 0.1-0.5× input, cacheWrite ≈ 1.25× input.
// Gating saves the surface on every non-workflow turn; pays a transition (cacheWrite) on each flip.
// Break-even: (non-workflow turns) / (transitions) > cacheWrite_rate / cacheRead_rate.
const RATES = [
  { name: "conservative", rRead: 0.5, rWrite: 1.25 },
  { name: "typical", rRead: 0.25, rWrite: 1.25 },
  { name: "aggressive", rRead: 0.1, rWrite: 1.25 },
];
const surface = 1535; // full workflow surface (Option B deactivate)
console.log(`\n── analytical break-even (full surface = ${surface}t, Option B deactivate) ──`);
console.log("   gating WINS when  (non-workflow turns per intent-flip)  >  ratio");
for (const r of RATES) {
  const ratio = (r.rWrite / r.rRead).toFixed(1);
  console.log(`   ${r.name.padEnd(12)} cacheRead=${r.rRead}× cacheWrite=${r.rWrite}×  →  ratio ${ratio}   (need >${ratio} non-wf turns per flip)`);
}
console.log("\n── VERDICT ──");
if (multiEntry) {
  console.log("   • zai retains MULTIPLE prefix variants in cache (C1/D1 got full cacheRead after small calls, cacheWrite=0).");
  console.log("   • ⟹ The cache-invalidation risk that motivated Goal 4 is MOOT on cloud: transitions cost ≈ 0.");
  console.log("   • ⟹ Gating is net-positive with NO real downside on cloud: saves the full surface on every non-workflow turn.");
  console.log("   • ⚠️ LOCAL models (LM Studio/MLX) use a single-entry KV cache → transitions MAY cost more; needs a separate local probe.");
} else {
  console.log("   • Cache is single-entry; transitions cost a cacheWrite. Gating wins when non-wf turns/flip > the ratios above.");
}
