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
import { computeMetrics, extractErrorStrings, selectSessions, type ArmMetrics, type SessionCandidate } from "./ab-metrics.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

interface SessionResult {
  session: string;
  tokensBefore: number;
  armA: { metrics: ArmMetrics; summaryPreview: string };
  armB: { metrics: ArmMetrics; summaryPreview: string; sessionType: CcSummaryResult["sessionType"] };
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
      // Cheap pre-filter: message-entry count ≈ lines starting with {"type":"message"
      const text = await readFile(path, "utf8");
      const messageEntries = text.split("\n").filter((l) => l.startsWith('{"type":"message"')).length;
      out.push({ id: `${dir.name}/${f}`, path, messageEntries, bytes });
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
      "Usage: bun run --cwd bun-apps/s2-agent-ext-compact ab [--session <path.jsonl>] [--n 5] [--model provider/id] [--out report.json]\n" +
        "  Offline A/B replay: host built-in summarizer vs CC-style compact on real sessions.\n" +
        "  Model defaults to the configured medium tier. Unknown args are ignored.",
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

  const chosen = sessionArg
    ? [{ id: sessionArg, path: sessionArg, messageEntries: Number.POSITIVE_INFINITY, bytes: 0 }]
    : selectSessions(await collectCandidates(), { minMessages: 50, n });

  const results: SessionResult[] = [];
  for (const s of chosen) {
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
    );
    const t1 = performance.now();
    const ccStyle = await summarizeCcStyle(
      { messages: messagesToSummarize as never, previousSummary, reserveTokens, signal: new AbortController().signal },
      model,
      { apiKey: auth.apiKey, headers, env: auth.env },
    );
    const t2 = performance.now();

    results.push({
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
        summaryPreview: builtIn.text.slice(0, 200),
      },
      armB: {
        metrics: computeMetrics({
          tokensBefore,
          summaryTokens: Math.ceil(ccStyle.summary.length / 4),
          summarizedEntryTokens,
          wallMs: t2 - t1,
          usage: toMetricsUsage(ccStyle.usage),
        }),
        summaryPreview: ccStyle.summary.slice(0, 200),
        sessionType: ccStyle.sessionType,
      },
      // Fact set for later blind judging: deterministic ground truth both summaries should recall.
      factSet: {
        paths: [...ccStyle.fileOps.read, ...ccStyle.fileOps.edited, ...ccStyle.fileOps.written].slice(0, 50),
        userRequests: ccStyle.userMessages.slice(0, 20).map((m) => m.text.slice(0, 200)),
        errorStrings: extractErrorStrings(conversationText),
      },
    });
    const last = results.at(-1)!;
    console.log(
      `✔ ${s.id}  A:${last.armA.metrics.summaryTokens}tok/${Math.round(t1 - t0)}ms  B:${last.armB.metrics.summaryTokens}tok/${Math.round(t2 - t1)}ms`,
    );
  }

  const mean = (pick: (r: (typeof results)[number]) => number) =>
    results.length ? results.reduce((a, r) => a + pick(r), 0) / results.length : 0;
  console.table(results.map((r) => ({ session: r.session, ...r.armA.metrics, ...r.armB.metrics })));
  console.log("means:", {
    aCompression: mean((r) => r.armA.metrics.compressionRatio),
    bCompression: mean((r) => r.armB.metrics.compressionRatio),
    aCost: mean((r) => r.armA.metrics.cost),
    bCost: mean((r) => r.armB.metrics.cost),
  });

  const out = arg("out");
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await Bun.file(out).write(JSON.stringify({ model: `${provider}/${id}`, results }, null, 2));
    console.log(`wrote ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
