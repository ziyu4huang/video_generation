/**
 * Live-agent memory harness — cc-parity-2 ticket 01
 * (effort .planning/2026-08-23-subagent-cc-parity-2).
 *
 * Measures what K live in-process child sessions actually cost: drives the
 * REAL open path (`spawnLiveAgentFirstExchange` → `openLiveAgent` →
 * `CoreAgent.assembleSession` → `createAgentSession`) K=0..DEFAULT_MAX_LIVE
 * times, sampling `process.memoryUsage()` after each open, then once more
 * after a forced LRU eviction. Transport is the pi SDK's built-in faux
 * provider — zero network, zero API spend — so the numbers bound SESSION
 * OBJECT overhead only (tools, settings, event subscriptions, transcript),
 * not model/response size.
 *
 * Guarded: the probe only runs under `S2_MEM_PROBE=1`
 * (`S2_MEM_PROBE=1 bun test tests/memory-live-agents.test.ts`); CI never pays
 * for it. Without the env the file still passes — one always-on test pins the
 * guard predicate itself, so a typo in the env name cannot silently turn the
 * harness into dead code (the "silent exit-0" trap this repo guards against).
 *
 * The NUMBERS are logged as a table, never asserted (GC/allocator noise makes
 * byte-exact claims flake); only structural facts are asserted. Findings are
 * recorded in the effort map + spec §3 by hand after a probe run.
 *
 * Concurrency note: the probe mutates PI_CODING_AGENT_DIR for agentDir
 * isolation. Run it on this file alone (`bun test tests/memory-live-agents…`)
 * as the ticket prescribes — never alongside other files in the same process.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_LIVE, LiveAgentRegistry, spawnLiveAgentFirstExchange } from "@repo/s2-agent-core-runtime";

const PROBE_ENV = "S2_MEM_PROBE";

/**
 * The skipIf predicate, exported for its own always-on test. A typo here would
 * make the probe never run anywhere — the test below is the tripwire.
 */
export function shouldRunMemProbe(env: Record<string, string | undefined> = process.env): boolean {
  return env[PROBE_ENV] === "1";
}

test("guard: the probe runs only under S2_MEM_PROBE=1 (and the env name is not a typo)", () => {
  assert.equal(shouldRunMemProbe({}), false, "unset env must skip the probe");
  assert.equal(shouldRunMemProbe({ [PROBE_ENV]: "1" }), true, "S2_MEM_PROBE=1 must arm the probe");
  assert.equal(
    shouldRunMemProbe({ [PROBE_ENV]: "" }),
    false,
    "empty-string env (the `S2_MEM_PROBE= ./…` footgun) must NOT arm the probe",
  );
});

/** One memory sample. Full synchronous GC first so deltas are live objects, not garbage. */
function sample(): { rss: number; heapUsed: number; external: number } {
  Bun.gc(true);
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external };
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

test.skipIf(!shouldRunMemProbe())(
  "memory curve: K=0..DEFAULT_MAX_LIVE real live sessions + LRU eviction delta",
  { timeout: 120_000 },
  async () => {
    // Isolate agentDir (auth.json / models.json / settings / extensions) so the
    // probe never touches the real ~/.pi or loads the user's extensions.
    const agentDir = mkdtempSync(join(tmpdir(), "s2-mem-agentdir-"));
    const cwd = mkdtempSync(join(tmpdir(), "s2-mem-cwd-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Fake transport (usage-limit-integration.test.ts pattern): a private
    // provider id carrying the faux core's streamSimple directly.
    const core = createFauxCore({
      provider: "mem-probe",
      models: [{ id: "faux-probe-model", name: "Faux Probe", contextWindow: 128_000, maxTokens: 4096 }],
    });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    modelRuntime.registerProvider("mem-probe", {
      api: core.api as never,
      apiKey: "faux-not-used",
      streamSimple: core.streamSimple as never,
      models: core.models as never,
    });
    // The faux core consumes response steps POSITIONALLY (one per exchange, no
    // replay of a one-element list), so queue a factory at every slot — warmup +
    // CAP probes + the evictor = 8 exchanges; 32 slots is generous headroom.
    const reply = () => fauxAssistantMessage(`probe reply ${core.state.callCount}`, { stopReason: "stop" });
    core.setResponses(Array.from({ length: 32 }, () => reply) as never);

    const cap = DEFAULT_MAX_LIVE;
    const registry = new LiveAgentRegistry(cap);
    const rows: Array<{ k: string } & ReturnType<typeof sample>> = [];
    // BOTH halves of the fake transport: the runtime AND the faux model that
    // selects it. Passing only the runtime lets the session fall back to the
    // settings default model — a REAL model (caught on the first probe run:
    // replies came from the local LM Studio default, ~10s per exchange).
    const fauxSession = { model: core.getModel() as never, modelRuntime };

    try {
      // Warm the model-resolution path with one throwaway open/dispose so the
      // K=0 baseline does not absorb one-time module/init allocations.
      const warm = await spawnLiveAgentFirstExchange(
        { task: "warmup", cwd, session: fauxSession },
        { name: "mem-probe-warmup", agentId: "probe-warmup", registry },
      );
      assert.ok(warm.entry, "warmup exchange completed and registered");
      registry.release("mem-probe-warmup", "warmup");
      rows.push({ k: "0 (post-warmup baseline)", ...sample() });

      for (let k = 1; k <= cap; k++) {
        const { result, entry } = await spawnLiveAgentFirstExchange(
          { task: `memory probe ${k}`, cwd, session: fauxSession },
          { name: `mem-probe-${k}`, agentId: `probe-${k}`, registry },
        );
        assert.ok(entry, `agent ${k} registered`);
        assert.equal(result.failure, undefined, `agent ${k} first exchange must succeed`);
        assert.match(result.output, /probe reply/, `agent ${k} got the faux reply`);
        rows.push({ k: String(k), ...sample() });
      }
      assert.equal(registry.size, cap, "registry full at the cap");

      // One more open at a full cap of IDLE agents → LRU evicts mem-probe-1.
      const seventh = await spawnLiveAgentFirstExchange(
        { task: "memory probe 7 (evictor)", cwd, session: fauxSession },
        { name: "mem-probe-7", agentId: "probe-7", registry },
      );
      assert.ok(seventh.entry, "seventh agent registered via eviction");
      assert.equal(registry.size, cap, "size still capped after eviction");
      assert.equal(registry.get("mem-probe-1"), undefined, "the least-recently-touched agent was evicted");
      assert.equal(registry.get("mem-probe-7")?.agentId, "probe-7", "the evictor holds the slot");
      rows.push({ k: "post-evict (7th opened, 1st evicted)", ...sample() });

      // The table (hand-copied into spec §3 after a run — the assertion surface
      // stays structural on purpose; see the file header).
      const base = rows[0];
      console.log("\n=== live-agent memory curve (faux transport — session objects only) ===");
      for (const r of rows) {
        const marginal = r === base ? "" : `  (+${mb(r.rss - base.rss)} vs baseline)`;
        console.log(
          `K=${r.k.padEnd(32)} rss=${mb(r.rss).padStart(8)}  heapUsed=${mb(r.heapUsed).padStart(8)}  external=${mb(r.external).padStart(8)}${marginal}`,
        );
      }
      console.log("=== end memory curve ===\n");

      // Structural, GC-tolerant: holding `cap` real sessions must not be cheaper
      // than the empty baseline by any meaningful margin (16MB slack covers
      // allocator return / lazy-free noise; the real claim is the table above).
      assert.ok(
        rows[cap].rss > base.rss - 16 * 1024 * 1024,
        `rss at K=${cap} (${mb(rows[cap].rss)}) implausibly below baseline (${mb(base.rss)}) — probe is not measuring live sessions`,
      );
    } finally {
      registry.disposeFor("*");
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
