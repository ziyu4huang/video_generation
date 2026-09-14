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

import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
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

export interface AgentTrustSurfaceOptions {
  /** The pi tool-execute ctx — supplies hasUI/confirm and the degrade fallback. */
  ctx: unknown;
  /** Dispatch cwd — the trust ANCHOR (matches where loadAgentRegistry reads
   *  project defs from: `runCwd` singular, `defaultCwd` batch). */
  cwd: string;
  /** Agent dir holding trust.json (defaults to pi's getAgentDir()). Tests pin
   *  a temp dir here. */
  agentDir?: string;
}

/**
 * Store-backed default surface (self-arc-26): the trust verdict comes from
 * pi's real ProjectTrustStore (`<agentDir>/trust.json`) at CALL time — the
 * store can change mid-session via the host's trust flow, and freshness is
 * the feature. Mapping (arc-26 map D3/D4/D5):
 *  - store `true`/`false` → that verdict (nearest-ancestor entry wins — pi's
 *    own `findNearestTrustEntry` semantics);
 *  - store `null` (no entry — pi's "ask") → UNTRUSTED: in this host the
 *    no-UI branch then default-DENYs and the TUI branch confirms — the ask;
 *  - unreadable/corrupt store → degrade to the ctx surface (fail-open) —
 *    availability over gate-strictness for a broken LOCAL store;
 *  - hasUI/confirm always from ctx (the parent owns the UI).
 * This is what makes the #2280 gate non-latent: ctx.isProjectTrusted() alone
 * never reports false here (pi's SettingsManager defaults projectTrusted=true
 * and the host never resolves trust).
 */
export function createAgentTrustSurface(opts: AgentTrustSurfaceOptions): AgentTrustSurface {
  const ctxSurface = trustSurfaceFromCtx(opts.ctx);
  return {
    isProjectTrusted: () => {
      try {
        const decision = new ProjectTrustStore(opts.agentDir ?? getAgentDir()).get(opts.cwd);
        return decision === null ? false : decision;
      } catch {
        return ctxSurface.isProjectTrusted();
      }
    },
    hasUI: ctxSurface.hasUI,
    confirm: ctxSurface.confirm,
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
    `${names}\n\nProject agents are repo-controlled. Only continue for trusted repositories.\nTrust this project permanently via the host trust flow (~/.pi/agent/trust.json).`,
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
    `Agents:\n${listing}\n\nProject agents are repo-controlled. Only continue for trusted repositories.\nTrust this project permanently via the host trust flow (~/.pi/agent/trust.json).`,
  );
  if (!approved) {
    for (const { index, def } of gated)
      rejections.set(index, `Canceled: project-local agent "${def.name}" not approved.`);
  }
  return rejections;
}
