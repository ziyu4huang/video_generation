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

const MATRIX = [
  { type: "architecture", file: "production-deployment.architecture.json" },
  { type: "sequence", file: "async-job-roundtrip.sequence.json" },
  { type: "workflow", file: "agent-tool-call.workflow.json" },
  { type: "dataflow", file: "event-stream.dataflow.json" },
  { type: "lifecycle", file: "agent-run.lifecycle.json" },
] as const;

describeMaybe("archify e2e — Layer 3: cross diagram-type matrix", () => {
  for (const { type, file } of MATRIX) {
    test(`render+validate ${type} via execute()`, async () => {
      const cwd = withTempCwd();
      const irPath = join(VENDORED_EXAMPLES, file);
      const ir = JSON.parse(readFileSync(irPath, "utf8"));

      const validate = registeredTool("archify_validate");
      const vRes = (await validate.execute("e2e-id", { ir, type }, new AbortController().signal, undefined, ctxFor(cwd))) as { isError?: boolean };
      expect(vRes.isError).toBeFalsy();

      const render = registeredTool("archify_render");
      const rRes = (await render.execute("e2e-id", { ir, type }, new AbortController().signal, undefined, ctxFor(cwd))) as { content: { text: string }[]; details: { path: string } };
      expect(rRes.content[0]!.text).toContain(`Rendered ${type} diagram`);
      expect(existsSync(rRes.details.path)).toBe(true);
    }, 30_000);
  }
});

describeMaybe("archify e2e — negative cases across the defineTool wrapper", () => {
  test("delta with non-architecture type returns isError, no throw", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_delta");
    const res = (await tool.execute("e2e-id", { basePath: FIXTURE, headPath: FIXTURE, type: "sequence" }, new AbortController().signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain("architecture");
  }, 30_000);

  test("render with malformed IR surfaces an honest error (no uncaught throw)", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_render");
    const res = (await tool.execute("e2e-id", { ir: { diagram_type: "architecture", components: "not-an-array" }, type: "architecture" }, new AbortController().signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
  }, 30_000);

  test("an already-aborted signal never reports a successful render", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_render");
    const ac = new AbortController();
    ac.abort();
    const res = (await tool.execute("e2e-id", { ir: JSON.parse(readFileSync(FIXTURE, "utf8")), type: "architecture" }, ac.signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain("abort");
  }, 30_000);

  test("an already-aborted signal short-circuits validate", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_validate");
    const ac = new AbortController();
    ac.abort();
    const res = (await tool.execute("e2e-id", { ir: JSON.parse(readFileSync(FIXTURE, "utf8")) }, ac.signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain("abort");
  }, 30_000);

  test("an already-aborted signal short-circuits delta", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_delta");
    const ac = new AbortController();
    ac.abort();
    const res = (await tool.execute("e2e-id", { basePath: FIXTURE, headPath: FIXTURE }, ac.signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain("abort");
  }, 30_000);
});
