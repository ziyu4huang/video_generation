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

const VENDORED_EXAMPLES = join(import.meta.dir, "..", "vendored", "examples");
const FIXTURE = join(import.meta.dir, "fixtures", "mini.architecture.json");

/** Load the factory once and look up a registered tool by name. */
function registeredTool(name: string) {
  const { pi, tools } = makeRecorderPi();
  factory(pi as never);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

describeMaybe("archify e2e — Layer 2: dispatch integration", () => {
  test("render.execute() produces a self-contained HTML + receipt on disk", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_render");
    const res = (await tool.execute("e2e-id", { ir: JSON.parse(readFileSync(FIXTURE, "utf8")), type: "architecture" }, new AbortController().signal, undefined, ctxFor(cwd))) as {
      content: { type: string; text: string }[]; details: { path: string; artifact?: unknown; validation?: unknown };
    };
    expect(res.content[0]!.text).toContain("Rendered architecture diagram");
    const htmlPath = res.details.path;
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/<html|<svg/i);
    expect(res.details.artifact).toBeDefined();
    expect(res.details.validation).toBeDefined();
  }, 30_000);

  test("validate.execute() returns a structured valid report", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_validate");
    const res = (await tool.execute("e2e-id", { ir: JSON.parse(readFileSync(FIXTURE, "utf8")) }, new AbortController().signal, undefined, ctxFor(cwd))) as {
      content: { type: string; text: string }[]; isError?: boolean; details: { type?: string; report?: { composition?: unknown } };
    };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("valid");
    expect(res.details.type).toBe("architecture");
    expect(res.details.report?.composition).toBeDefined();
  }, 30_000);

  test("delta.execute() produces HTML + receipt sidecar from two IR files", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_delta");
    const base = join(VENDORED_EXAMPLES, "checkout-platform.base.architecture.json");
    const head = join(VENDORED_EXAMPLES, "checkout-platform.head.architecture.json");
    const res = (await tool.execute("e2e-id", { basePath: base, headPath: head }, new AbortController().signal, undefined, ctxFor(cwd))) as {
      content: { type: string; text: string }[]; details: { path: string; receipt: string };
    };
    expect(res.content[0]!.text).toContain("Rendered architecture delta");
    expect(existsSync(res.details.path)).toBe(true);
    expect(existsSync(res.details.receipt)).toBe(true);
  }, 30_000);
});
