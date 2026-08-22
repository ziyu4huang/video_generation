// find-polluter.ts parity: the portable bun twin must byte-match the old
// find-polluter.sh stdout + exit codes.
//
// Provenance — goldens captured 2026-08-23 from the live old script:
//   bun-apps/s2-agent-ext-superpowers/skills/systematic-debugging/find-polluter.sh
//   (HEAD b69d3e3d — last commit before conversion; file deleted when parity
//   went green), run via `bash <abs>/find-polluter.sh <args>` from the fixture
//   cwd; stdout + rc recorded verbatim. Normalization: NONE — byte-exact.
//
// MEASURED divergences from the brief's Step-1 claims (capture, not assumed;
// same class of gap the dedup task documented for its usage case):
//   * wrong-arg-count: the two usage lines go to STDOUT (plain `echo`, no
//     >&2), stderr stays empty — exit 1. The brief said "stderr"; measured
//     says stdout, so the case pins `out` instead of `errIncludes`.
//   * `find . -path 'src/**/*.test.ts'` NEVER matches anything: find . emits
//     ./-prefixed pathnames, and the pre-fix script matches the pattern
//     verbatim against them — the doc example has no ./ prefix, so the
//     bisection loop would read zero files and the ⚠️ skip line could never
//     print. The fixture therefore passes the pattern WITH its ./ prefix
//     (measured to match), which exercises the skip branch the brief pins
//     (`⚠️  Pollution already exists before test 1/1` + `✅ No polluter
//     found`). The upstream-fixed find-polluter.sh (obra/superpowers master)
//     strips the ./ prefix and also fixes the `**/`-empty-level gap — noted as
//     a follow-up concern, NOT ported here: D3's discipline is byte-parity
//     with the script being replaced, and a behavior fix belongs to its own
//     SDD decision.
//   * TOTAL with zero matches: `echo "$TEST_FILES" | wc -l` counts 1 (echo of
//     an empty string still emits one newline) — the .sh's quirk, mirrored.
//
// The usage golden embeds the script path ($0 / argv[1]): bash keeps the path
// as invoked, bun normalizes argv[1] to absolute — so the expected usage
// output is built from the absolute script path this test itself spawns,
// making the golden byte-deterministic on any host. A sibling run of the old
// .sh differs only in the .sh/.ts extension bytes.

import { afterAll, beforeAll, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertParity } from "../../tests/helpers/bash-parity"; // bun-apps/tests/helpers (two levels up: pkg/tests -> bun-apps)

// Absolute script path — the harness spawns `bun <scriptPath>` with the case
// cwd, and the fixture case must run *inside* the fixture dir (the script
// searches `.`), so the path cannot be package-relative.
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_ABS = join(PKG_DIR, "skills/systematic-debugging/find-polluter.ts");

// Hermetic fixture: tmpdir with the pollution sentinel present from the start
// and one test file matching the (./ -prefixed) pattern. The sentinel path is
// NOT embedded in the goldens (find emits ./-relative paths), so a mkdtemp
// fixture is byte-stable on any host.
const FIXTURE = mkdtempSync(join(tmpdir(), "fp-polluter-"));

beforeAll(() => {
  mkdirSync(join(FIXTURE, "src/sub"), { recursive: true });
  writeFileSync(join(FIXTURE, "src/sub/a.test.ts"), "describe('a', () => it('a', () => {}));\n");
  writeFileSync(join(FIXTURE, ".POLLUTER"), "");
});

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

// ── goldens (verbatim from find-polluter.sh@b69d3e3d, captured 2026-08-23) ────

// (b) pre-existing pollution: sentinel present before test 1/1 → skip line,
//     never reaches `npm test`, ends clean, exit 0.
const POLLUTION_GOLDEN = `🔍 Searching for test that creates: .POLLUTER
Test pattern: ./src/**/*.test.ts

Found 1 test files

⚠️  Pollution already exists before test 1/1
   Skipping: ./src/sub/a.test.ts

✅ No polluter found - all tests clean!`;

// (a) no args: two usage lines to STDOUT, exit 1 (measured — not stderr).
const USAGE_GOLDEN = `Usage: ${SCRIPT_ABS} <file_to_check> <test_pattern>
Example: ${SCRIPT_ABS} '.git' 'src/**/*.test.ts'`;

test("find-polluter.ts usage — no args (exit 1, usage to stdout)", () => {
  assertParity(SCRIPT_ABS, [{ name: "usage-no-args", args: [], cwd: PKG_DIR, expectCode: 1, out: USAGE_GOLDEN }]);
});

test("find-polluter.ts pre-existing pollution fixture (skip line, exit 0, no npm test)", () => {
  assertParity(SCRIPT_ABS, [
    {
      name: "pre-existing-pollution",
      args: [".POLLUTER", "./src/**/*.test.ts"],
      cwd: FIXTURE,
      expectCode: 0,
      out: POLLUTION_GOLDEN,
    },
  ]);
});
