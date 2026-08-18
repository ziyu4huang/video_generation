import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import path from "path";
import { resolvePythonBin } from "../lib/pythonBin";

// Smoke test for check-runtime. The script exercises buildCliArgs() with
// synthesized params and asserts the output against run.py's argparse contract,
// so its findings depend on live drift state — we assert STRUCTURE + a
// regression guard (--blur-ref was a GUI toggle vs run.py float; now fixed, so
// we assert it stays aligned), not "zero findings".

const SCRIPT = path.join(import.meta.dir, "check-runtime.ts");
const ALLOWED = new Set([
  "flag-accepted", "choice-valid", "type-valid",
  "control-mismatch", "required-present", "build-error",
]);

function runJson(): { json: any; exitCode: number | null } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, "--json"], {
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  return { json: JSON.parse(stdout), exitCode: proc.exitCode };
}

// Machine-coupled: check-runtime.ts probes run.py's argparse contract via the
// local MLX venv (python/venv/bin/python). GitHub Actions runners have neither
// the venv nor Apple-Silicon Metal, so the probe returns no parseable JSON and
// these assertions can't hold. Skip under CI=true (set automatically by GitHub
// Actions). See .github/CI.md. Runs locally (CI unset) where the venv exists.
// Also skips locally when the venv is absent (e.g. right after `git clean -dxf`
// or a fresh clone, before `bash scripts/setup-offline.sh` recreates it) so a
// clean tree produces clean skips, not red ENOENT JSON-parse failures.
const VENV_PRESENT = existsSync(resolvePythonBin());
describe.skipIf(Boolean(process.env.CI) || !VENV_PRESENT)("check-runtime", () => {
  it("emits a well-formed JSON contract", () => {
    const { json } = runJson();
    expect(typeof json.findingCount).toBe("number");
    expect(typeof json.errorCount).toBe("number");
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.findingCount).toBe(json.findings.length);
  });

  it("every finding has the required shape and a known violation type", () => {
    const { json } = runJson();
    for (const f of json.findings) {
      for (const k of ["action", "set", "flag", "violation", "emitted", "expected"]) {
        expect(f).toHaveProperty(k);
      }
      expect(ALLOWED.has(f.violation)).toBe(true);
    }
  });

  it("exits 1 iff hard errors exist (choice-valid warnings don't fail the run)", () => {
    const { json, exitCode } = runJson();
    const hardErrors = json.findings.filter((f: any) => f.violation !== "choice-valid");
    expect(Boolean(exitCode)).toBe(hardErrors.length > 0);
    expect(json.errorCount).toBe(hardErrors.length);
  });

  it("verifies --blur-ref is aligned (GUI range → run.py float, no control-mismatch)", () => {
    // Regression guard: blur_ref WAS a GUI toggle (emitted a bare --blur-ref)
    // while run.py's --blur-ref is type=float — exactly the integration bug
    // check-schema cannot see (it never compares control/type). Fixed
    // 2026-06-14: GUI controlnet + i2i schemas now declare control="range".
    // This test guards against regressing back to a toggle. check-runtime's
    // ability to DETECT such mismatches is still exercised — it surfaces the
    // controlnet --controlnet-type choice-valid warnings in the run above.
    const { json } = runJson();
    const blurRefMismatch = json.findings.find(
      (f: any) => f.flag === "--blur-ref" && f.violation === "control-mismatch",
    );
    expect(blurRefMismatch).toBeUndefined();
  });
});
