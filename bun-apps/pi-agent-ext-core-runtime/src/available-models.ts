/**
 * Lists the user's available model specs (provider/modelId, auth configured).
 *
 * Split out of agent.ts to break a cycle that already existed: agent.ts imports
 * model-tier-config.js, while model-tier-config.ts needed listAvailableModelSpecs
 * from agent.js. Holding it in a leaf makes that edge one-way, which is also what
 * lets model/tier resolution move out of agent.ts into a module that itself
 * imports model-tier-config.js.
 *
 * Named for what it holds — availability, not resolution. Resolving a spec
 * (tier/fallback → one model) is a different concern and lives elsewhere.
 */
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * List the user's currently available models (those with auth configured) as
 * `provider/modelId` specs. Used to tell the workflow author which models it may
 * route agents to. Best-effort: returns [] if the registry can't be built.
 */
export async function listAvailableModelSpecs(): Promise<string[]> {
  try {
    const dir = getAgentDir();
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
    });
    const registry = new ModelRegistry(runtime);
    return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return [];
  }
}
