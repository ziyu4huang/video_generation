#!/usr/bin/env bun
/**
 * Goal 4 (P1) — LOCAL-MLX cache probe for workflow gating.
 * Companion to cache-probe-workflow.mjs (which proved zai's cloud multi-entry
 * cache → transitions ≈ free). The self-improve loops run on LOCAL
 * gemma-4-26b-a4b-qat via LM Studio, whose KV cache economics differ, so the
 * cloud win must NOT be assumed to generalize — measure before claiming it.
 *
 * Run: ( cd /Users/huangziyu/proj/video_generation__ext && bun run scripts/cache-probe-workflow-local.mjs )
 *
 * Sequence (identical user msg; only the system prompt toggles), measuring BOTH
 * reported cache fields (if any) and wall-clock latency (the robust signal for
 * a local single-entry KV cache, where a prefix miss = full recompute):
 *   A1  big prefix  (with workflow guidelines)   → cold compute
 *   A2  big prefix  (SAME)                        → warm hit (baseline fast)
 *   B1  small prefix (without guidelines)         → prefix changed
 *   B2  small prefix (SAME)                       → warm hit
 *   C1  big prefix again (after B2)               → TRANSITION (re-activate)
 *   C2  small prefix (back)                       → TRANSITION
 *   D1  big prefix AGAIN                          → TRANSITION (2nd time)
 *
 * If C1/D1 latency ≈ A2 (warm) → multi-entry cache → transitions ≈ free (matches cloud).
 * If C1/D1 latency ≈ A1 (cold) → single-entry cache → transitions cost a full recompute.
 */
const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
const MODEL = process.env.CACHE_PROBE_LOCAL_MODEL ?? "google/gemma-4-26b-a4b-qat";
const R = 3.7;
const tok = (s) => Math.round(s.length / R);

// Same guidelines block as the cloud probe (the workflow surface we gate on).
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
  "For workflow, the user configures per-tier models, so TAG EVERY agent with opts.tier by role: 'small' for lightweight exploration/search/inventory, 'medium' for balanced analysis, 'big' for synthesis/judgment/decision. opts.tier ('small'|'medium'|'big') is enforced at runtime.",
  "For workflow, advanced reference is NOT inlined here — call workflow_help({topic}) on demand: \"helpers\", \"budget\", \"phases\", \"patterns\", \"models\".",
].join("\n");

const BASE_SYS =
  "You are a coding assistant. Follow the user's instructions precisely and reply concisely.";
const USER_MSG = "Reply with exactly: ok";

const sysBig = BASE_SYS + "\n\n" + WF_GUIDELINES; // with workflow surface
const sysSmall = BASE_SYS; // without

async function call(label, system) {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: USER_MSG }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const ms = Math.round(performance.now() - t0);
  const data = await res.json();
  if (!res.ok) {
    console.error(`${label} ERROR ${res.status}:`, JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }
  const u = data.usage ?? {};
  const cacheRead = u.cacheRead ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const input = u.prompt_tokens ?? u.input ?? 0;
  const out = { label, ms, input, cacheRead, cacheWrite, sysTok: tok(system) };
  console.log(
    `  ${label.padEnd(4)} sys=${String(out.sysTok).padStart(4)}t  ${String(ms).padStart(5)}ms  input=${String(input).padStart(5)}  cacheRead=${String(cacheRead).padStart(5)}  cacheWrite=${String(cacheWrite).padStart(5)}`,
  );
  await new Promise((r) => setTimeout(r, 300));
  return out;
}

console.log(`╔══ Goal 4 (P1) LOCAL cache probe — model=${MODEL} ══╗`);
console.log(`   endpoint = ${BASE_URL}`);
console.log(`   workflow guidelines block = ${tok(WF_GUIDELINES)} tok (the surface we gate on)\n`);
console.log("── sequence (temperature 0, identical user msg; latency is the key signal) ──");
const A1 = await call("A1", sysBig); // cold
const A2 = await call("A2", sysBig); // warm (baseline fast)
const B1 = await call("B1", sysSmall);
const B2 = await call("B2", sysSmall); // warm small (baseline fast)
const C1 = await call("C1", sysBig); // transition small→big
const C2 = await call("C2", sysSmall); // back to small
const D1 = await call("D1", sysBig); // transition AGAIN

console.log("\n── measured local cache economics (latency-based) ──");
const warmBig = A2.ms;
const warmSmall = B2.ms;
const coldBig = A1.ms;
const transBig = C1.ms;
const transBig2 = D1.ms;
console.log(`   cold big (A1)            = ${coldBig}ms`);
console.log(`   warm big (A2)            = ${warmBig}ms   (baseline cache-hit speed)`);
console.log(`   warm small (B2)          = ${warmSmall}ms`);
console.log(`   transition→big C1        = ${transBig}ms`);
console.log(`   transition→big D1 (2nd)  = ${transBig2}ms`);

// Classify: is a transition ≈ warm (multi-entry / free) or ≈ cold (single-entry / costly)?
const warmAvg = (warmBig + warmSmall) / 2;
const transAvg = (transBig + transBig2) / 2;
const midpoint = (warmAvg + coldBig) / 2;
const multiEntry = transAvg < midpoint;
const freeRatio = (transAvg / warmAvg).toFixed(2);

console.log(`\n── VERDICT (local LM Studio / MLX) ──`);
console.log(`   transition latency / warm latency = ${freeRatio}x`);
if (multiEntry) {
  console.log("   • LOCAL cache retains the big prefix across small calls → transitions ≈ warm (MULTI-entry).");
  console.log("   • ⟹ Option A gate is net-positive locally too: transitions ≈ free, saves the full surface on non-workflow turns.");
} else {
  console.log("   • LOCAL cache is SINGLE-entry: a prefix flip recomputes (transition ≈ cold).");
  console.log("   • ⟹ Option A still wins WHEN non-workflow turns dominate (saves ~668t/turn, pays one recompute per workflow turn).");
  console.log("   • ⟹ But the self-improve loop's per-turn flips are costlier locally than on cloud — gate is a cloud win, a partial local win.");
}
console.log("\n   (Cloud probe cache-probe-workflow.mjs already confirmed multi-entry → free on zai.)");
