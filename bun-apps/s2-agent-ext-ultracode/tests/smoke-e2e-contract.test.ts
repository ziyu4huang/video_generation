// smoke-e2e.ts contract — the portable bun twin of the retired
// samples/smoke-e2e.sh. The old script's happy path is a LIVE LM Studio model
// call (run-test's `smoke` tier) — deliberately NEVER asserted here; the
// deterministic-e2e contract is:
//
//   1. missing workflow file -> stderr `workflow file not found: <path>` (the
//      path verbatim, no resolution/normalization) + exit 2, stdout empty
//   2. default workflow = samples/dynamic-workflow-smoke01.js
//   3. PI_MODEL forwarding: unset/empty -> `--model google/gemma-4-12b` (the
//      old `${PI_MODEL:-…}` default), set -> forwarded verbatim
//   4. strict prompt relayed byte-for-byte: the tool-invocation framing text
//      + the workflow script content verbatim (the whole point of the strict
//      prompt is that the model cannot invent a 4-phase workflow)
//   5. one-shot semantics: the CLI's exit code becomes the smoke's exit code
//      (old: `exec bun …cli.ts …`; new: process.exit(child.status))
//
// The CLI hop is stubbed via SMOKE_E2E_CLI (test-only env override; defaults to
// the real bun-apps/s2-agent/src/cli.ts): a fake cli that dumps its argv as
// JSON and exits 42. No model, no LM Studio, no pi agent — the wiring under
// test is argv construction + prompt build + exit-code pass-through.

import { afterAll, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertParity } from "../../tests/helpers/bash-parity"; // bun-apps/tests/helpers (two levels up: pkg/tests -> bun-apps)

const SAMPLES = resolve(fileURLToPath(new URL("..", import.meta.url)), "samples");
const SMOKE = resolve(SAMPLES, "smoke-e2e.ts");
const WF = resolve(SAMPLES, "dynamic-workflow-smoke01.js");

// The strict-prompt framing — the deterministic-e2e contract. The workflow
// script content is read at test time so the golden tracks the sample script's
// bytes. Keep these lines character-for-character in sync with the .sh they
// ported (the A/B diff in the task verified the framing verbatim). Trailing
// newlines are stripped the way the .sh's `$(cat …)` command substitution did.
const WF_SCRIPT = readFileSync(WF, "utf8").replace(/\n+$/, "");
const STRICT_PROMPT = `Call the workflow tool now with background=false and this EXACT script value (do not modify it, do not wrap in fences, do not write your own script):

${WF_SCRIPT}

Return only the workflow result.`;

const DEFAULT_MODEL = "google/gemma-4-12b";

// Test-only fake cli: dumps argv (after bun + script path) as one JSON line and
// exits 42 — pins the exact argv build AND the one-shot exit-code pass-through.
const TMP = mkdtempSync(join(tmpdir(), "smoke-e2e-contract-"));
const FAKE_CLI = join(TMP, "fake-cli.ts");
writeFileSync(FAKE_CLI, "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(42);\n");

// `-e` must be the engine's real entry path (pi resolves bare names as
// cwd-relative paths — fixed 2026-08-25, cc-parity t03): the golden pins the
// repo-root-resolved path.
const EXT_ENTRY = resolve(SAMPLES, "../extensions/ultracode.ts");
const cliArgs = (model: string): string[] => ["-e", EXT_ENTRY, "--model", model, "-p", STRICT_PROMPT];

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("smoke-e2e contract — missing workflow file (exit 2 + verbatim stderr)", () => {
  const missing = "smoke-e2e-does-not-exist.js"; // relative: the path in the message is the arg verbatim
  assertParity(SMOKE, [
    {
      name: "missing workflow file",
      args: [missing],
      env: { PI_MODEL: "" },
      expectCode: 2,
      out: "",
      errIncludes: [`workflow file not found: ${missing}`],
    },
  ]);
});

test("smoke-e2e contract — default model + strict prompt (fake cli, no live model)", () => {
  assertParity(SMOKE, [
    {
      name: "default model and strict prompt",
      args: [], // default workflow file
      env: { SMOKE_E2E_CLI: FAKE_CLI, PI_MODEL: "" },
      expectCode: 42, // one-shot: the CLI's exit code becomes the smoke's
      out: JSON.stringify(cliArgs(DEFAULT_MODEL)),
    },
  ]);
});

test("smoke-e2e contract — PI_MODEL override forwarded to --model", () => {
  assertParity(SMOKE, [
    {
      name: "PI_MODEL override",
      args: [],
      env: { SMOKE_E2E_CLI: FAKE_CLI, PI_MODEL: "custom/zz-model-9b" },
      expectCode: 42,
      out: JSON.stringify(cliArgs("custom/zz-model-9b")),
    },
  ]);
});
