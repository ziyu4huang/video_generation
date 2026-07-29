/**
 * Glanceable relative + absolute time formatters for the /subagents viewer.
 * `formatRelativeTime` takes an injectable `nowMs` so tests are deterministic.
 */
export function formatRelativeTime(startedAtMs: number, nowMs: number = Date.now()): string {
  const delta = Math.max(0, nowMs - startedAtMs);
  const sec = 1000;
  const min = 60 * sec;
  const hr = 60 * min;
  const day = 24 * hr;
  if (delta < min) return "just now";
  if (delta < hr) return `${Math.floor(delta / min)}m ago`;
  if (delta < day) return `${Math.floor(delta / hr)}h ago`;
  return `${Math.floor(delta / day)}d ago`;
}

export function formatAbsoluteTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}
