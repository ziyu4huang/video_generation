/**
 * Offline A/B replay harness: CC-style compact (this extension) vs the host's
 * built-in generateSummaryWithUsage, on real sessions from ~/.pi/agent/sessions.
 * Both arms share the same cut point (findCutPoint), model, and reserveTokens.
 */
import type { Usage } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  findCutPoint,
  generateSummaryWithUsage,
  getLatestCompactionEntry,
  ModelRegistry,
  parseSessionEntries,
  DEFAULT_COMPACTION_SETTINGS,
  sessionEntryToContextMessages,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadModelTierConfig, resolveModelRole } from "@repo/s2-agent-core-runtime";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { summarizeCcStyle, type CcSummaryResult } from "../src/summarize.ts";
import {
  computeMetrics,
  extractErrorStrings,
  maxPromptTokens,
  partitionByTokenBudget,
  selectSessions,
  type ArmMetrics,
  type SessionCandidate,
} from "./ab-metrics.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/**
 * Blind-eval material: coin-flip the two summaries into anonymous X/Y slots.
 * Pair files deliberately omit token counts and metrics — arm B is consistently
 * longer, so lengths would de-anonymize; cost analysis happens after de-blinding
 * via the report/key file.
 */
function coinFlipAssign(a: string, b: string): { x: string; y: string; xArm: "A" | "B" } {
  return Math.random() < 0.5 ? { x: a, y: b, xArm: "A" } : { x: b, y: a, xArm: "B" };
}

function factSetBlock(f: SessionResult["factSet"]): string {
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join("\n") : "- (none)");
  return [
    `Paths:\n${list(f.paths)}`,
    `User requests:\n${list(f.userRequests)}`,
    `Error strings:\n${list(f.errorStrings.slice(0, 10).map((s) => s.slice(0, 200)))}`,
  ].join("\n\n");
}

interface SessionResult {
  session: string;
  tokensBefore: number;
  armA: { metrics: ArmMetrics; summary: string };
  armB: { metrics: ArmMetrics; summary: string; sessionType: CcSummaryResult["sessionType"] };
  /** Deterministic ground truth both summaries should recall — input for later blind judging. */
  factSet: {
    paths: string[];
    userRequests: string[];
    errorStrings: string[];
  };
}

/** ProviderHeaders allows null values; both LLM call sites want plain string maps. */
function headerMap(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Usage.cost is a breakdown object; computeMetrics wants the scalar total. */
function toMetricsUsage(usage: Usage | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cost: usage?.cost.total ?? 0,
  };
}

async function collectCandidates(): Promise<SessionCandidate[]> {
  const root = join(homedir(), ".pi/agent/sessions");
  const out: SessionCandidate[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of await readdir(join(root, dir.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(root, dir.name, f);
      const bytes = (await stat(path)).size;
      // Cheap pre-filter: message-entry count ≈ lines starting with {"type":"message";
      // estimatedTokens = chars/4 of those message lines (same heuristic as tokensBefore).
      const text = await readFile(path, "utf8");
      const messageLines = text.split("\n").filter((l) => l.startsWith('{"type":"message"'));
      const messageChars = messageLines.reduce((a, l) => a + l.length, 0);
      out.push({
        id: `${dir.name}/${f}`,
        path,
        messageEntries: messageLines.length,
        bytes,
        estimatedTokens: Math.ceil(messageChars / 4),
      });
    }
  }
  return out;
}

function buildArmInputs(entries: FileEntry[]): {
  messagesToSummarize: ReturnType<typeof sessionEntryToContextMessages>;
  tokensBefore: number;
  previousSummary: string | undefined;
} {
  const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
  const cut = findCutPoint(
    sessionEntries,
    0,
    sessionEntries.length - 1,
    DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  );
  const toSummarize = sessionEntries.slice(0, cut.firstKeptEntryIndex);
  // sessionEntryToContextMessages projects ONE entry; the host's own pattern is flatMap.
  const messages = toSummarize.flatMap(sessionEntryToContextMessages);
  const chars = toSummarize.map((e) => JSON.stringify(e).length).reduce((a, b) => a + b, 0);
  return {
    messagesToSummarize: messages,
    tokensBefore: Math.ceil(chars / 4),
    previousSummary: getLatestCompactionEntry(sessionEntries)?.summary,
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: bun run --cwd bun-apps/s2-agent-ext-compact ab [--session <path.jsonl>] [--n 5] [--model provider/id] [--out report.json] [--blind-dir <dir>]\n" +
        "  Offline A/B replay: host built-in summarizer vs CC-style compact on real sessions.\n" +
        "  Model defaults to the configured medium tier. Unknown args are ignored.\n" +
        "  --blind-dir writes one anonymized X/Y pair file per session (fact set + both\n" +
        "  summaries, coin-flipped) plus key.json for de-blinding after scoring.",
    );
    return;
  }
  const n = Number(arg("n", "5"));
  const sessionArg = arg("session");
  const modelSpec = arg("model") ?? resolveModelRole({ tier: "medium" }, loadModelTierConfig());
  if (!modelSpec) throw new Error("No model: pass --model provider/id or configure the medium tier");
  const [provider, id] = modelSpec.replace(/:[^/]+$/, "").split("/");
  if (!provider || !id) throw new Error(`Bad model spec "${modelSpec}" — expected provider/id`);

  const services = await createAgentSessionServices({ cwd: process.cwd() });
  const registry = new ModelRegistry(services.modelRuntime);
  await registry.refresh();
  const model = registry.find(provider, id);
  if (!model) throw new Error(`Model ${provider}/${id} not found in registry`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`No API key for ${provider}/${id}`);
  const headers = headerMap(auth.headers);

  // Context-size pre-filter: skip sessions whose estimated prompt would blow the
  // model's usable context (0.5 × contextWindow; fallback constant without one).
  // Applied BEFORE selectSessions so --n yields n runnable sessions, not candidates
  // that get skipped later. An explicit --session bypasses the filter (operator choice).
  const budget = maxPromptTokens(model);
  let chosen: SessionCandidate[];
  let skippedSessions: Array<{ id: string; reason: string }> = [];
  if (sessionArg) {
    chosen = [{ id: sessionArg, path: sessionArg, messageEntries: Number.POSITIVE_INFINITY, bytes: 0 }];
  } else {
    const { kept, skipped } = partitionByTokenBudget(await collectCandidates(), budget);
    skippedSessions = skipped;
    if (skipped.length) {
      console.log(`↷ skipping ${skipped.length} over-budget sessions (> ${budget}tok prompt budget), e.g.:`);
      for (const s of skipped.slice(0, 5)) console.log(`  ↷ ${s.id}: ${s.reason}`);
    }
    chosen = selectSessions(kept, { minMessages: 50, n });
  }

  const results: SessionResult[] = [];
  const errors: Array<{ session: string; error: string }> = [];
  for (const s of chosen) {
    // Per-session resilience: one dead session (e.g. HTTP 400 "Prompt exceeds
    // max length" despite the estimate) must not kill the whole run.
    let result: SessionResult;
    try {
      const entries = parseSessionEntries(await readFile(s.path, "utf8"));
      const { messagesToSummarize, tokensBefore, previousSummary } = buildArmInputs(entries);
      const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
      const summarizedEntryTokens = Math.ceil(JSON.stringify(messagesToSummarize).length / 4);
      const conversationText = messagesToSummarize.map((m) => JSON.stringify(m)).join("\n");

      const t0 = performance.now();
      const builtIn = await generateSummaryWithUsage(
        messagesToSummarize as never,
        model,
        reserveTokens,
        auth.apiKey,
        headers,
        undefined,
        undefined,
        previousSummary,
        undefined, // thinkingLevel
        undefined, // streamFn
        auth.env, // env — parity with arm B (env-dependent providers)
      );
      const t1 = performance.now();
      const ccStyle = await summarizeCcStyle(
        { messages: messagesToSummarize as never, previousSummary, reserveTokens, signal: new AbortController().signal },
        model,
        { apiKey: auth.apiKey, headers, env: auth.env },
      );
      const t2 = performance.now();

      result = {
        session: s.id,
        tokensBefore,
        armA: {
          metrics: computeMetrics({
            tokensBefore,
            summaryTokens: Math.ceil(builtIn.text.length / 4),
            summarizedEntryTokens,
            wallMs: t1 - t0,
            usage: toMetricsUsage(builtIn.usage),
          }),
          summary: builtIn.text,
        },
        armB: {
          metrics: computeMetrics({
            tokensBefore,
            summaryTokens: Math.ceil(ccStyle.summary.length / 4),
            summarizedEntryTokens,
            wallMs: t2 - t1,
            usage: toMetricsUsage(ccStyle.usage),
          }),
          summary: ccStyle.summary,
          sessionType: ccStyle.sessionType,
        },
        // Fact set for later blind judging: deterministic ground truth both summaries should recall.
        factSet: {
          paths: [...ccStyle.fileOps.read, ...ccStyle.fileOps.edited, ...ccStyle.fileOps.written].slice(0, 50),
          userRequests: ccStyle.userMessages.slice(0, 20).map((m) => m.text.slice(0, 200)),
          errorStrings: extractErrorStrings(conversationText),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ session: s.id, error: message });
      console.log(`✖ ${s.id}  ${message}`);
      continue;
    }
    results.push(result);
    console.log(
      `✔ ${s.id}  A:${result.armA.metrics.summaryTokens}tok/${Math.round(result.armA.metrics.wallMs)}ms  B:${result.armB.metrics.summaryTokens}tok/${Math.round(result.armB.metrics.wallMs)}ms`,
    );
  }

  const mean = (pick: (r: (typeof results)[number]) => number) =>
    results.length ? results.reduce((a, r) => a + pick(r), 0) / results.length : 0;
  // Arm-prefixed columns: both arms share metric field names, so a plain double
  // spread would let armB silently overwrite armA's values in the table.
  const prefix = (p: "a" | "b", m: ArmMetrics) => ({
    [`${p}SummaryTokens`]: m.summaryTokens,
    [`${p}WallMs`]: m.wallMs,
    [`${p}InputTokens`]: m.inputTokens,
    [`${p}OutputTokens`]: m.outputTokens,
    [`${p}Cost`]: m.cost,
    [`${p}Compression`]: m.compressionRatio,
  });
  console.table(results.map((r) => ({ session: r.session, ...prefix("a", r.armA.metrics), ...prefix("b", r.armB.metrics) })));
  console.log("means:", {
    aCompression: mean((r) => r.armA.metrics.compressionRatio),
    bCompression: mean((r) => r.armB.metrics.compressionRatio),
    aCost: mean((r) => r.armA.metrics.cost),
    bCost: mean((r) => r.armB.metrics.cost),
  });

  const out = arg("out");
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await Bun.file(out).write(
      JSON.stringify({ model: `${provider}/${id}`, results, skipped: skippedSessions, errors }, null, 2),
    );
    console.log(`wrote ${out}`);
  }

  const blindDir = arg("blind-dir");
  if (blindDir) {
    await mkdir(blindDir, { recursive: true });
    const key: Array<{ pair: string; session: string; xArm: "A" | "B"; aTokens: number; bTokens: number }> = [];
    for (const [i, r] of results.entries()) {
      const pair = String(i + 1).padStart(2, "0");
      const { x, y, xArm } = coinFlipAssign(r.armA.summary, r.armB.summary);
      key.push({
        pair,
        session: r.session,
        xArm,
        aTokens: r.armA.metrics.summaryTokens,
        bTokens: r.armB.metrics.summaryTokens,
      });
      const body = [
        `# Pair ${pair} — blind eval (score before opening key.json)`,
        "",
        "## Fact set (deterministic ground truth both summaries should recall)",
        "",
        factSetBlock(r.factSet),
        "",
        "## Summary X",
        "",
        x,
        "",
        "## Summary Y",
        "",
        y,
        "",
      ].join("\n");
      await Bun.file(join(blindDir, `${pair}-pair.md`)).write(body);
    }
    await Bun.file(join(blindDir, "key.json")).write(JSON.stringify(key, null, 2));
    console.log(`wrote ${results.length} blind pairs + key.json to ${blindDir}`);
  }

  if (!results.length) {
    console.error("no sessions produced results — all failed or skipped");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
