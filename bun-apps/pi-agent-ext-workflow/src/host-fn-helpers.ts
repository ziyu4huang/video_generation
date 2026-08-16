/**
 * Deterministic helpers for the workflow `call('ns.name', args)` primitive.
 *
 * - `canonicalJSON` / `hashHostCall` — stable journal keys (T3).
 * - `runHostFnWithTimeout` — abort/timeout/schema/serializable gate (T4).
 *
 * Pure + dependency-light so every behavior is unit-testable in isolation.
 */

import { isWorkflowError, WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-core-runtime";
import { Check } from "typebox/value";
import type { HostFnCtx, HostFnEntry } from "./host-fn-registry.js";

/**
 * Stable canonical JSON: deeply sorted keys, no whitespace, cycle-guarded.
 * Two semantically-equal argument objects produce the same string regardless of
 * key insertion order, so the journal hash is order-independent.
 */
export function canonicalJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const seen = new WeakSet<object>();
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("cycle in host-fn args/result");
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(canon);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canon((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(canon(value));
}

/**
 * FNV-1a 32-bit over `canonicalJSON({ n: name, a: args })`. Deterministic and
 * dependency-free. Used as the journal replay key for a `call()` invocation.
 */
export function hashHostCall(name: string, args: unknown): string {
  const s = canonicalJSON({ n: name, a: args });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const DEFAULT_HOST_FN_TIMEOUT_MS = 30_000;

/**
 * Throw if `value` cannot be losslessly journaled as JSON. Rejects functions,
 * symbols, BigInt, and cycles anywhere in the structure (JSON.stringify silently
 * drops function/symbol properties — a real loss the journal must catch).
 */
function assertJsonSerializable(value: unknown): void {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (v === null) return;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return;
    if (t === "function" || t === "symbol" || t === "bigint") {
      throw new Error(`non-serializable ${t}`);
    }
    if (t !== "object") return; // undefined etc. — JSON drops benignly
    if (seen.has(v as object)) throw new Error("cycle");
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    for (const k of Object.keys(v as Record<string, unknown>)) walk((v as Record<string, unknown>)[k]);
  };
  walk(value);
}

/**
 * Run a host fn with: parent-signal abort, a timeout, output schema validation,
 * and a JSON-serializable check (so the journal can store the result). Errors
 * are classified into HOST_FN_{FAILED,TIMEOUT,SCHEMA,NON_SERIALIZABLE}; an
 * already-classified WorkflowError (or a parent-signal abort) passes through.
 */
export async function runHostFnWithTimeout(
  entry: HostFnEntry,
  args: unknown,
  ctx: HostFnCtx,
  name: string,
): Promise<unknown> {
  const timeoutMs = entry.timeoutMs ?? DEFAULT_HOST_FN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  const timeoutAc = new AbortController();
  if (ctx.signal) {
    onParentAbort = () => timeoutAc.abort();
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => entry.fn(args, ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new WorkflowError(`host fn '${name}' exceeded ${timeoutMs}ms`, WorkflowErrorCode.HOST_FN_TIMEOUT, {
              recoverable: true,
              agentLabel: name,
            }),
          );
        }, timeoutMs);
        timeoutAc.signal.addEventListener("abort", () => {
          if (timer) clearTimeout(timer);
          reject(new Error("aborted"));
        });
      }),
    ]);
    if (entry.schema && !Check(entry.schema, result)) {
      throw new WorkflowError(
        `host fn '${name}' returned a value that failed its schema`,
        WorkflowErrorCode.HOST_FN_SCHEMA,
        { recoverable: false, agentLabel: name },
      );
    }
    try {
      assertJsonSerializable(result);
    } catch {
      throw new WorkflowError(
        `host fn '${name}' returned a non-JSON-serializable value`,
        WorkflowErrorCode.HOST_FN_NON_SERIALIZABLE,
        { recoverable: false, agentLabel: name },
      );
    }
    return result;
  } catch (e) {
    // Already-classified WorkflowErrors (TIMEOUT/SCHEMA/NON_SERIALIZABLE) pass through.
    if (isWorkflowError(e)) throw e;
    // A parent-signal abort surfaces as a raw abort error; the runtime maps it
    // to WORKFLOW_ABORTED via isAbortError. Never rewrap it as HOST_FN_FAILED.
    if (ctx.signal?.aborted) throw e;
    throw new WorkflowError(
      `host fn '${name}' failed: ${e instanceof Error ? e.message : String(e)}`,
      WorkflowErrorCode.HOST_FN_FAILED,
      { recoverable: false, agentLabel: name, details: e },
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (onParentAbort && ctx.signal) ctx.signal.removeEventListener("abort", onParentAbort);
  }
}
