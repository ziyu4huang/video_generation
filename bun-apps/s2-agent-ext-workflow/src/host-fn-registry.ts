import type { TSchema } from "typebox";

/** Options for HostFnCtx.ask — a structural subset of workflow CheckpointOptions
 *  (kept local to avoid a circular import workflow → host-fn-registry).
 *  Mirrors the fields a host-fn author would set: default, headless, kind, choices. */
export interface HostFnAskOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
}

/** Context handed to every host fn. The runtime is vault-agnostic. */
export interface HostFnCtx {
  cwd: string;
  signal: AbortSignal;
  runId: string;
  /**
   * Ask the human a question mid-host-fn; resolves to their reply. Present iff
   * the run is UI-bearing (threaded from the same confirm() checkpoint() uses);
   * undefined in headless/background runs — the host-fn must then fall back to
   * its own default. The host-fn RESULT (shaped by the answer) is journaled by
   * call(), so a journal replay never re-asks. Host-fns run INLINE in the
   * workflow runtime (not in subagents), so this callback reaches the main
   * session's UI directly. */
  ask?: (promptText: string, options?: HostFnAskOptions) => Promise<unknown>;
}

export interface HostFnEntry {
  fn: (args: unknown, ctx: HostFnCtx) => Promise<unknown> | unknown;
  schema?: TSchema;
  timeoutMs?: number;
}

/** Payload shape extensions emit over the `workflow:hostfn:v1:register` event bus. */
export interface HostFnRegistrationPayload {
  ns: string;
  name: string;
  fn: (args: unknown, ctx: HostFnCtx) => Promise<unknown> | unknown;
  schema?: TSchema;
  timeoutMs?: number;
}

/** 'ns.name' — one dot, lowercase alnum + hyphens on each side. */
const NAME_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/i;

/**
 * Session-scoped registry of deterministic host functions addressable as
 * `call('ns.name', args)` from workflow scripts. Extensions register over the
 * `workflow:hostfn:v1:*` event bus; re-registering the same name overwrites
 * (idempotent). The registry is built at extension load / runWorkflow() start
 * and is read-only from a script's perspective.
 */
export class HostFnRegistry {
  private readonly fns = new Map<string, HostFnEntry>();

  set(name: string, entry: HostFnEntry): void {
    if (!NAME_RE.test(name)) {
      throw new TypeError(`host-fn name must be 'ns.name' (got '${name}')`);
    }
    this.fns.set(name, entry);
  }

  get(name: string): HostFnEntry | undefined {
    return this.fns.get(name);
  }

  has(name: string): boolean {
    return this.fns.has(name);
  }

  list(): string[] {
    return [...this.fns.keys()].sort();
  }
}

/**
 * Apply one `workflow:hostfn:v1:register` event payload to a registry. Pure +
 * defensive: malformed payloads are ignored (no throw), so a misbehaving peer
 * extension cannot break the workflow runtime. Re-registering the same name
 * overwrites (idempotent → safe under load-order re-solicitation).
 */
export function applyHostFnRegistration(registry: HostFnRegistry, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as Partial<HostFnRegistrationPayload>;
  if (typeof p.ns !== "string" || typeof p.name !== "string" || typeof p.fn !== "function") return;
  try {
    registry.set(`${p.ns}.${p.name}`, { fn: p.fn, schema: p.schema, timeoutMs: p.timeoutMs });
  } catch (e) {
    console.warn(`[workflow] host-fn register rejected: ${(e as Error).message}`);
  }
}
