/**
 * Parse and apply structured memory operations from direct background review.
 */

import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { completeSimple, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DIRECT_REVIEW_SYSTEM_PROMPT } from "../constants.js";
import { MemoryStore } from "../store/memory-store.js";
import { formatFailureMemoryContent, normalizeFailureState } from "../store/memory-format.js";
import type { CardStore } from "../store/card-store.js";
import {
  mirrorMemoryAdd,
  mirrorMemoryReplace,
  mirrorMemoryRemove,
  mirrorMemoryEvictions,
} from "../store/memory-card-mirror.js";
import type { FailureState, MemoryCategory, MemoryConfig, MemoryResult, ThinkingLevel } from "../types.js";

export interface ReviewMemoryOperation {
  action: "add" | "replace" | "remove";
  target: "memory" | "user" | "project" | "failure";
  content?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
  /** Failure lifecycle state (Task 7). When present, normalized via
   *  {@link normalizeFailureState} (invalid → active) and threaded into the
   *  store add + DB sync so a review op can mark a failure resolved/acquired. */
  state?: FailureState;
}

export interface ApplyReviewOperationsResult {
  appliedCount: number;
  skippedCount: number;
}

export interface DirectReviewResult {
  ok: boolean;
  appliedCount: number;
  fallbackReason?: "no_model" | "no_auth" | "aborted" | "parse_error" | "provider_error" | "empty";
  error?: string;
}

export interface RunDirectBackgroundReviewOptions {
  userPrompt: string;
  config: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type ReviewLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) => model.provider.toLowerCase() === provider.toLowerCase()
          && model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function normalizedModelOverride(config: ReviewLlmConfig): string | undefined {
  const trimmed = config.llmModelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

export function effectiveThinkingOverride(config: ReviewLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

type ReviewModelRegistry = ExtensionContext["modelRegistry"];

export function buildDirectReviewCompletionOptions(
  model: Model<Api>,
  auth: {
    apiKey: string;
    headers?: ProviderHeaders;
    env?: Record<string, string>;
  },
  thinking: ThinkingLevel | undefined,
  signal: AbortSignal,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
  };
  if (model.reasoning && thinking && thinking !== "off") {
    options.reasoning = thinking;
  }
  return options;
}

export function resolveReviewModel(
  ctxModel: Model<Api> | undefined,
  modelRegistry: ReviewModelRegistry,
  config: ReviewLlmConfig,
): Model<Api> | undefined {
  const override = normalizedModelOverride(config);
  if (override) {
    const matched = findExactModelReferenceMatch(override, modelRegistry.getAll());
    if (matched) return matched;
  }
  return ctxModel;
}

export function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return value === "failure"
    || value === "correction"
    || value === "insight"
    || value === "preference"
    || value === "convention"
    || value === "tool-quirk";
}

function isReviewTarget(value: unknown): value is ReviewMemoryOperation["target"] {
  return value === "memory" || value === "user" || value === "project" || value === "failure";
}

function isReviewAction(value: unknown): value is ReviewMemoryOperation["action"] {
  return value === "add" || value === "replace" || value === "remove";
}

export function parseReviewOperations(text: string): ReviewMemoryOperation[] | null {
  if (/nothing to save/i.test(text) && !text.includes("{")) {
    return [];
  }

  const payload = extractJsonPayload(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const operations = (payload as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return null;

  const parsed: ReviewMemoryOperation[] = [];
  for (const item of operations) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    if (!isReviewAction(op.action) || !isReviewTarget(op.target)) continue;

    const operation: ReviewMemoryOperation = {
      action: op.action,
      target: op.target,
    };
    if (typeof op.content === "string") operation.content = op.content;
    if (typeof op.old_text === "string") operation.old_text = op.old_text;
    if (isMemoryCategory(op.category)) operation.category = op.category;
    if (typeof op.failure_reason === "string") operation.failure_reason = op.failure_reason;
    if (op.state) operation.state = normalizeFailureState(op.state);
    parsed.push(operation);
  }

  return parsed;
}

function sqliteTargetFor(rawTarget: ReviewMemoryOperation["target"]): "memory" | "user" | "failure" {
  return rawTarget === "user" ? "user" : rawTarget === "failure" ? "failure" : "memory";
}

// ── kp13 Wave B: the memory-kind DB mirror goes through the bundle CardStore
// (md_id-keyed upsert/update/delete; dedup rides upsertCard's registered
// MemoryDedupStrategy). The legacy memoryRepo.syncMemoryEntry content-keyed
// mirror is retired from this path; md stays canonical (MemoryStore writes the
// .md files). Wave C: eviction cleanup also rides the card store
// (mirrorMemoryEvictions — deleteCard by globally-unique md_id); the
// memoryRepo.removeByMdId loop is deleted, so this module holds NO memoryRepo
// seam at all.
async function syncAdd(
  rawTarget: ReviewMemoryOperation["target"],
  content: string,
  category: MemoryCategory | undefined,
  failureReason: string | undefined,
  cardStore: CardStore | null,
  mdId?: string | null,
  state?: FailureState,
): Promise<void> {
  if (!cardStore) return;

  const kind = sqliteTargetFor(rawTarget);

  if (rawTarget === "failure") {
    const failureCategory = category ?? "failure";
    await mirrorMemoryAdd(cardStore, "failure", {
      mdId,
      content: formatFailureMemoryContent(content, {
        category: failureCategory,
        failureReason,
      }),
      ...(state ? { state } : {}),
    });
    return;
  }

  await mirrorMemoryAdd(cardStore, kind, {
    mdId,
    content,
  });
}

async function syncReplace(
  rawTarget: ReviewMemoryOperation["target"],
  oldText: string,
  newContent: string,
  cardStore: CardStore | null,
  mdId?: string | null,
  state?: FailureState,
): Promise<void> {
  if (!cardStore) return;
  await mirrorMemoryReplace(cardStore, sqliteTargetFor(rawTarget), oldText, {
    mdId,
    content: newContent,
    ...(state ? { state } : {}),
  });
}

async function syncRemove(
  rawTarget: ReviewMemoryOperation["target"],
  oldText: string,
  cardStore: CardStore | null,
): Promise<void> {
  if (!cardStore) return;
  await mirrorMemoryRemove(cardStore, sqliteTargetFor(rawTarget), oldText);
}

export async function applyReviewOperations(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operations: ReviewMemoryOperation[],
  projectName?: string | null,
  cardStore: CardStore | null = null,
): Promise<ApplyReviewOperationsResult> {
  let appliedCount = 0;
  let skippedCount = 0;

  for (const op of operations) {
    if (op.target === "project" && !projectStore) {
      skippedCount++;
      continue;
    }

    const rawTarget = op.target;
    const memoryTarget = rawTarget === "project" ? "memory" : rawTarget === "failure" ? "failure" : rawTarget;
    const activeStore = rawTarget === "project" ? projectStore! : store;

    let result: MemoryResult;
    switch (op.action) {
      case "add": {
        if (!op.content?.trim()) {
          skippedCount++;
          continue;
        }
        if (rawTarget === "failure") {
          const category = op.category ?? "failure";
          result = await activeStore.addFailure(op.content, {
            category,
            failureReason: op.failure_reason,
            ...(op.state ? { state: op.state } : {}),
          });
          if (result.success) {
            await syncAdd(rawTarget, op.content, category, op.failure_reason, cardStore, result.added_md_id, op.state);
            appliedCount++;
          } else {
            skippedCount++;
          }
        } else {
          result = await activeStore.add(memoryTarget, op.content);
          if (result.success) {
            await mirrorMemoryEvictions(cardStore, result.evicted_md_ids);
            // D2+D4: superseded entries purged from `.md` by the offload-first
            // overflow path must also have their DB rows deleted (destructive,
            // no audit). offloaded_superseded is md_id-only (ticket 04).
            await mirrorMemoryEvictions(cardStore, result.offloaded_superseded);
            await syncAdd(rawTarget, op.content, undefined, undefined, cardStore, result.added_md_id);
            appliedCount++;
          } else {
            skippedCount++;
          }
        }
        break;
      }
      case "replace": {
        if (!op.old_text || !op.content?.trim()) {
          skippedCount++;
          continue;
        }
        result = await activeStore.replace(memoryTarget, op.old_text, op.content);
        if (result.success) {
          await syncReplace(rawTarget, op.old_text, op.content, cardStore, result.added_md_id, op.state);
          appliedCount++;
        } else {
          skippedCount++;
        }
        break;
      }
      case "remove": {
        if (!op.old_text) {
          skippedCount++;
          continue;
        }
        result = await activeStore.remove(memoryTarget, op.old_text);
        if (result.success) {
          await syncRemove(rawTarget, op.old_text, cardStore);
          appliedCount++;
        } else {
          skippedCount++;
        }
        break;
      }
      default:
        skippedCount++;
    }
  }

  return { appliedCount, skippedCount };
}

export function responseText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "text"
    ))
    .map((block) => block.text)
    .join("\n");
}

export async function runDirectBackgroundReview(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  options: RunDirectBackgroundReviewOptions,
  projectName?: string | null,
  cardStore: CardStore | null = null,
): Promise<DirectReviewResult> {
  const model = resolveReviewModel(ctx.model, ctx.modelRegistry, options.config);
  if (!model) {
    return { ok: false, appliedCount: 0, fallbackReason: "no_model" };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "no_auth",
      error: auth.ok ? `No API key for ${model.provider}` : auth.error,
    };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const thinking = effectiveThinkingOverride(options.config);
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: options.userPrompt }],
    timestamp: Date.now(),
  };

  try {
    const response = await completeSimple(
      model,
      { systemPrompt: DIRECT_REVIEW_SYSTEM_PROMPT, messages: [userMessage] },
      buildDirectReviewCompletionOptions(
        model,
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
        thinking,
        controller.signal,
      ),
    );

    if (response.stopReason === "aborted") {
      return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
    }

    const text = responseText(response.content);
    const operations = parseReviewOperations(text);
    if (operations === null) {
      return { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
    }
    if (operations.length === 0) {
      return { ok: true, appliedCount: 0, fallbackReason: "empty" };
    }

    const { appliedCount } = await applyReviewOperations(
      store,
      projectStore,
      operations,
      projectName,
      cardStore,
    );
    return { ok: true, appliedCount };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
    }
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "provider_error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}