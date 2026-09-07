// Audit corpus fixture (B1) — carries the PLANTED issue the audit sample
// must surface. The leftover TODO is intentional; do not remove it.
export function debounce(fn: () => void, ms: number): () => void {
  // TODO: cancel the pending timer on re-invoke (planted for the B1 sample).
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    t = setTimeout(fn, ms);
  };
}
