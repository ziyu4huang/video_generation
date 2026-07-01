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
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ResolvedLLM } from "./sessions.js";

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
