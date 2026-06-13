import { describe, it, expect } from "bun:test";
import path from "path";

// Smoke test for check-runtime. The script exercises buildCliArgs() with
// synthesized params and asserts the output against run.py's argparse contract,
// so its findings depend on live drift state — we assert STRUCTURE + a known
// regression (the --blur-ref control-mismatch), not "zero findings".

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

describe("check-runtime", () => {
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

  it("detects the known --blur-ref control-mismatch (GUI toggle vs run.py float)", () => {
    // Regression guard: blur_ref is a GUI toggle (emits a bare --blur-ref) but
    // run.py's --blur-ref is type=float. check-runtime MUST surface this — it is
    // exactly the integration bug check-schema cannot see (it never compares
    // control/type). If this fails, the runtime check has regressed.
    const { json } = runJson();
    const blurRef = json.findings.find(
      (f: any) => f.flag === "--blur-ref" && f.violation === "control-mismatch",
    );
    expect(blurRef).toBeDefined();
    expect(String(blurRef.expected)).toContain("float");
  });
});
