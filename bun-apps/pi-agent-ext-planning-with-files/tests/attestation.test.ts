import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestPlan, checkPlanAttestation } from "../src/attestation.js";
import { readPlanStatus } from "../src/plan.js";

const tempRoots: string[] = [];

function makeWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pwf-attest-"));
  tempRoots.push(cwd);
  return cwd;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeScopedPlan(cwd: string, content: string): void {
  const planDir = join(cwd, ".planning", "demo");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "task_plan.md"), content);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("checkPlanAttestation", () => {
  it("accepts a known-good SHA-256 attestation", () => {
    const cwd = makeWorkspace();
    const plan = "### Phase 1\n**Status:** complete\n";
    writeScopedPlan(cwd, plan);
    writeFileSync(join(cwd, ".planning", "demo", ".attestation"), sha256(plan));

    const result = checkPlanAttestation(readPlanStatus(cwd));

    expect(result).toMatchObject({
      enabled: true,
      tampered: false,
      expected: sha256(plan),
      actual: sha256(plan),
    });
  });

  it("rejects mutated plan content when the attestation hash no longer matches", () => {
    const cwd = makeWorkspace();
    const originalPlan = "### Phase 1\n**Status:** complete\n";
    const mutatedPlan = "### Phase 1\n**Status:** in_progress\n";
    writeScopedPlan(cwd, originalPlan);
    writeFileSync(join(cwd, ".planning", "demo", ".attestation"), sha256(originalPlan));
    writeFileSync(join(cwd, ".planning", "demo", "task_plan.md"), mutatedPlan);

    const result = checkPlanAttestation(readPlanStatus(cwd));

    expect(result.enabled).toBe(true);
    expect(result.tampered).toBe(true);
    expect(result.expected).toBe(sha256(originalPlan));
    expect(result.actual).toBe(sha256(mutatedPlan));
  });

  it("treats an invalid attestation file as a blocking mismatch", () => {
    const cwd = makeWorkspace();
    writeScopedPlan(cwd, "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(cwd, ".planning", "demo", ".attestation"), "not-a-sha256");

    const result = checkPlanAttestation(readPlanStatus(cwd));

    expect(result.enabled).toBe(true);
    expect(result.tampered).toBe(true);
    expect(result.expected).toBeUndefined();
    expect(result.actual).toBeUndefined();
  });

  it("is disabled when no attestation file exists", () => {
    const cwd = makeWorkspace();
    writeScopedPlan(cwd, "### Phase 1\n**Status:** complete\n");

    const result = checkPlanAttestation(readPlanStatus(cwd));

    expect(result.enabled).toBe(false);
    expect(result.tampered).toBe(false);
  });
});

describe("attestation scope isolation (regression: root + scoped coexistence)", () => {
  // Bug A: a stale root .plan-attestation (left by a previous root plan) must
  // NOT be matched against a scoped plan. Before the fix it caused every
  // scoped plan to read as [PLAN TAMPERED].
  it("a scoped plan ignores a stale root .plan-attestation (no false tamper)", () => {
    const cwd = makeWorkspace();
    const plan = "### Phase 1\n**Status:** complete\n";
    writeScopedPlan(cwd, plan);
    // Simulate a prior root-plan attestation lingering in the cwd.
    writeFileSync(join(cwd, ".plan-attestation"), sha256(`${plan}\nold-root-content`));

    const result = checkPlanAttestation(readPlanStatus(cwd));

    expect(result.enabled).toBe(false);
    expect(result.tampered).toBe(false);
  });

  // Bug B: attesting a scoped plan must create <planDir>/.attestation, not
  // clobber the root .plan-attestation. Before the fix pickWritePath reused
  // the existing root file.
  it("attesting a scoped plan writes <planDir>/.attestation and leaves the root file untouched", () => {
    const cwd = makeWorkspace();
    const plan = "### Phase 1\n**Status:** complete\n";
    writeScopedPlan(cwd, plan);
    const rootHash = sha256(`${plan}\nold-root-content`);
    writeFileSync(join(cwd, ".plan-attestation"), rootHash);

    const result = attestPlan(cwd, "attest");

    expect(result.ok).toBe(true);
    expect(result.attestationPath).toBe(join(cwd, ".planning", "demo", ".attestation"));
    // The scoped attestation file was created with the correct hash.
    expect(existsSync(join(cwd, ".planning", "demo", ".attestation"))).toBe(true);
    // The root file is untouched (not clobbered).
    expect(existsSync(join(cwd, ".plan-attestation"))).toBe(true);
    expect(readFileSync(join(cwd, ".plan-attestation"), "utf-8").trim()).toBe(rootHash);
  });
});
