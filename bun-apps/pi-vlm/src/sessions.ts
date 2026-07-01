/**
 * Simplified session factory for VLM calls.
 *
 * Provides the same surface as bun-pi-agent-cli/src/sessions/shared.ts but:
 *  - No pi-obsidian extension baked in (VLM calls are pure inference, no vault tools needed)
 *  - No custom buildModelRegistry() — uses the standard ~/.pi/ registry which already has
 *    lm-studio configured per the project CLAUDE.md
 */
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export type { ThinkingLevel };

const THINKING_LEVELS: readonly string[] = [
  "off", "minimal", "low", "medium", "high", "xhigh",
];

export interface ResolvedLLM {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * Resolve LLM target from options. Accepts "provider/modelId" shorthand in model.
 * Defaults to lm-studio/google/gemma-4-26b-a4b-qat for VLM work.
 */
export function resolveLLM(opts: {
  provider?: string;
  model?: string;
  thinking?: string;
}): ResolvedLLM {
  const DEFAULT_MODEL = "lm-studio/google/gemma-4-26b-a4b-qat";

  let model = opts.model ?? process.env.PI_MODEL ?? DEFAULT_MODEL;
  let provider = opts.provider ?? process.env.PI_PROVIDER ?? "lm-studio";
  let thinkingLevel: ThinkingLevel = (process.env.PI_THINKING ?? "off") as ThinkingLevel;

  // Parse "provider/modelId[:thinking]" shorthand
  const colon = model.lastIndexOf(":");
  const firstSlash = model.indexOf("/");
  if (colon > firstSlash && colon !== -1) {
    const maybeTh = model.slice(colon + 1);
    if (THINKING_LEVELS.includes(maybeTh)) {
      thinkingLevel = maybeTh as ThinkingLevel;
      model = model.slice(0, colon);
    }
  }
  if (model.includes("/")) {
    const slash = model.indexOf("/");
    provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }
  if (opts.thinking && THINKING_LEVELS.includes(opts.thinking)) {
    thinkingLevel = opts.thinking as ThinkingLevel;
  }

  return { provider, modelId: model, thinkingLevel };
}

/** Find model in registry — exact match first, then substring fallback. */
function resolveModel(services: AgentSessionServices, provider: string, modelId: string): Model<any> {
  const reg = services.modelRegistry;
  const exact = reg.find(provider, modelId);
  if (exact) return exact;

  const all = reg.getAll();
  const needle = modelId.toLowerCase();
  const hit =
    all.find(
      (m) =>
        m.provider.toLowerCase() === provider.toLowerCase() &&
        (m.id.toLowerCase().includes(needle) || (m.name ?? "").toLowerCase().includes(needle)),
    ) ??
    all.find(
      (m) => m.id.toLowerCase().includes(needle) || (m.name ?? "").toLowerCase().includes(needle),
    );

  if (!hit) {
    const available = reg.getAvailable();
    throw new Error(
      `Model "${provider}/${modelId}" not found.\n` +
        `Available (${available.length}): ` +
        available
          .slice(0, 12)
          .map((m) => `${m.provider}/${m.id}`)
          .join(", ") +
        (available.length > 12 ? " …" : ""),
    );
  }
  return hit;
}

/**
 * Create a minimal agent session for a single VLM inference call.
 * No obsidian extension, no custom model registry — suitable for pure VLM page extraction.
 *
 * `agentDir` defaults to the global `getAgentDir()` (~/.pi/agent), matching the
 * historical behavior of this function. Pass an explicit `agentDir` (e.g. a
 * project-local `<repoRoot>/.pi/agent`) to resolve models against THAT
 * directory's `models.json` instead — useful for callers that ship their own
 * checked-in provider config rather than depending on the user's global one.
 */
export async function createSharedSession(
  llm: ResolvedLLM,
  opts: { appendSystemPrompt?: string[]; agentDir?: string } = {},
) {
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: opts.agentDir ?? getAgentDir(),
    resourceLoaderOptions: {
      ...(opts.appendSystemPrompt?.length
        ? { appendSystemPrompt: opts.appendSystemPrompt }
        : {}),
    },
  });

  const model = resolveModel(services, llm.provider, llm.modelId);

  return createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(process.cwd()),
    model,
    thinkingLevel: llm.thinkingLevel,
  });
}
