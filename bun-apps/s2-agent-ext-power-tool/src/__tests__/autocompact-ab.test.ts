/**
 * autocompact A/B harness — real AgentSession + ScriptedProvider (no network).
 * Spec: .planning/specs/2026-08-30-autocompact-ab-harness-design.md
 * Arms S1–S4 + validity gate live in Task 4; this file grows task by task.
 *
 * Reality fixes applied in Task 1 Step 2 (first run failed with
 * `apiKey.resolve is not a function`):
 *  - ProviderAuth is `{ apiKey: { name, resolve } }`, not
 *    `{ type: "apiKey", apiKey: "..." }`; resolve must return an AuthResult.
 *  - The session streams through `modelRuntime.streamSimple`, so the provider
 *    needs BOTH `stream` and `streamSimple`.
 *  - The terminal stream event is `{ type: "done", reason, message }` —
 *    there is no `message_end` AssistantMessageEvent — and `start` requires
 *    `partial`. `s.end(message)` stays last (it feeds `response.result()`).
 *  - AssistantMessage requires content BLOCKS, `api`/`provider`/`model`,
 *    `timestamp`, and a Usage with `totalTokens` + `cost`.
 *  - `model: SCRIPTED_MODEL` needed no setModel-in-factory workaround: the
 *    option is taken as-is and the factory-time registerProvider is flushed
 *    into the session's modelRuntime when the extension runner binds.
 *
 * Reality fixes applied in Task 2 (brief's sketch vs 0.84.4 dist):
 *  - AssistantMessage has NO `toolCalls` field — a tool call IS a content
 *    block `{ type: "toolCall", id, name, arguments }` (pi-ai types.d.ts:309),
 *    so ScriptedMessage carries `toolCall` and toAssistantMessage appends it
 *    to `content`.
 *  - Compaction summarizer calls are detected via `context.systemPrompt` —
 *    upstream builds `{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages:
 *    [user] }` (compaction.js:475-486), so `messages[0].role === "system"`
 *    from the brief can never fire. The default agent system prompt contains
 *    no "summar*" substring (core/system-prompt.js), so this cannot
 *    false-positive on normal turns.
 *  - `toAssistantMessage` sets totalTokens to input+output+cacheRead+cacheWrite
 *    (Task 1 used input+output): calculateContextTokens prefers totalTokens
 *    (compaction.js:86-87), and the usage curve puts live tokens in cacheWrite,
 *    so the old sum silently dropped 100 tokens off every curve point.
 *
 * Reality fixes applied in Task 3 (brief's sketch vs 0.84.4 dist):
 *  - createAgentSession IGNORES the resourceLoader's agentDir: with only
 *    `resourceLoader` given it builds its own SettingsManager over
 *    getDefaultAgentDir() (~/.pi/agent) (sdk.js), so a settings.json written
 *    into the arm's agentDir was silently unread — reserveTokens stayed at the
 *    16384 default. Fix: build `SettingsManager.create(agentDir, agentDir)`
 *    (what the loader would build internally) and pass that ONE manager to
 *    BOTH the loader and createAgentSession, so the arm's settings.json wins.
 *  - Compaction silently no-ops while it fits in keepRecentTokens:
 *    findCutPoint budgets by CONTENT-estimated tokens (compaction.js:316-333),
 *    not scripted usage, and the 20k default exceeds the whole ~9k script
 *    content → prepareCompaction finds nothing to summarize → returns
 *    undefined → _runAutoCompaction returns false with no event. Fix: the arm
 *    sets keepRecentTokens: 2_000 alongside reserveTokens.
 *  - ctx.getContextUsage() is null BY DESIGN at session_compact time (it
 *    returns null until an assistant responds after the compaction boundary —
 *    agent-session.js getContextUsage), so the recorder's compact row falls
 *    back to the event payload's compactionEntry.tokensBefore (which IS
 *    usage-backed: 64_000 / 71_000 in the observed run).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, defineTool, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import powerToolFactory from "../index.ts";
import { resetAutocompact, setThreshold } from "../autocompact.ts";

/** The scripted model every arm of the A/B harness runs on. */
export function makeScriptedModel(): Model<Api> {
  return {
    id: "scripted-1",
    name: "Scripted 1",
    provider: "scripted",
    api: "scripted",
    baseUrl: "scripted://local", // never fetched — the api object intercepts
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/** What each scripted turn says; the envelope (api/provider/model/timestamp/
 *  full usage) is filled in by toAssistantMessage. */
export interface ScriptedMessage {
  content: string;
  stopReason: "stop" | "toolUse";
  /** Optional tool call, appended as a `toolCall` content block —
   *  AssistantMessage has no separate toolCalls field (see header). */
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function toAssistantMessage(scripted: ScriptedMessage): AssistantMessage {
  const u = scripted.usage;
  return {
    role: "assistant",
    content: [
      { type: "text", text: scripted.content },
      ...(scripted.toolCall
        ? [{
            type: "toolCall" as const,
            id: scripted.toolCall.id,
            name: scripted.toolCall.name,
            arguments: scripted.toolCall.arguments,
          }]
        : []),
    ],
    api: "scripted",
    provider: "scripted",
    model: "scripted-1",
    usage: {
      ...u,
      // calculateContextTokens prefers totalTokens (compaction.js:86-87), so
      // this MUST be the same four-field sum its fallback would compute —
      // otherwise the scripted curve and the compaction decision diverge.
      totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: scripted.stopReason,
    timestamp: Date.now(),
  };
}

function emitScripted(message: AssistantMessage) {
  const s = createAssistantMessageEventStream();
  queueMicrotask(() => {
    s.push({ type: "start", partial: message });
    s.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    s.end(message); // feeds response.result() in the agent loop
  });
  return s;
}

function makeScriptedProvider(respond: (context: Context) => ScriptedMessage) {
  return createProvider({
    id: "scripted",
    name: "scripted",
    auth: {
      apiKey: {
        name: "Scripted (test)",
        resolve: async () => ({ auth: { apiKey: "scripted" }, source: "scripted-test" }),
      },
    },
    models: [makeScriptedModel()],
    api: {
      stream: (_model, context) => emitScripted(toAssistantMessage(respond(context))),
      streamSimple: (_model, context) => emitScripted(toAssistantMessage(respond(context))),
    },
  });
}

// ─── Task 2: usage-curve script, emit_blob tool, summarizer lane ─────────────

/** One scripted turn; stopReason is derived (toolCall present → "toolUse"). */
interface ScriptStep {
  content: string;
  toolCall?: { args: { size: number } };
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Context tokens after each scripted assistant response. input is
 *  `contextTokens - 500` and cacheWrite is 100, so the four-field usage sum
 *  (what calculateContextTokens reads — see toAssistantMessage) lands exactly
 *  on each value below: the compaction decision curve is scripted to the token. */
const USAGE_CURVE = [5_000, 12_000, 20_000, 30_000, 42_000, 55_000, 63_000, 70_000] as const;
const BLOB_SIZE = 4_000; // large tool result = #6879 trigger condition

/** All 8 curve points carry a tool call — "8 tool loops ... then a final
 *  text-only step" per the brief. (The brief's literal `i < length - 1` leaves
 *  FINAL_STEP unreachable: the 8th step would already end the turn with
 *  stopReason "stop" — verified by the first GREEN run, which stopped at 8
 *  assistant messages and never consumed FINAL_STEP.) */
export const PROVOCATION_SCRIPT: ScriptStep[] = USAGE_CURVE.map((contextTokens, i) => ({
  content: `step ${i}`,
  toolCall: { args: { size: BLOB_SIZE } },
  usage: { input: contextTokens - 500, output: 400, cacheRead: 0, cacheWrite: 100 },
}));

/** The final turn after the loop: still 70k context so a boundary compaction
 *  check (agent-session.js:895) sees the peak, but no tool call. */
export const FINAL_STEP: ScriptStep = {
  content: "done",
  usage: { input: 70_000, output: 100, cacheRead: 0, cacheWrite: 0 },
};

/** Compaction summarizer detection — see header for why this discriminates on
 *  systemPrompt, not messages[0].role. */
function isSummarizerCall(context: Context): boolean {
  return (context.systemPrompt ?? "").toLowerCase().includes("summar");
}

/** Fixed response for summarizer calls: small usage so a post-compaction
 *  context reads far below every threshold in every arm. */
const SUMMARIZER_RESPONSE: ScriptedMessage = {
  content: "[A/B summary] compacted",
  stopReason: "stop",
  usage: { input: 1_500, output: 100, cacheRead: 0, cacheWrite: 0 },
};

/** Cursor-based provider over a fixed script. Normal turns pop steps —
 *  running past the end throws loudly instead of silently repeating. */
export function makeScriptedProviderFromScript(script: ScriptStep[]): Provider<Api> {
  let cursor = 0;
  return makeScriptedProvider((context) => {
    if (isSummarizerCall(context)) return SUMMARIZER_RESPONSE;
    const step = script[cursor];
    if (step === undefined) {
      throw new Error(`script exhausted: request ${cursor} of ${script.length} steps`);
    }
    cursor += 1;
    return {
      content: step.content,
      stopReason: step.toolCall ? "toolUse" : "stop",
      toolCall: step.toolCall
        ? { id: `call-${cursor - 1}`, name: "emit_blob", arguments: step.toolCall.args }
        : undefined,
      usage: step.usage,
    };
  });
}

export const EMIT_BLOB_TOOL = defineTool({
  name: "emit_blob",
  label: "Emit Blob",
  description: "Returns a blob of the requested size (A/B harness).",
  parameters: Type.Object({
    size: Type.Number({ description: "blob length in chars" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text" as const, text: "x".repeat(params.size) }],
    details: null,
  }),
});

export interface SmokeSessionOptions {
  /** JSON written to `agentDir/settings.json` before the session is created —
   * global settings for the arm (Task 3+: compaction.reserveTokens is how a
   * threshold arm scripts its auto-compaction point). */
  settings?: Record<string, unknown>;
  /** Extra extensions loaded alongside the scripted provider (Task 3's
   *  recorder, the real power-tool factory, ...). */
  extensions?: InlineExtension[];
  /** The scripted responses; defaults to one plain "smoke" turn. */
  respond?: (context: Context) => ScriptedMessage;
  /** A complete scripted provider (Task 2+); overrides `respond` when given. */
  provider?: Provider<Api>;
  /** Custom tools registered in addition to the built-ins (emit_blob, ...). */
  customTools?: ToolDefinition[];
}

export interface SmokeSession {
  session: AgentSession;
  agentDir: string;
  /** Extension-load failures — the loader records these instead of
   *  throwing, so a factory that dies mid-load would otherwise be silent. */
  extensionErrors: string[];
  dispose: () => Promise<void>;
}

/** One hermetic real AgentSession on the scripted provider — the seed every
 *  later task's test grows from. File-backed sessions under a tmp agentDir,
 *  so auto-compaction bookkeeping (Task 4) lands on the real session file.
 *
 *  HOME is redirected to a tmp dir for the session's lifetime and restored by
 *  dispose(): extensions that touch homedir() (power-tool's session_start env
 *  sidecar under ~/.pi/agent/power-tool) stay hermetic for every caller. */
export async function smokeSession(options: SmokeSessionOptions = {}): Promise<SmokeSession> {
  const agentDir = await mkdtemp(join(tmpdir(), "ac-ab-"));
  const homeDir = await mkdtemp(join(tmpdir(), "ac-ab-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  const restoreHome = () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  };
  try {
    if (options.settings !== undefined) {
      await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(options.settings, null, 2)}\n`);
    }
    const scriptedProviderExt: InlineExtension = {
      name: "scripted-provider",
      factory: (pi) => {
        pi.registerProvider(options.provider ?? makeScriptedProvider(options.respond ?? (() => ({
          content: "smoke",
          stopReason: "stop",
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        }))));
      },
    };
    // Task 3 reality fix: createAgentSession ignores the loader's agentDir —
    // with only `resourceLoader` given it builds its own SettingsManager over
    // getDefaultAgentDir() (~/.pi/agent) (sdk.js), so a settings.json written
    // into the arm's agentDir was silently unread (reserveTokens stayed at the
    // 16384 default). Build the manager here — exactly what the loader would
    // build internally (SettingsManager.create(cwd, agentDir)) — and hand it
    // to BOTH the loader and the session so the arm's settings.json wins.
    const settingsManager = SettingsManager.create(agentDir, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
      extensionFactories: [scriptedProviderExt, ...(options.extensions ?? [])],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      resourceLoader: loader,
      settingsManager,
      model: makeScriptedModel(),
      sessionManager: undefined, // in-file sessions under agentDir
      customTools: options.customTools,
    });
    return {
      session,
      agentDir,
      extensionErrors: loader.getExtensions().errors.map((e) => `${e.path}: ${e.error}`),
      dispose: async () => {
        session.dispose();
        restoreHome();
        await Promise.all([
          rm(agentDir, { recursive: true, force: true }),
          rm(homeDir, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    restoreHome();
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

// ─── Task 3: recorder extension + context-token capture ──────────────────────

/** One observed lifecycle event in an A/B arm, captured by makeRecorder. */
export interface AbRow {
  arm: string;
  event: "compact" | "compact_failed" | "settled" | "turn_end";
  reason?: "manual" | "threshold" | "overflow";
  /** Live context tokens at event time (ctx.getContextUsage()?.tokens; for
   * compact rows, compactionEntry.tokensBefore when that is null — see
   * makeRecorder) — null when the session cannot know yet. */
  contextTokens: number | null;
  /** How many turn_end rows this arm had logged before/within this row —
   * ties every row to its tool-loop iteration. */
  loopIndex: number;
}

/** The A/B recorder: an inline extension that turns the session lifecycle
 * events upstream already emits into comparable rows. Handler params are
 * inferred from ExtensionAPI.on's per-event overloads (the installed d.ts
 * types ExtensionHandler as (event, ctx: ExtensionContext)). */
export function makeRecorder(arm: string, rows: AbRow[]): InlineExtension {
  return {
    name: "ab-recorder",
    factory: (pi) => {
      let turnEnds = 0;
      const snap = (ctx: { getContextUsage?: () => { tokens: number | null } | undefined }) =>
        ctx.getContextUsage?.()?.tokens ?? null;
      pi.on("turn_end", (_event, ctx) => {
        rows.push({ arm, event: "turn_end", contextTokens: snap(ctx), loopIndex: turnEnds++ });
      });
      pi.on("session_compact", (event, ctx) => {
        rows.push({
          arm,
          event: "compact",
          reason: event.reason,
          // ctx.getContextUsage() is null BY DESIGN at session_compact time —
          // upstream returns null until an assistant responds after the
          // compaction boundary (agent-session.js getContextUsage) — so fall
          // back to the event payload's own pre-compaction token count.
          contextTokens: ctx.getContextUsage()?.tokens ?? event.compactionEntry.tokensBefore,
          loopIndex: turnEnds,
        });
      });
      pi.on("session_compact_failed", (event, ctx) => {
        rows.push({ arm, event: "compact_failed", reason: event.reason, contextTokens: snap(ctx), loopIndex: turnEnds });
      });
      pi.on("agent_settled", (_event, ctx) => {
        rows.push({ arm, event: "settled", contextTokens: snap(ctx), loopIndex: turnEnds });
      });
    },
  };
}

describe("autocompact A/B harness", () => {
  test("smoke: scripted provider drives a real tool-loop turn", async () => {
    const smoke = await smokeSession({
      extensions: [{ name: "power-tool", factory: powerToolFactory }],
    });
    try {
      await smoke.session.prompt("smoke");
      expect(smoke.extensionErrors).toEqual([]); // both factories loaded
      const assistants = smoke.session.messages.filter((m) => m.role === "assistant");
      // Honesty gate: an assistant entry alone would also pass on a
      // provider error (the loop appends a failure message), so pin the
      // scripted payload AND the absence of an error envelope.
      expect(assistants.length).toBeGreaterThan(0);
      expect(assistants.some((m) => m.errorMessage !== undefined)).toBe(false);
      expect(JSON.stringify(assistants.map((m) => m.content))).toContain("smoke");
    } finally {
      await smoke.dispose();
    }
  });

  test("provocation: usage-curve script drives a deep emit_blob tool loop", async () => {
    const smoke = await smokeSession({
      extensions: [{ name: "power-tool", factory: powerToolFactory }],
      provider: makeScriptedProviderFromScript([...PROVOCATION_SCRIPT, FINAL_STEP]),
      customTools: [EMIT_BLOB_TOOL],
    });
    try {
      await smoke.session.prompt("run the loop");
      expect(smoke.extensionErrors).toEqual([]);
      const assistants = smoke.session.messages.filter((m) => m.role === "assistant");
      expect(assistants.some((m) => m.errorMessage !== undefined)).toBe(false);
      // The loop actually ran deep: 7 scripted emit_blob calls, each executed
      // by the real tool executor with a full-size blob result.
      const toolResults = smoke.session.messages.filter((m) => m.role === "toolResult");
      expect(toolResults.length).toBeGreaterThanOrEqual(6);
      for (const result of toolResults) {
        expect(result.toolName).toBe("emit_blob");
        expect(result.content[0]).toEqual({ type: "text", text: "x".repeat(BLOB_SIZE) });
      }
      // Exact curve: each assistant response reports the scripted context
      // tokens (totalTokens = the four-field usage sum — see toAssistantMessage).
      expect(assistants.map((m) => m.usage.totalTokens)).toEqual([...USAGE_CURVE, 70_100]);
    } finally {
      await smoke.dispose();
    }
  });

  test("isSummarizerCall: matches upstream's summarization context, not normal turns", () => {
    // Shape from compaction.js buildSummarizationContext: system prompt carries
    // SUMMARIZATION_SYSTEM_PROMPT, messages[0] is a USER message.
    expect(isSummarizerCall({
      systemPrompt: "You are a context summarization assistant. Your task is to ...",
      messages: [{ role: "user", content: [{ type: "text", text: "<conversation/>..." }] } as never],
    })).toBe(true);
    // Normal agent turn: default system prompt (no "summar*" substring) with a
    // user message — must NOT be classified as a summarizer.
    expect(isSummarizerCall({
      systemPrompt: "You are pi, a coding agent running in an interactive CLI.",
      messages: [{ role: "user", content: [{ type: "text", text: "run the loop" }] } as never],
    })).toBe(false);
    expect(isSummarizerCall({ messages: [] })).toBe(false); // no systemPrompt at all
  });

  test("recorder: threshold compaction emits session_compact with a token snapshot", async () => {
    const rows: AbRow[] = [];
    const smoke = await smokeSession({
      extensions: [
        { name: "power-tool", factory: powerToolFactory },
        makeRecorder("baseline", rows),
      ],
      provider: makeScriptedProviderFromScript([...PROVOCATION_SCRIPT, FINAL_STEP]),
      customTools: [EMIT_BLOB_TOOL],
      // contextWindow 128k − reserve 68k ⇒ threshold at 60k: the curve crosses
      // it at step 6 (63k) and the final step lands at 70_100 — well past.
      // keepRecentTokens must ALSO drop below the curve's real content size
      // (~9k tokens of blobs): findCutPoint budgets by content-estimated
      // tokens, not scripted usage, and the 20k default keeps everything →
      // prepareCompaction finds nothing to summarize → compaction silently
      // no-ops (first GREEN attempt: 0 compact rows, no error anywhere).
      settings: { compaction: { enabled: true, reserveTokens: 68_000, keepRecentTokens: 2_000 } },
    });
    try {
      await smoke.session.prompt("run the loop");
      expect(smoke.extensionErrors).toEqual([]); // recorder factory loaded
      const assistants = smoke.session.messages.filter((m) => m.role === "assistant");
      expect(assistants.some((m) => m.errorMessage !== undefined)).toBe(false);
      const compacts = rows.filter((r) => r.event === "compact" && r.reason === "threshold");
      expect(compacts.length).toBeGreaterThanOrEqual(1);
      // Validity-gate foundation: the row carries the live token count that
      // triggered compaction, not a null snapshot.
      expect(compacts.some((r) => (r.contextTokens ?? 0) > 60_000)).toBe(true);
      // #6879 mid-run reachability: at least one compaction fired BETWEEN
      // loop iterations (rows continue after it), not only after the turn.
      const lastLoop = Math.max(...rows.filter((r) => r.event === "turn_end").map((r) => r.loopIndex));
      expect(compacts.some((r) => r.loopIndex < lastLoop)).toBe(true);
      expect(rows.some((r) => r.event === "settled")).toBe(true);
    } finally {
      await smoke.dispose();
    }
  });

  // ─── Task 4: arms S1–S4 + validity gate + verdict report ──────────────────

  test("arms S1–S4: full matrix, validity gate, verdict report", async () => {
    const rows: AbRow[] = [];
    for (const spec of ARMS) {
      await runArm(spec, rows);
    }
    // Validity gate: if S1 (upstream-only, reserve 68k ⇒ fires at 60k) never
    // threshold-compacts, the mock world never reached #6879 — every other
    // number in the report is meaningless.
    const s1ThresholdCompacts = rows.filter(
      (r) => r.arm === "S1-baseline" && r.event === "compact" && r.reason === "threshold",
    );
    expect(s1ThresholdCompacts.length).toBeGreaterThanOrEqual(1);
    // Regression guard: the ext fires ALONE (compaction.enabled false in
    // settings) — the S3 standalone lane is the ext's minimum viable niche.
    const s3ManualCompacts = rows.filter(
      (r) => r.arm === "S3-standalone" && r.event === "compact" && r.reason === "manual",
    );
    expect(s3ManualCompacts.length).toBeGreaterThanOrEqual(1);
    // Measured numbers are REPORTED, never asserted (Task 5 owns measurement).
    console.log(renderReport(rows));
  }, 60_000);
});

/** One experimental arm of the A/B matrix. `compaction` lands verbatim in the
 *  arm's settings.json (upstream reserveTokens semantics); `extThreshold`
 *  arms the /autocompact ext via setThreshold between session creation and
 *  prompt(). */
export interface ArmSpec {
  arm: string;
  compaction: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number };
  extThreshold?: number;
}

/** The four arms. keepRecentTokens MUST sit below the script's ~9k
 *  content-estimated tokens on EVERY arm — not just enabled ones: the manual
 *  compact path runs the SAME prepareCompaction with getCompactionSettings()
 *  (agent-session.js:1480), so with the 20k default the ext's ctx.compact()
 *  at settle fails "Nothing to compact (session too small)" and S3's manual
 *  lane dies in compact_failed. Measured in Task 4's RED run (probe): S3 with
 *  { enabled: false } alone → onError "Nothing to compact (session too
 *  small)"; + keepRecentTokens 2_000 → manual compact lands. */
const ARMS: ArmSpec[] = [
  { arm: "S1-baseline", compaction: { enabled: true, reserveTokens: 68_000, keepRecentTokens: 2_000 } },
  { arm: "S2-matched", compaction: { enabled: true, reserveTokens: 68_000, keepRecentTokens: 2_000 }, extThreshold: 60_000 },
  { arm: "S3-standalone", compaction: { enabled: false, keepRecentTokens: 2_000 }, extThreshold: 50_000 },
  { arm: "S4-niche", compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 2_000 }, extThreshold: 50_000 },
];

/** Poll `rows` until the arm's post-prompt lifecycle is complete (or the
 *  deadline passes — late rows are a finding, not a hang). prompt() resolving
 *  does NOT mean the ext's manual compact finished: agent_settled handlers
 *  start it and upstream completes it asynchronously, so disposing right
 *  after prompt() would cancel it and look identical to "never fired". */
async function waitForArmOutcome(spec: ArmSpec, rows: AbRow[], timeoutMs: number): Promise<void> {
  const armed = spec.extThreshold !== undefined;
  const done = () =>
    rows.some((r) => r.arm === spec.arm && r.event === "settled") &&
    // For armed arms, wait until the manual compact LANDED (compact) or was
    // refused upstream (compact_failed) — either is an outcome worth rows.
    (!armed || rows.some((r) => r.arm === spec.arm && r.reason === "manual" && (r.event === "compact" || r.event === "compact_failed")));
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Run one arm hermetically: fresh temp agentDir, settings.json from the
 *  spec, the real power-tool factory + scripted provider + recorder, the
 *  emit_blob tool, and the full provocation script. `session.prompt` races a
 *  30 s timeout so a stuck agent loop fails loudly instead of hanging CI. */
export async function runArm(spec: ArmSpec, rows: AbRow[]): Promise<AbRow[]> {
  const smoke = await smokeSession({
    settings: { compaction: spec.compaction },
    extensions: [
      { name: "power-tool", factory: powerToolFactory },
      makeRecorder(spec.arm, rows),
    ],
    provider: makeScriptedProviderFromScript([...PROVOCATION_SCRIPT, FINAL_STEP]),
    customTools: [EMIT_BLOB_TOOL],
  });
  try {
    if (spec.extThreshold !== undefined) {
      // Same module instance as the loaded factory (inline extensionFactories,
      // no file-path loader), so this arms the ext the command would arm.
      setThreshold(smoke.session.sessionId, spec.extThreshold);
    }
    let timeoutId: ReturnType<typeof setTimeout>;
    await Promise.race([
      smoke.session.prompt("run the plan"),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`arm ${spec.arm}: prompt did not finish within 30s`)),
          30_000,
        );
      }),
    ]);
    clearTimeout(timeoutId!);
    await waitForArmOutcome(spec, rows, 5_000);
    return rows;
  } finally {
    resetAutocompact(); // thresholds are keyed by sessionId — never reused
    await smoke.dispose();
  }
}

/** Verdict line for one arm, per the spec's verdict rules. Measured from
 *  rows only — no spec knowledge beyond the arm name (which arm IS the
 *  treatment is the experiment's business, not the reporter's). */
function verdictFor(arm: string, armRows: AbRow[]): string {
  const compacts = armRows.filter((r) => r.event === "compact");
  const manual = compacts.filter((r) => r.reason === "manual");
  const threshold = compacts.filter((r) => r.reason === "threshold");
  const manualFailed = armRows.filter((r) => r.event === "compact_failed" && r.reason === "manual");
  const parts: string[] = [];
  // Collision: a manual compact adjacent (same loopIndex) to a threshold one.
  const collision = manual.some((m) => threshold.some((t) => t.loopIndex === m.loopIndex));
  if (collision) parts.push("COLLISION signal (manual compact at the same loopIndex as a threshold compact)");
  if (arm === "S2-matched") {
    if (manual.length === 0) {
      // The settle-time attempt can still be REFUSED ("Already compacted") —
      // that is upstream having absorbed the boundary, so it refines, not
      // breaks, the absorbed verdict.
      parts.push(
        manualFailed.length > 0
          ? `ext absorbed at matched thresholds (0 manual compacts; ${manualFailed.length} settle-time attempt(s) refused as redundant)`
          : "ext absorbed at matched thresholds (0 manual compacts)",
      );
    } else {
      parts.push(`NOT absorbed — ${manual.length} manual compact(s) fired despite matched thresholds`);
    }
  }
  if (arm === "S4-niche") {
    if (manual.length === 0) parts.push("retire signal (0 manual compacts)");
    else if (
      threshold.length === 0 ||
      Math.min(...manual.map((r) => r.loopIndex)) < Math.min(...threshold.map((r) => r.loopIndex))
    ) {
      parts.push("niche real (manual compact fired earlier than any threshold compact)");
    } else {
      parts.push("no niche (manual compacts all fired after a threshold compact)");
    }
  }
  return parts.length ? parts.join("; ") : "n/a (control arm)";
}

/** Markdown report: per-arm compact counts by reason, tokens at each fire,
 *  peak turn_end tokens, final settled tokens, verdict. Stdout only —
 *  measured numbers are never asserted. */
export function renderReport(rows: AbRow[]): string {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const lines = [
    "## autocompact A/B — S1–S4",
    "",
    "| arm | threshold compacts | manual compacts | failed | tokens at fire | peak turn_end | final settled | verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of arms) {
    const armRows = rows.filter((r) => r.arm === arm);
    const compacts = armRows.filter((r) => r.event === "compact");
    const threshold = compacts.filter((r) => r.reason === "threshold");
    const manual = compacts.filter((r) => r.reason === "manual");
    const failed = armRows.filter((r) => r.event === "compact_failed");
    const fires = compacts
      .map((r) => `${r.contextTokens === null ? "?" : r.contextTokens.toLocaleString()} (${r.reason})`)
      .join(", ");
    const turnEnds = armRows.filter((r) => r.event === "turn_end" && r.contextTokens !== null);
    const peak = turnEnds.length ? Math.max(...turnEnds.map((r) => r.contextTokens as number)).toLocaleString() : "?";
    const settled = [...armRows].reverse().find((r) => r.event === "settled");
    lines.push(
      `| ${arm} | ${threshold.length} | ${manual.length} | ${failed.length} | ${fires || "—"} | ${peak} | ${
        settled?.contextTokens !== undefined && settled?.contextTokens !== null ? settled.contextTokens.toLocaleString() : "?"
      } | ${verdictFor(arm, armRows)} |`,
    );
  }
  return lines.join("\n");
}
