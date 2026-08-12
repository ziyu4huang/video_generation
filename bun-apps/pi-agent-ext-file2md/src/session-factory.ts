/**
 * Session factory for VLM calls — the part of sessions.ts that talks to
 * pi-coding-agent's createAgentSession pipeline.
 *
 * Split out from sessions.ts so tests can mock `createSharedSession` WITHOUT
 * clobbering `resolveLLM` (which lives in sessions.ts and has its own unit
 * tests). Under `bun test`, `mock.module` replaces the target module for the
 * whole process; mocking sessions.ts used to leak the stub into sessions.test.ts
 * (forcing `bun test --isolate`). Mocking this module instead leaves resolveLLM
 * intact, so the suite runs under plain `bun test`.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedLLM } from "./sessions.js";

/** Find model in registry — exact match first, then substring fallback. */
function resolveModel(services: AgentSessionServices, provider: string, modelId: string): Model<any> {
  // AgentSessionServices exposes `modelRuntime` (ModelRuntime), not a registry.
  // ModelRegistry is a thin synchronous wrapper over it (find/getAll/
  // getAvailable) — construct one per call (cheap) rather than stashing it.
  const reg = new ModelRegistry(services.modelRuntime);
  const exact = reg.find(provider, modelId);
  if (exact) return exact;

  const all = reg.getAll();
  const needle = modelId.toLowerCase();
  const hit =
    all.find(
      (m) =>
        m.provider.toLowerCase() === provider.toLowerCase() &&
        (m.id.toLowerCase().includes(needle) || (m.name ?? "").toLowerCase().includes(needle)),
    ) ?? all.find((m) => m.id.toLowerCase().includes(needle) || (m.name ?? "").toLowerCase().includes(needle));

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
 * No obsidian extension — suitable for pure VLM page extraction.
 *
 * Model resolution, in order of precedence:
 *  1. `opts.modelRuntime` — an explicit `ModelRuntime` instance (e.g. built
 *     via `await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null })`).
 *     Fully file-independent — use this when a caller ships its own provider
 *     config in CODE rather than depending on ANY models.json existing at a
 *     particular path (global or project-local paths can be deleted/moved by
 *     unrelated changes — see memory [[pi-vlm-agentdir-global-vs-project]]).
 *  2. `opts.agentDir` — resolve models.json from this directory instead of
 *     the global ~/.pi/agent.
 *  3. default: the global `getAgentDir()` (~/.pi/agent), matching the
 *     historical behavior of this function.
 */
export async function createSharedSession(
  llm: ResolvedLLM,
  opts: { appendSystemPrompt?: string[]; agentDir?: string; modelRuntime?: ModelRuntime } = {},
) {
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: opts.agentDir ?? getAgentDir(),
    modelRuntime: opts.modelRuntime,
    resourceLoaderOptions: {
      ...(opts.appendSystemPrompt?.length ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
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
