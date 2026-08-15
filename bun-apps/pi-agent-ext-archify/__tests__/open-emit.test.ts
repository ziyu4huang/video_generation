/**
 * webui:open announce contract (archify-webui-html ticket 07):
 * archify_render / archify_delta emit exactly ONE "webui:open" event on the
 * optional ctx.events bus after a successful render, and never otherwise.
 * Payload: { path, view, title }. A missing or throwing bus must not change
 * the tool result.
 */
import { describe, it, expect } from "bun:test";
import { join, isAbsolute } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { archifyRender } from "../lib/render.ts";
import { archifyDelta } from "../lib/delta.ts";

const fixtureBase = join(import.meta.dir, "fixtures/mini.architecture.json");
const fixtureHead = join(import.meta.dir, "fixtures/mini.architecture.v2.json");

type Emits = { ch: string; payload: { path?: unknown; view?: unknown; title?: unknown } }[];

/** Mock bus per the ticket: records every emit for exact-count assertions. */
const makeBus = () => {
  const emitted: Emits = [];
  return {
    emitted,
    emit(ch: string, payload: unknown) {
      emitted.push({ ch, payload: payload as Emits[number]["payload"] });
    },
  };
};

describe("webui:open announce (archify_render)", () => {
  it("render success → exactly 1 emit, webui:open, absolute path, basename view, meta.title", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-open-render-"));
    const bus = makeBus();
    const res = await archifyRender({ irPath: fixtureBase }, { cwd, events: bus });
    expect(res.isError).toBeFalsy();
    expect(bus.emitted.length).toBe(1);
    const { ch, payload } = bus.emitted[0]!;
    expect(ch).toBe("webui:open");
    // fixture authors meta.output "mini.html" + meta.title "Mini"
    expect(payload).toEqual({ path: join(cwd, "mini.html"), view: "mini", title: "Mini" });
    expect(isAbsolute(payload.path as string)).toBe(true);
  });

  // NOTE: no tool-level "meta.title absent → diagramType fallback" case here —
  // meta.title is schema-required (vendored/schemas/architecture.schema.json),
  // so such an IR always fails validation before announcing. The fallback is
  // unit-covered in open-announce.test.ts ("title fallbacks" describe).

  it("render failure (schema-invalid IR) → 0 emits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-open-invalid-"));
    const bus = makeBus();
    const res = await archifyRender(
      { ir: { schema_version: 1, diagram_type: "architecture", meta: {} } },
      { cwd, events: bus },
    );
    expect(res.isError).toBe(true);
    expect(bus.emitted.length).toBe(0);
  });
});

describe("webui:open announce (archify_delta)", () => {
  it("delta success → view starts with compare- (compare-<basename sans .html>)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-open-delta-"));
    const bus = makeBus();
    const res = await archifyDelta({ basePath: fixtureBase, headPath: fixtureHead }, { cwd, events: bus });
    expect(res.isError).toBeFalsy();
    expect(bus.emitted.length).toBe(1);
    const { ch, payload } = bus.emitted[0]!;
    expect(ch).toBe("webui:open");
    expect(payload).toEqual({
      path: join(cwd, "architecture-delta.html"),
      view: "compare-architecture-delta",
      title: "architecture-delta",
    });
    expect(String(payload.view).startsWith("compare-")).toBe(true);
  });

  it("delta failure (non-architecture type) → 0 emits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-open-delta-bad-"));
    const bus = makeBus();
    const res = await archifyDelta(
      { basePath: fixtureBase, headPath: fixtureHead, type: "workflow" },
      { cwd, events: bus },
    );
    expect(res.isError).toBe(true);
    expect(bus.emitted.length).toBe(0);
  });
});

describe("webui:open announce (bus robustness)", () => {
  it("bus undefined → no throw, result unchanged vs a bus-attached render", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-open-nobus-"));
    const res = await archifyRender({ irPath: fixtureBase }, { cwd });
    expect(res.isError).toBeFalsy();
    const withBus = await archifyRender({ irPath: fixtureBase }, { cwd, events: makeBus() });
    expect(withBus.isError).toBeFalsy();
    // Identical input → identical text (embeds path, checks, sha prefix).
    expect(withBus.content).toEqual(res.content);
  });

  it("throwing bus never breaks the render result", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-open-throwing-"));
    const res = await archifyRender(
      { irPath: fixtureBase },
      { cwd, events: { emit() { throw new Error("bus broken"); } } },
    );
    expect(res.isError).toBeFalsy();
    expect((res.details as { path: string }).path).toBe(join(cwd, "mini.html"));
  });
});
