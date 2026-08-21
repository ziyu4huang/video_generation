import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { loadCompactConfig, type CompactConfig } from "../src/config.ts";
import { pickModel, type ModelContext } from "../src/model.ts";
import { summarizeCcStyle, type CcSummaryResult, type SummarizeOptions } from "../src/summarize.ts";

export interface CompactExtDeps {
  summarize?: typeof summarizeCcStyle;
  config?: CompactConfig;
}

/** ProviderHeaders allows null (header deletion); the summarizer takes plain string maps. */
function stringHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function createCompactExtension(deps: CompactExtDeps = {}): ExtensionFactory {
  return (pi) => {
    const config = deps.config ?? loadCompactConfig();
    if (!config.enabled) return;
    const summarize = deps.summarize ?? summarizeCcStyle;

    pi.on("session_before_compact", async (event, ctx) => {
      try {
        const model = pickModel(
          ctx as unknown as ModelContext,
          config.modelOverrideSpec,
        );
        if (!model) return; // no model at all → let host run built-in compaction
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          ctx.ui.notify(
            `compact: no API key for ${model.provider}/${model.id} — falling back to built-in compaction`,
            "warning",
          );
          return;
        }

        const result: CcSummaryResult = await summarize(
          {
            messages: event.preparation.messagesToSummarize as never,
            previousSummary: event.preparation.previousSummary,
            customInstructions: event.customInstructions,
            reserveTokens: event.preparation.settings.reserveTokens,
            signal: event.signal,
          },
          model,
          { apiKey: auth.apiKey, headers: stringHeaders(auth.headers), env: auth.env },
          { maxTokensFactor: config.maxTokensFactor } satisfies SummarizeOptions,
        );

        return {
          compaction: {
            summary: result.summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            estimatedTokensAfter: Math.ceil(result.summary.length / 4),
            usage: result.usage,
            details: {
              engine: "cc-style",
              sessionType: result.sessionType,
              files: {
                read: result.fileOps.read.length,
                edited: result.fileOps.edited.length,
                written: result.fileOps.written.length,
              },
              userMessages: result.userMessages.length,
            },
          },
        };
      } catch (err) {
        ctx.ui.notify(
          `compact: CC-style summary failed (${err instanceof Error ? err.message : String(err)}) — falling back to built-in compaction`,
          "warning",
        );
        return undefined; // undefined → host built-in compaction
      }
    });
  };
}

export default createCompactExtension();
