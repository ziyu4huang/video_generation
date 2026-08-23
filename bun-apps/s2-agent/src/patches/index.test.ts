import { describe, expect, test } from "bun:test";
import {
  applyPatches,
  envFlag,
  PATCH_TABLE,
  resolvePatchPlan,
  type AppliedPatch,
  type PatchEntry,
} from "./index.ts";

describe("envFlag", () => {
  const E = (k: string, v: string | undefined) => (v === undefined ? {} : { [k]: v });

  test("undefined → fallback", () => {
    expect(envFlag("X", true, {})).toBe(true);
    expect(envFlag("X", false, {})).toBe(false);
  });

  test('"1" → true', () => {
    expect(envFlag("X", false, E("X", "1"))).toBe(true);
  });

  test('"true" / "TRUE" / "Yes" / "YES" are truthy (case-insensitive)', () => {
    for (const v of ["true", "TRUE", "True", "yes", "YES", "Yes"]) {
      expect(envFlag("X", false, E("X", v))).toBe(true);
    }
  });

  test('other set values are false (explicit opt-off: "0", "false", "no", "")', () => {
    for (const v of ["0", "false", "no", "off", "", "anything-else"]) {
      expect(envFlag("X", true, E("X", v))).toBe(false);
    }
  });

  test("does not read process.env when env passed explicitly (purity)", () => {
    // process.env.X may be set in the real env; passing {} ignores it.
    process.env.__envFlagProbe = "1";
    try {
      expect(envFlag("__envFlagProbe", false, {})).toBe(false); // {} → fallback
      expect(envFlag("__envFlagProbe", false, process.env)).toBe(true); // real env
    } finally {
      delete process.env.__envFlagProbe;
    }
  });
});

describe("PATCH_TABLE", () => {
  test("names are unique", () => {
    const names = PATCH_TABLE.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("env vars are unique", () => {
    const envs = PATCH_TABLE.map((p) => p.env);
    expect(new Set(envs).size).toBe(envs.length);
  });

  test("every entry defaults to enabled (patches opt-OFF, not opt-IN)", () => {
    for (const e of PATCH_TABLE) expect(e.defaultValue).toBe(true);
  });

  test("covers all known patches", () => {
    expect(PATCH_TABLE.map((p) => p.name).sort()).toEqual(
      [
        "autocomplete-source-extension",
        "colliding-command-dispatch",
        "default-model-env",
        "editor-history-restore",
        "ensure-extension-deps",
        "ensure-model-tiers",
        "ext-api-get-all-tool-definitions",
        "ext-context-get-system-prompt-options",
        "footer-extension-status-notify",
        "force-response-language",
        "in-memory-models-store",
        "load-run-dir-resources",
        "pre-load-providers",
        "skip-update-check",
        "startup-history-hint",
        "subagent-model-floor",
      ],
    );
  });
});

describe("resolvePatchPlan (pure decision)", () => {
  test("all enabled by default (empty env)", () => {
    const plan = resolvePatchPlan(PATCH_TABLE, {});
    expect(plan).toHaveLength(PATCH_TABLE.length);
    for (const p of plan) expect(p.applied).toBe(true);
  });

  test("an explicit '0' disables only that patch", () => {
    const plan = resolvePatchPlan(PATCH_TABLE, { BUN_PI_SKIP_UPDATE_CHECK: "0" });
    const skipped = plan.find((p) => p.name === "skip-update-check")!;
    expect(skipped.applied).toBe(false);
    // everyone else still applied
    for (const p of plan) {
      if (p.name !== "skip-update-check") expect(p.applied).toBe(true);
    }
  });

  test("returned entries echo table metadata (name/env/defaultValue)", () => {
    const plan = resolvePatchPlan(PATCH_TABLE, {});
    for (let i = 0; i < PATCH_TABLE.length; i++) {
      expect(plan[i]!.name).toBe(PATCH_TABLE[i]!.name);
      expect(plan[i]!.env).toBe(PATCH_TABLE[i]!.env);
      expect(plan[i]!.defaultValue).toBe(PATCH_TABLE[i]!.defaultValue);
    }
  });

  test("'no' / 'false' / 'TRUE' on a flag map correctly through the plan", () => {
    const env = {
      BUN_PI_PRE_LOAD_PROVIDERS: "no",
      BUN_PI_LOAD_RUN_DIR: "false",
      BUN_PI_DEFAULT_MODEL_ENV: "TRUE",
    };
    const byName = Object.fromEntries(
      resolvePatchPlan(PATCH_TABLE, env).map((p) => [p.name, p.applied]),
    );
    expect(byName["pre-load-providers"]).toBe(false);
    expect(byName["load-run-dir-resources"]).toBe(false);
    expect(byName["default-model-env"]).toBe(true);
    expect(byName["skip-update-check"]).toBe(true); // unset → default true
  });

  test("is pure — does not mutate the passed env or table", () => {
    const env = { BUN_PI_SKIP_UPDATE_CHECK: "0" };
    const table: PatchEntry[] = [
      { name: "pre-load-providers", env: "X", defaultValue: true },
      { name: "skip-update-check", env: "Y", defaultValue: false },
    ];
    resolvePatchPlan(table, env);
    expect(env).toEqual({ BUN_PI_SKIP_UPDATE_CHECK: "0" });
    expect(table).toEqual([
      { name: "pre-load-providers", env: "X", defaultValue: true },
      { name: "skip-update-check", env: "Y", defaultValue: false },
    ]);
  });
});

describe("applyPatches (integration)", () => {
  // applyPatches imports the real patch modules (env/argv side effects). Run it
  // once and assert the returned plan matches resolvePatchPlan for the live env,
  // and that every applied patch has a matching entry. Guards the
  // switch↔PATCH_TABLE wiring (the exhaustiveness `default: never` case).
  test("returns the same plan as resolvePatchPlan for the live env", async () => {
    const applied: AppliedPatch[] = await applyPatches();
    const expected = resolvePatchPlan();
    expect(applied.map((p) => p.name)).toEqual(expected.map((p) => p.name));
    for (let i = 0; i < applied.length; i++) {
      expect(applied[i]!.applied).toBe(expected[i]!.applied);
    }
  });

  test("every PATCH_TABLE entry has a switch case (no unhandled patch)", async () => {
    // If a PATCH_TABLE entry lacks a `case`, applyPatches throws "unhandled patch".
    await expect(applyPatches()).resolves.toBeDefined();
  });
});
