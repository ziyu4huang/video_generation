import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/archify.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Create a fresh temp cwd, tracked for afterAll cleanup. */
function withTempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "archify-e2e-"));
  tempDirs.push(d);
  return d;
}

/**
 * Recorder pi: captures every tool object passed to registerTool so later
 * layers can call .execute() on the actually-registered tools.
 */
function makeRecorderPi() {
  const tools: { name: string; execute: (id: string, p: unknown, s: unknown, u: unknown, ctx: { cwd: string }) => Promise<unknown> }[] = [];
  const pi = {
    registerTool: (t: unknown) => {
      const tool = t as { name: string; execute: (id: string, p: unknown, s: unknown, u: unknown, ctx: { cwd: string }) => Promise<unknown> };
      tools.push(tool);
    },
  };
  return { pi, tools };
}

/** ctx arg for execute(), coerced to satisfy the ToolExecuteContext union. */
const ctxFor = (cwd: string) => ({ cwd } as never);

describeMaybe("archify e2e — Layer 1: registration contract", () => {
  test("registers exactly {archify_render, archify_validate, archify_delta}", () => {
    const { pi, tools } = makeRecorderPi();
    factory(pi as never);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["archify_delta", "archify_render", "archify_validate"].sort(),
    );
  });
});
