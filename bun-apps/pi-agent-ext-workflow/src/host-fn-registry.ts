import type { TSchema } from "typebox";

/** Context handed to every host fn. The runtime is vault-agnostic. */
export interface HostFnCtx {
  cwd: string;
  signal: AbortSignal;
  runId: string;
}

export interface HostFnEntry {
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
