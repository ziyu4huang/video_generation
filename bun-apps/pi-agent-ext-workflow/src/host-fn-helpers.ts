/**
 * Deterministic helpers for the workflow `call('ns.name', args)` primitive.
 *
 * - `canonicalJSON` / `hashHostCall` — stable journal keys (T3).
 * - `runHostFnWithTimeout` — abort/timeout/schema/serializable gate (T4).
 *
 * Pure + dependency-light so every behavior is unit-testable in isolation.
 */

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
