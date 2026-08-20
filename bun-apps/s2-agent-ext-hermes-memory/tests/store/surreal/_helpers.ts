import { describe } from "bun:test";

/** Probe the local SurrealDB service once at import time. */
export async function isSurrealUp(endpoint = "http://127.0.0.1:8000"): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${endpoint}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

/**
 * describe, or describe.skip when the local service is absent.
 * Idiomatic describe(name, body) shape — when `up` is false, the whole
 * block (including inner `it`s) is skipped.
 */
export function localDescribe(
  name: string,
  up: boolean,
  body: () => void,
): ReturnType<typeof describe> {
  return (up ? describe : (describe.skip as typeof describe))(name, body);
}

/** A throwaway namespace name so concurrent test runs never collide. */
let nonce = 0;
export function uniqueNs(): string {
  nonce += 1;
  // Avoid Math.random (not allowed in some runtimes) — use process pid + counter.
  return `hm_test_${process.pid}_${nonce}_${Date.now().toString(36)}`;
}
