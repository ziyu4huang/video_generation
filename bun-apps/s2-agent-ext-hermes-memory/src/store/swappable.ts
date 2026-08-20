/**
 * swappable — a Proxy that forwards every property access to the object
 * returned by `getTarget()` AT CALL TIME.
 *
 * Used by pi-hermes-memory so the tools/handlers can capture ONE stable repo
 * reference at registration time, yet transparently follow a LIVE backend
 * switch (see `/memory-switch-backend`): the captured ref always delegates to
 * whichever MemoryRepository / SessionRepository is current. No tool or
 * handler signature needs to change — they keep receiving "a repo".
 *
 * - Methods are bound to the live target so `this` is correct.
 * - Non-function properties pass through.
 * - Identity (`===`) / `instanceof` intentionally do NOT match the target —
 *   repos are never compared that way.
 */
export function asSwappable<T extends object>(getTarget: () => T): T {
	return new Proxy({} as T, {
		get(_target, prop) {
			const target = getTarget();
			const value = Reflect.get(target as object, prop);
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	}) as T;
}
