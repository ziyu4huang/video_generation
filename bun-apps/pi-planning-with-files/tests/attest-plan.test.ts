import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestPlan } from "../src/attestation.js";

const tempRoots: string[] = [];

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function makeScoped(cwd: string, plan: string): void {
  const planDir = join(cwd, ".planning", "demo");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "task_plan.md"), plan);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("attestPlan (pure-TS port of attest-plan.sh)", () => {
  it("attest mode writes the correct SHA-256 to <planDir>/.attestation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pwf-attestplan-"));
    tempRoots.push(cwd);
    const plan = "### Phase 1\n**Status:** complete\n";
    makeScoped(cwd, plan);

    const result = attestPlan(cwd, "attest");

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("attest");
    expect(result.attestationPath).toBe(join(cwd, ".planning", "demo", ".attestation"));
    const attestationPath = result.attestationPath;
    if (!attestationPath) throw new Error("attestationPath missing after attest");
    const stored = readFileSync(attestationPath, "utf-8").trim();
    expect(stored).toBe(sha256(plan));
  });

  it("show mode reads back the stored hash", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pwf-attestplan-"));
    tempRoots.push(cwd);
    const plan = "### Phase 1\n**Status:** complete\n";
    makeScoped(cwd, plan);
    attestPlan(cwd, "attest");

    const result = attestPlan(cwd, "show");

    expect(result.ok).toBe(true);
    expect(result.message).toContain(sha256(plan));
  });

  it("clear mode removes the attestation file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pwf-attestplan-"));
    tempRoots.push(cwd);
    makeScoped(cwd, "### Phase 1\n**Status:** complete\n");
    attestPlan(cwd, "attest");
    expect(existsSync(join(cwd, ".planning", "demo", ".attestation"))).toBe(true);

    const result = attestPlan(cwd, "clear");

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, ".planning", "demo", ".attestation"))).toBe(false);
  });

  it("fails gracefully when no plan exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pwf-attestplan-"));
    tempRoots.push(cwd);

    const result = attestPlan(cwd, "attest");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No task_plan.md");
  });

  it("legacy root plan writes attestation to <cwd>/.plan-attestation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pwf-attestplan-"));
    tempRoots.push(cwd);
    const plan = "### Phase 1\n**Status:** complete\n";
    writeFileSync(join(cwd, "task_plan.md"), plan);

    const result = attestPlan(cwd, "attest");

    expect(result.ok).toBe(true);
    expect(result.attestationPath).toBe(join(cwd, ".plan-attestation"));
  });
});
