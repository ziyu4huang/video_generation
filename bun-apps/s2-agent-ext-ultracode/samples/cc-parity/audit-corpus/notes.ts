// Audit corpus fixture (B1) — clean file, no TODO/FIXME markers.
export const MAX_RETRIES = 3;
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
