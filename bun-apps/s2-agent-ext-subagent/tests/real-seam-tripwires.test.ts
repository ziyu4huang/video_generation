/**
 * Real-seam tripwires for the two subagent seams whose production chains were
 * only ever exercised through fakes (issue #2081) — the bridge-tripwire
 * pattern (s2-agent/src/patches/ext-api-bridge-tripwire.test.ts precedent):
 * drive the REAL installed SDK end-to-end so a pi upgrade that re-shapes the
 * surface fails HERE, loudly, instead of silently in production.
 *
 * Why every earlier test missed these (the 2026-08-26/27 wave's lesson —
 * #2067/#2069/#2070 all passed the full unit matrix):
 *
 *   A. fork transcript — fork-subagent.test.ts injects
 *      `getParentTranscript: () => TRANSCRIPT_BLOCK` and core-runtime's
 *      fork-transcript.test.ts feeds hand-built SessionEntry fixtures. NO
 *      test drives the real producer: a real SessionManager (its
 *      appendMessage/appendCompaction entry shapes) through the PRODUCTION
 *      getter (src/fork-transcript-getter.ts — the exact closure the
 *      extension entry wires) into buildForkTranscript.
 *
 *   B. session-model injection — agent-model-spec.test.ts pins the pure
 *      predicate; core-runtime's harness cannot inject createAgentSession at
 *      all (agent-turns.test.ts:290). The composition in
 *      CoreAgent.assembleSession (untagged spawn + tier config → registry
 *      resolution → createAgentSession spread override) is the part that
 *      actually regressed in cc-parity-2 t01: "children ran the real LM
 *      Studio default instead of the faux transport". This tripwire runs the
 *      REAL assembleSession → createAgentSession with an injected faux
 *      session model against a tier model that resolves through the REAL
 *      file-backed registry (temp agentDir models.json) — if the guard or
 *      its composition regresses, the tier model wins and the assertion goes
 *      red.
 *
 * Both tripwires are offline (faux transport; no prompt is ever sent) and
 * always-on — each costs one session assembly.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { CoreAgent, FORK_TRANSCRIPT_HEADER } from "@repo/s2-agent-core-runtime";
import { createParentTranscriptGetter } from "../src/fork-transcript-getter.js";

// ─────────────────────────────────────────────────────────────────────────────
// A. fork transcript — real SessionManager → production getter → projection
// ─────────────────────────────────────────────────────────────────────────────

test("tripwire A: the production getter projects a REAL SessionManager conversation", () => {
  // A real in-memory session, built through the manager's PUBLIC append API —
  // the entry shapes (ids, parent chain, compaction bookkeeping) are the
  // SDK's own, not fixtures. An SDK re-shape of appendMessage/appendCompaction
  // or of getEntries()/getLeafId() fails right here.
  const sm = SessionManager.inMemory("/tripwire");
  sm.appendMessage({ role: "user", content: "please fix the login bug" } as never);
  const assistantTurn1 = sm.appendMessage(fauxAssistantMessage("reading auth.ts now", { stopReason: "stop" }) as never);
  // One assistant turn carrying tool-call content: the projection exists to
  // drop exactly this noise, on the real entry shape.
  sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "calling the read tool" },
      { type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "auth.ts" } },
    ],
    usage: { cost: 0, tokensIn: 0, tokensOut: 0 },
  } as never);
  // A real compaction: everything up to `firstKeptEntryId` is summarized
  // away — firstKept = the tool-call turn, so the first user turn survives
  // only through the summary.
  sm.appendCompaction("located the login bug in auth.ts line 40", assistantTurn1, 5_000);
  sm.appendMessage({ role: "user", content: "also check the tests" } as never);
  const leaf = sm.appendMessage(fauxAssistantMessage("tests pass now", { stopReason: "stop" }) as never);
  assert.equal(sm.getLeafId(), leaf, "leaf advanced to the last append (SDK sanity)");

  // The PRODUCTION getter — the same function the extension entry wires
  // (extensions/subagent.ts), driven over the real manager.
  const getter = createParentTranscriptGetter({ current: sm });
  const block = getter();
  assert.ok(block, "a conversation with projectable text renders a block");
  assert.ok(block.startsWith(FORK_TRANSCRIPT_HEADER), "block carries the context-only header");
  // Compaction-aware: the kept tail projects, the summarized head does not.
  assert.match(block, /also check the tests/);
  assert.match(block, /tests pass now/);
  assert.match(block, /located the login bug in auth\.ts line 40/);
  assert.doesNotMatch(block, /please fix the login bug/, "pre-compaction turn is summarized away, not projected");
  // Text-only: the tool-call surface (name, id, arguments) never reaches the
  // child — though file names inside TEXT (the summary, the assistant's own
  // words) legitimately do.
  assert.doesNotMatch(block, /read_file/);
  assert.doesNotMatch(block, /tc1/);

  // No sessionManager captured → undefined (fork fails pre-flight in the
  // tool; never a silent empty inheritance).
  assert.equal(createParentTranscriptGetter({ current: undefined })(), undefined);

  // The cap is honored at call time via the env override: a tiny cap keeps
  // the newest turns and marks what was dropped.
  const prevCap = process.env.SUBAGENT_FORK_TRANSCRIPT_CAP;
  process.env.SUBAGENT_FORK_TRANSCRIPT_CAP = "80";
  try {
    const capped = getter();
    assert.ok(capped);
    assert.ok(
      capped.length <= 80 + FORK_TRANSCRIPT_HEADER.length,
      `capped block stays within the cap (${capped.length})`,
    );
    assert.match(capped, /\[\.\.\. earlier turns truncated \.\.\.\]/);
  } finally {
    if (prevCap === undefined) delete process.env.SUBAGENT_FORK_TRANSCRIPT_CAP;
    else process.env.SUBAGENT_FORK_TRANSCRIPT_CAP = prevCap;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B. session-model injection — real CoreAgent.assembleSession composition
// ─────────────────────────────────────────────────────────────────────────────

test("tripwire B: an untagged spawn with an injected session model lands on the INJECTED model, not the tier model", async () => {
  // Isolated agentDir: PI_CODING_AGENT_DIR drives getAgentDir() for BOTH the
  // file-backed registry (getRegistry → ModelRuntime.create over
  // agentDir/models.json) and SettingsManager — the run never touches the
  // real ~/.pi.
  const agentDir = mkdtempSync(join(tmpdir(), "tripwire-agentdir-"));
  const cwd = mkdtempSync(join(tmpdir(), "tripwire-cwd-"));
  // The tier model resolves through the REAL file-backed registry — this is
  // what makes the tripwire red-capable: with the guard regressed, the
  // untagged default-medium branch resolves THIS model and the
  // createAgentSession spread override defeats the injection (the exact
  // cc-parity-2 t01 failure shape). baseUrl points at a dead port; assembly
  // never sends a prompt, so it is never contacted.
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        tierprov: {
          name: "Tripwire Tier Prov",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "unused",
          models: [{ id: "tier-model", name: "Tier Model", contextWindow: 128_000, maxTokens: 4_096 }],
        },
      },
    }),
  );
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  // try starts IMMEDIATELY after the env mutation: the setup below (faux
  // core, ModelRuntime.create, registerProvider, CoreAgent) is exactly the
  // SDK surface this tripwire exists to catch drifting — when one of those
  // throws, the env must still be restored and the temp dirs removed, or the
  // red cascades confusingly into every later getAgentDir() reader in this
  // process (reviewer nit on 2763ec34).
  try {
    // The injected model: a faux provider on the SESSION runtime (the
    // memory-live-agents harness pattern — both halves: runtime AND model).
    const core = createFauxCore({
      provider: "fauxprov",
      models: [{ id: "injected-model", name: "Injected", contextWindow: 128_000, maxTokens: 4_096 }],
    });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    modelRuntime.registerProvider("fauxprov", {
      api: core.api as never,
      apiKey: "faux-not-used",
      streamSimple: core.streamSimple as never,
      models: core.models as never,
    });

    // The dangerous configuration: an ACTIVE tier config (untagged spawns
    // resolve default-medium) + an injected session model + no per-call
    // model/tier. Forced through the same constructor seam production uses.
    const agent = new CoreAgent({
      cwd,
      tools: [],
      session: { model: core.getModel() as never, modelRuntime: modelRuntime as never },
      loadTierConfig: () => ({ tiers: { medium: "tierprov/tier-model" } }),
    });

    const { session } = await agent.assembleSession({});
    const landed = `${(session.model as { provider: string }).provider}/${(session.model as { id: string }).id}`;
    assert.equal(landed, "fauxprov/injected-model", "the injected session model must win over tier resolution");
    session.dispose();

    // Negative control, same real chain: an EXPLICIT per-call model is the
    // more specific choice and must still win over the injection — through
    // the real file-backed registry, proving that registry resolves.
    const explicit = await agent.assembleSession({ model: "tierprov/tier-model" });
    const explicitLanded = `${(explicit.session.model as { provider: string }).provider}/${(explicit.session.model as { id: string }).id}`;
    assert.equal(
      explicitLanded,
      "tierprov/tier-model",
      "explicit per-call model beats the injection and resolves via the file-backed registry",
    );
    explicit.session.dispose();
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
