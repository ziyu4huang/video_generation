/**
 * Project-local agentType trust gate (t04, self-arc-25) — upstream parity
 * with earendil-works/pi `examples/extensions/subagent/index.ts`: project
 * agents are repo-controlled (a prompt-injection surface), so binding one in
 * an UNTRUSTED project requires an explicit gate.
 *
 * Policy (map D6):
 *  - `source === "project"` + untrusted + hasUI → one interactive confirm
 *    naming the agent and its file; declining rejects the dispatch.
 *  - `source === "project"` + untrusted + no UI (headless/child/json mode) →
 *    default-DENY naming the file and the trust fix — our timeout-default-DENY
 *    precedent (request-plan-approval-tool.ts).
 *  - user / pack / builtin sources never gate. Trusted projects never gate.
 *  - When the host provides no trust surface at all, upstream's runner
 *    default applies (isProjectTrustedFn = () => true): fail-open, matching
 *    the framework we embed.
 */

import type { AgentDefinition } from "@repo/s2-agent-core-runtime";

/** The slice of the pi tool/extension context the gate needs. */
export interface AgentTrustSurface {
  isProjectTrusted(): boolean;
  hasUI: boolean;
  confirm(title: string, message: string): Promise<boolean>;
}

/** Build the gate surface from a pi tool-execute ctx (may be undefined in
 *  embedders/tests without an extension runner). Absent primitives follow the
 *  documented defaults: trusted (upstream runner default) and no UI. */
export function trustSurfaceFromCtx(ctx: unknown): AgentTrustSurface {
  const c = ctx as
    | {
        isProjectTrusted?: () => boolean;
        hasUI?: boolean;
        ui?: { confirm?: (title: string, message: string) => Promise<boolean> };
      }
    | undefined;
  return {
    isProjectTrusted: () => c?.isProjectTrusted?.() ?? true,
    hasUI: Boolean(c?.hasUI),
    confirm: async (title, message) => {
      const confirm = c?.ui?.confirm;
      if (!confirm) return false;
      return confirm(title, message);
    },
  };
}

export interface GateVerdict {
  ok: boolean;
  /** Rejection text — names the agent, its file, and the trust fix. */
  error?: string;
}

function trustError(def: AgentDefinition): string {
  const file = def.fileName ? `\nFile: ${def.fileName}` : "";
  return (
    `Project-local agentType "${def.name}" is not approved for this project (project is not trusted).` +
    `${file}\nProject agents are repo-controlled. Mark the project trusted (host /trust) or remove the ` +
    `agentType to proceed.`
  );
}

/** Gate ONE resolved definition. Call at dispatch-bind time, after
 *  resolveAgentType. */
export async function gateProjectAgent(def: AgentDefinition, trust: AgentTrustSurface): Promise<GateVerdict> {
  if (def.source !== "project" || trust.isProjectTrusted()) return { ok: true };
  if (!trust.hasUI) return { ok: false, error: trustError(def) };
  const names = def.fileName ? `Agent: ${def.name}\nSource: ${def.fileName}` : `Agent: ${def.name}`;
  const approved = await trust.confirm(
    "Run project-local agents?",
    `${names}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
  if (!approved) return { ok: false, error: `Canceled: project-local agent "${def.name}" not approved.` };
  return { ok: true };
}

/** Gate a BATCH of resolved (index, def) entries with ONE confirm covering all
 *  offending agents. On rejection the batch must fail early as a whole,
 *  listing the offending indexes. */
export async function gateProjectAgentBatch(
  entries: ReadonlyArray<{ index: number; def: AgentDefinition }>,
  trust: AgentTrustSurface,
): Promise<ReadonlyMap<number, string>> {
  const rejections = new Map<number, string>();
  const gated = entries.filter((e) => e.def.source === "project" && !trust.isProjectTrusted());
  if (gated.length === 0) return rejections;
  if (!trust.hasUI) {
    for (const { index, def } of gated) rejections.set(index, trustError(def));
    return rejections;
  }
  const listing = gated
    .map(({ index, def }) => `[${index}] ${def.name}${def.fileName ? ` (${def.fileName})` : ""}`)
    .join("\n");
  const approved = await trust.confirm(
    "Run project-local agents?",
    `Agents:\n${listing}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
  if (!approved) {
    for (const { index, def } of gated)
      rejections.set(index, `Canceled: project-local agent "${def.name}" not approved.`);
  }
  return rejections;
}
