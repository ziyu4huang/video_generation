/**
 * Lists the user's available model specs (provider/modelId, auth configured).
 *
 * Split out of agent.ts so model-tier-config.ts can call listAvailableModelSpecs
 * without importing agent.js — that back-edge would otherwise cycle once a
 * planned agent-model.ts extraction pulls model/tier resolution out of agent.ts
 * and into a module that itself needs model-tier-config.js.
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
