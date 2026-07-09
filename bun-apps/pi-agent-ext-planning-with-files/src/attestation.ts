/**
 * SHA-256 plan attestation.
 *
 * Ported from the upstream planning-with-files Pi adapter (v3.4.0). Uses
 * node:crypto — no Python, no shell. `checkPlanAttestation` is the read-side
 * (used by the runtime on every injection); `attestPlan` is the write-side that
 * replaces the legacy `scripts/attest-plan.sh` (modes: attest / --show / --clear).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TAMPERED_PREFIX } from "./constants.js";
import { type PlanStatus, readPlanStatus } from "./plan.js";

export interface AttestationCheck {
  enabled: boolean;
  tampered: boolean;
  expected?: string;
  actual?: string;
  attestationPath?: string;
}

export type AttestMode = "attest" | "show" | "clear";

export interface AttestResult {
  ok: boolean;
  mode: AttestMode;
  message: string;
  /** The attestation file path that was read/written, if any. */
  attestationPath?: string;
  /** The resolved plan file path, if a plan was found. */
  planPath?: string;
}

function normalizeHash(value: string): string | undefined {
  const hash = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return undefined;
  return hash;
}

function sha256Bytes(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sha256File(path: string): string | undefined {
  try {
    return sha256Bytes(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Pick the attestation path to write to for a given plan.
 *
 * Mirrors attest-plan.sh: for a scoped plan (`.planning/<id>/`) the attestation
 * lives at `<planDir>/.attestation`; for the legacy root plan it lives at
 * `<cwd>/.plan-attestation`. When an attestation candidate already exists we
 * reuse it (so `/plan-attest --clear` removes the same file `/plan-attest`
 * wrote).
 */
function pickWritePath(status: PlanStatus): string | undefined {
  const existing = status.attestationCandidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;

  if (status.scope === "scoped" && status.planDir) {
    return join(status.planDir, ".attestation");
  }
  if (status.scope === "root" && status.cwd) {
    return join(status.cwd, ".plan-attestation");
  }
  return status.attestationCandidates[0];
}

export function checkPlanAttestation(status: PlanStatus): AttestationCheck {
  if (!status.exists || !status.planPath) {
    return { enabled: false, tampered: false };
  }

  const attestationPath = status.attestationCandidates.find((candidate) => existsSync(candidate));
  if (!attestationPath) {
    return { enabled: false, tampered: false };
  }

  const expected = normalizeHash(readFileSync(attestationPath, "utf-8"));
  if (!expected) {
    return { enabled: true, tampered: true, attestationPath };
  }

  const actual = sha256File(status.planPath);
  if (!actual) {
    return { enabled: true, tampered: true, expected, attestationPath };
  }

  return {
    enabled: true,
    tampered: actual !== expected,
    expected,
    actual,
    attestationPath,
  };
}

/**
 * Build the "[PLAN TAMPERED]" block shown to the user / injected when the
 * attestation hash no longer matches the plan content.
 */
export function buildTamperMessage(status: PlanStatus): string {
  const attestation = checkPlanAttestation(status);
  return [
    TAMPERED_PREFIX,
    attestation.expected ? `expected=${attestation.expected}` : "expected=<missing or invalid>",
    attestation.actual ? `actual=  ${attestation.actual}` : "actual=  <unreadable>",
    "Run /plan-attest to re-approve current contents, or restore the file from git.",
  ].join("\n");
}

/**
 * Atomic write of the attestation hash. Writes to a temp file then renames, so a
 * concurrent verifier (another session) never reads a torn 64-hex string.
 * Returns false if the final on-disk content does not match the intended hash.
 */
function writeAttestationAtomic(attestationPath: string, hash: string): boolean {
  const tmp = `${attestationPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${hash}\n`);
    renameSync(tmp, attestationPath);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    return false;
  }

  // Read-back verification (parity with attest-plan.sh's integrity check).
  const stored = normalizeHash(readFileSync(attestationPath, "utf-8"));
  return stored === hash;
}

/**
 * Port of `scripts/attest-plan.sh`. Resolves the active plan, computes its
 * SHA-256, and either writes/shows/clears the attestation. Pure TS — no shelling
 * out, no Python.
 *
 * @param cwd   project working directory
 * @param mode  "attest" (default) | "show" | "clear"
 */
export function attestPlan(cwd: string, mode: AttestMode = "attest"): AttestResult {
  const status = readPlanStatus(cwd);
  if (!status.exists || !status.planPath) {
    return {
      ok: false,
      mode,
      message: "[plan-attest] No task_plan.md found. Create a plan first.",
    };
  }

  const attestationPath = pickWritePath(status);
  if (!attestationPath) {
    return { ok: false, mode, message: "[plan-attest] Could not resolve an attestation path." };
  }

  if (mode === "show") {
    if (!existsSync(attestationPath)) {
      return {
        ok: false,
        mode,
        message: `[plan-attest] No attestation set for ${status.planPath}.`,
      };
    }
    const hash = readFileSync(attestationPath, "utf-8").trim();
    return {
      ok: true,
      mode,
      attestationPath,
      planPath: status.planPath,
      message: `Plan: ${status.planPath}\nAttestation: ${attestationPath}\nSHA-256: ${hash}`,
    };
  }

  if (mode === "clear") {
    if (!existsSync(attestationPath)) {
      return { ok: true, mode, message: "[plan-attest] No attestation to clear." };
    }
    try {
      unlinkSync(attestationPath);
    } catch (err) {
      return { ok: false, mode, message: `[plan-attest] Failed to clear: ${String(err)}` };
    }
    return {
      ok: true,
      mode,
      attestationPath,
      planPath: status.planPath,
      message: `[plan-attest] Cleared attestation for ${status.planPath}.`,
    };
  }

  // mode === "attest"
  const hash = sha256File(status.planPath);
  if (!hash) {
    return {
      ok: false,
      mode,
      planPath: status.planPath,
      message: `[plan-attest] Could not hash ${status.planPath}.`,
    };
  }

  if (!writeAttestationAtomic(attestationPath, hash)) {
    return {
      ok: false,
      mode,
      attestationPath,
      planPath: status.planPath,
      message: `[plan-attest] Attestation write verification FAILED for ${attestationPath}.`,
    };
  }

  const short = hash.slice(0, 12);
  return {
    ok: true,
    mode,
    attestationPath,
    planPath: status.planPath,
    message: [
      `[plan-attest] Locked ${status.planPath}`,
      `[plan-attest] SHA-256: ${short}... (stored in ${attestationPath})`,
      "[plan-attest] Hooks will block injection if the file is modified without re-running this command.",
    ].join("\n"),
  };
}
