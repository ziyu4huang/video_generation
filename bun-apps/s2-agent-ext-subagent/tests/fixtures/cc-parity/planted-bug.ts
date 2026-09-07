/**
 * CC-parity code-reviewer sample fixture (consumed by
 * tests/cc-parity-subagent.test.ts, sample A4 — the canonical read-only
 * code-reviewer pattern from Claude Code's sub-agents doc).
 *
 * The off-by-one in `sumTo` is INTENTIONAL: it is the planted defect the
 * reviewer sample must surface. Do not fix it — A4 asserts the file is
 * byte-unchanged across the review (sha256 before === after).
 */
export function sumTo(n: number): number {
  let total = 0;
  // PLANTED BUG: `i < n` drops the final addend — sumTo(4) yields 6, not 10.
  for (let i = 0; i < n; i++) {
    total += i;
  }
  return total;
}
