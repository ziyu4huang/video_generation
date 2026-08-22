// smoke.ts parity: the portable bun twin must byte-match the old smoke.sh
// stdout + exit code.
//
// Provenance — golden captured 2026-08-23 from the live old script:
//   bun-apps/s2-agent-ext-power-tool/skills/playwright-cli/scripts/smoke.sh@072bfaa8
//   (last commit touching it before conversion; file deleted when parity went green)
//   run via `bash skills/playwright-cli/scripts/smoke.sh` from the power-tool
//   package root — stdout + rc recorded verbatim:
//     ok: bunx playwright-cli --version => 0.1.17 (== pinned @playwright/cli)
//     ok: bunx playwright-cli list
//     playwright-cli skill smoke: PASS
//     rc=0
//   Normalization: NONE. The only run-varying byte is the version digit, pinned
//   here from the SAME node_modules/@playwright/cli/package.json the old script
//   greps (extraction mirrored verbatim — see PINNED), so the golden is
//   byte-stable on any host whose `bun install` produced a matching dep tree.
//   The smoke silences `bunx playwright-cli list`'s own output (>/dev/null 2>&1
//   in the .sh; buffered-and-discarded in the .ts), so "  (no browsers)" is part
//   of neither side's stdout.
//
// Skip guard: node_modules/@playwright/cli/package.json absent → nothing is
// measured (the script would fail its own preflight; goldens unevaluable).
// Mirrors the old script's `|| fail "…run 'bun install'"` precondition.

import { test } from "bun:test";
import { assertParity } from "../../tests/helpers/bash-parity"; // bun-apps/tests/helpers (two levels up: pkg/tests -> bun-apps)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The smoke.ts path is package-relative (spawned via `bun skills/.../smoke.ts`
// from the package root — the contract in the plan). Resolve the package root
// from this test file's own URL so the test works from any cwd.
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const SMOKE = "skills/playwright-cli/scripts/smoke.ts";
const PINNED_PKG = join(PKG_DIR, "node_modules/@playwright/cli/package.json");

if (!existsSync(PINNED_PKG)) {
  test.skip("smoke.ts parity (playwright-cli) — SKIPPED: node_modules/@playwright/cli absent, run 'bun install'", () => {});
} else {
  // Old extraction, mirrored verbatim so golden and smoke agree on the exact
  // string even for a suffixed version: first line containing `"version"`,
  // first semver triple on it (`grep -m1 '"version"' | grep -oE '...'`).
  const PINNED = readFileSync(PINNED_PKG, "utf8")
    .split("\n")
    .find((l) => l.includes('"version"'))!
    .match(/\d+\.\d+\.\d+/)![0];

  const SMOKE_GOLDEN = `ok: bunx playwright-cli --version => ${PINNED} (== pinned @playwright/cli)
ok: bunx playwright-cli list
playwright-cli skill smoke: PASS`;

  test("smoke.ts parity (playwright-cli)", () => {
    assertParity(SMOKE, [
      { name: "smoke", args: [], cwd: PKG_DIR, expectCode: 0, out: SMOKE_GOLDEN },
    ]);
  });
}
