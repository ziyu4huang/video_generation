/**
 * Shared LLM config + cwd-bound services for every CLI mode.
 *
 * Single source of truth: provider / model / thinking level / auth / settings
 * are resolved ONCE here, then each mode builds its session on top of the same
 * services via `createAgentSessionFromServices`. Modes differ only in tools,
 * custom tools, and extensions — never in which model they talk to.
 *
 * Resolution order for provider/model/thinking:
 *   1. env override (PI_PROVIDER / PI_MODEL / PI_THINKING)
 *   2. hardcoded default below
 *
 * Auth/settings/model-registry always come from the user's real ~/.pi/agent
 * via `createAgentSessionServices`, so the SDK demo behaves exactly like the
 * interactive agent.
 */
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionServices,
  type CreateAgentSessionResult,
  type ThinkingLevel,
} from "@earendil-works/pi-coding-agent";

/** LLM config — override via env, otherwise default to zai/glm-5.2 @ medium. */
export const LLM_CONFIG = {
  provider: process.env.PI_PROVIDER ?? "zai",
  modelId: process.env.PI_MODEL ?? "glm-5.2",
  thinkingLevel: (process.env.PI_THINKING ?? "medium") as ThinkingLevel,
};

/** A human label, e.g. "zai/glm-5.2 @ medium". */
export const LLM_CONFIG_LABEL = `${LLM_CONFIG.provider}/${LLM_CONFIG.modelId} @ ${LLM_CONFIG.thinkingLevel}`;

export interface SharedServices {
  services: AgentSessionServices;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
}

/**
 * Build cwd-bound services shared by every mode.
 *
 * @param extensionFactories  inline extension factories (only the `ext` mode
 *                            passes these; they are baked into the resource
 *                            loader, so the services object differs).
 */
export async function getSharedServices(extensionFactories?: unknown[]): Promise<SharedServices> {
  const cwd = process.cwd();
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
    resourceLoaderOptions: extensionFactories?.length
      ? { extensionFactories: extensionFactories as any }
      : undefined,
  });

  const model = services.modelRegistry.find(LLM_CONFIG.provider, LLM_CONFIG.modelId);
  if (!model) {
    throw new Error(
      `Model ${LLM_CONFIG.provider}/${LLM_CONFIG.modelId} not found. ` +
        `Check PI_PROVIDER/PI_MODEL or ~/.pi/agent/models.json.`,
    );
  }
  return { services, model };
}

export interface CreateSharedSessionOptions {
  tools?: string[];
  excludeTools?: string[];
  customTools?: Parameters<typeof createAgentSessionFromServices>[0]["customTools"];
  /** Inline extension factories — baked into the session's resource loader. */
  extensionFactories?: unknown[];
  /** Custom session manager (defaults to in-memory). */
  sessionManager?: Parameters<typeof createAgentSessionFromServices>[0]["sessionManager"];
}

/**
 * Resolve the tool allowlist: explicit option > PI_TOOLS env > undefined.
 * PI_TOOLS is set by the subagent tool to restrict a child session's tools.
 */
function resolveTools(explicit?: string[]): string[] | undefined {
  if (explicit && explicit.length > 0) return explicit;
  const envTools = process.env.PI_TOOLS;
  if (envTools) return envTools.split(",").map((t) => t.trim()).filter(Boolean);
  return undefined;
}

/**
 * Create an AgentSession on top of the shared services.
 *
 * Every mode calls this. Only `tools` / `customTools` / `extensionFactories`
 * vary — model, thinking, auth, and settings are always shared.
 */
export async function createSharedSession(
  opts: CreateSharedSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const { services, model } = await getSharedServices(opts.extensionFactories);
  return createAgentSessionFromServices({
    services,
    sessionManager: opts.sessionManager ?? SessionManager.inMemory(process.cwd()),
    model,
    thinkingLevel: LLM_CONFIG.thinkingLevel,
    tools: resolveTools(opts.tools),
    excludeTools: opts.excludeTools,
    customTools: opts.customTools,
  });
}
