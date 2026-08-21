import { completeSimple } from "@earendil-works/pi-ai/compat";
import { contentText, type Api, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { extractFileOps, type FileOpsSummary } from "./file-ops.ts";
import { buildSystemPrompt, buildUserPrompt, extractSummary } from "./prompt.ts";
import { inferSessionType, toolNamesIn } from "./session-type.ts";
import { collectUserMessages, type CollectedUserMessage } from "./user-messages.ts";

export interface ModelAuth {
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface SummarizeRequest {
  messages: readonly Message[];
  previousSummary?: string;
  customInstructions?: string;
  reserveTokens: number;
  signal: AbortSignal;
}

export interface SummarizeOptions {
  maxTokensFactor?: number;
  /** Test seam; defaults to the real completeSimple. */
  complete?: typeof completeSimple;
}

export interface CcSummaryResult {
  summary: string;
  usage: Usage | undefined;
  sessionType: ReturnType<typeof inferSessionType>;
  fileOps: FileOpsSummary;
  userMessages: readonly CollectedUserMessage[];
}

export async function summarizeCcStyle(
  request: SummarizeRequest,
  model: Model<Api>,
  auth: ModelAuth,
  options: SummarizeOptions = {},
): Promise<CcSummaryResult> {
  const llmMessages = convertToLlm(request.messages as never);
  const conversationText = serializeConversation(llmMessages as never);
  const fileOps = extractFileOps(request.messages);
  const sessionType = inferSessionType({
    toolNames: toolNamesIn(request.messages),
    conversationText,
  });
  const userMessages = collectUserMessages(request.messages);

  const userPrompt = buildUserPrompt({
    conversationText,
    previousSummary: request.previousSummary,
    customInstructions: request.customInstructions,
    fileOps,
    sessionType,
    userMessages,
  });

  const factor = options.maxTokensFactor ?? 0.8;
  const maxTokens = Math.min(
    Math.floor(factor * request.reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );

  const complete = options.complete ?? completeSimple;
  const response = await complete(
    model,
    {
      systemPrompt: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: request.signal, maxTokens },
  );

  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return {
    summary: extractSummary(contentText(response.content)),
    usage: response.usage,
    sessionType,
    fileOps,
    userMessages,
  };
}
