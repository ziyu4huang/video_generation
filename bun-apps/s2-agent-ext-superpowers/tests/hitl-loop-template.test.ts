import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural contract for hitl-loop.template.ts (portable-bun wave 2, task 5).
 *
 * The template is a COPY source — the systematic-debugging skill tells the
 * agent to copy it into fresh files, never execute it. So the golden here is
 * structural, not an execution A/B: the file must carry the wizard-style
 * authoring contract (STAGES marker + the stage/per-stage helper library) and
 * the old template's contract (comment header, KEY=VALUE capture dump) in its
 * Bun form. The old hitl-loop.template.sh is deleted — never commit a .sh and
 * .ts twin together.
 *
 * Deliberate design point (adjudicated 2026-08-23): the old .sh never carried
 * the wizard library (it only had `step` + `capture`); the brief's golden
 * (STAGES / stage( / ask_secret / open_url / exit-on-failure) is the binding
 * contract, so the new template ports the wizard library 1:1 from the sibling
 * wayfind wizard/template.sh and preserves the old template's substance in the
 * authoring section below the STAGES marker.
 */
const scriptsDir = join(import.meta.dir, "..", "skills", "systematic-debugging", "scripts");
const templatePath = join(scriptsDir, "hitl-loop.template.ts");
const oldShPath = join(scriptsDir, "hitl-loop.template.sh");

function readTemplate(): string {
  expect(existsSync(templatePath), `missing template: ${templatePath}`).toBe(true);
  return readFileSync(templatePath, "utf8");
}

describe("hitl-loop.template.ts — structural golden (copy source, never executed)", () => {
  it("carries the wizard authoring markers: STAGES, stage(, ask_secret, open_url, failure-exit", () => {
    const body = readTemplate();
    expect(body).toContain("STAGES"); // authoring marker
    expect(body).toContain("stage("); // library helper
    expect(body).toContain("ask_secret"); // hidden-input helper
    expect(body).toContain("open_url"); // browser helper
    expect(body).toMatch(/process\.exit\(1\)/); // failure-exit path
  });

  it("keeps the wizard-style library helper set (the library above the STAGES marker)", () => {
    const body = readTemplate();
    for (const helper of [
      "banner(",
      "stage(",
      "say(",
      "step(",
      "note(",
      "warn(",
      "open_url(",
      "pause(",
      "confirm(",
      "ask(",
      "ask_secret(",
      "write_env(",
      "set_secret(",
      "set_var(",
      "finish(",
    ]) {
      expect(body, `missing library helper ${helper}`).toContain(helper);
    }
    expect(body).toContain("TOTAL_STAGES");
  });

  it("preserves the old template's authoring contract (header + KEY=VALUE capture dump)", () => {
    const body = readTemplate();
    expect(body).toContain("Copy this file, edit the steps below, and run it");
    expect(body).toContain("KEY=VALUE");
    expect(body).toContain("--- Captured ---");
  });

  it("is bun-runnable TS, not a bash leftover", () => {
    const body = readTemplate();
    expect(body).not.toMatch(/^#!\/usr\/bin\/env bash/);
    expect(body).not.toContain("#!/bin/bash");
  });

  it("no .sh twin — the template was deleted, the .ts IS the copy source", () => {
    expect(existsSync(oldShPath), `old .sh still present alongside the .ts twin: ${oldShPath}`).toBe(false);
  });
});
