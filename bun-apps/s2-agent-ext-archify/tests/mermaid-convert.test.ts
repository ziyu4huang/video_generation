import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyLabelFixes,
  convertMermaid,
  detectMermaidDialect,
  MermaidConvertError,
  semanticComponentType,
  semanticStateType,
  validateWithLabelFixes,
  type ConvertOptions,
  type ValidateVerdict,
} from "../src/mermaid-convert.ts";
import { runArchify, withTempIr } from "../src/run.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "mermaid");
const PKG_ROOT = resolve(import.meta.dir, "..");

function readMermaid(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function convert(name: string, options: ConvertOptions = {}): Record<string, unknown> {
  return convertMermaid(readMermaid(name), options);
}

/** Validate through the real vendored gate (receipt diagnostics intact),
 * feeding the shared fix loop — the same path the CLI's `mermaid:convert`
 * runs, so the corpus proves the full convert+validate pipeline. */
async function validateViaGate(ir: Record<string, unknown>): Promise<ValidateVerdict> {
  const type = String((ir as { diagram_type?: string }).diagram_type ?? "");
  const { stdout } = await withTempIr(ir, (irPath) => runArchify(["validate", type, irPath, "--json"], PKG_ROOT));
  try {
    const receipt = JSON.parse(stdout) as { ok?: boolean; diagnostics?: Array<{ message?: string }> };
    if (receipt.ok) return { ok: true, text: `VALID (${type})`, diagnostics: [] };
    const diagnostics = receipt.diagnostics ?? [];
    return { ok: false, text: diagnostics.map((d) => d.message ?? "").join("\n") || stdout.slice(0, 200), diagnostics };
  } catch {
    return { ok: false, text: stdout.slice(0, 200), diagnostics: [] };
  }
}

async function assertValidThroughPipeline(ir: Record<string, unknown>): Promise<void> {
  const { verdict } = await validateWithLabelFixes(ir, validateViaGate);
  expect(verdict.ok, verdict.text).toBeTruthy();
}

describe("convertMermaid — fixture corpus is valid per the vendored gate", () => {
  // The valid-IR-out contract (§7.1.6): every corpus conversion passes the real
  // render+composition validate, not a schema-lite check.
  const corpus: Array<{ file: string; type?: "architecture" | "dataflow"; diagram: string }> = [
    { file: "workflow-review.mmd", diagram: "workflow" },
    { file: "workflow-chain.mmd", diagram: "workflow" },
    { file: "architecture-component-map.mmd", type: "architecture", diagram: "architecture" },
    { file: "architecture-free-form.mmd", type: "architecture", diagram: "architecture" },
    { file: "dataflow-pipeline.mmd", type: "dataflow", diagram: "dataflow" },
    { file: "dataflow-two-stage.mmd", type: "dataflow", diagram: "dataflow" },
    { file: "sequence-request.mmd", diagram: "sequence" },
    { file: "sequence-activate.mmd", diagram: "sequence" },
    { file: "lifecycle-feature.mmd", diagram: "lifecycle" },
    { file: "lifecycle-keywords.mmd", diagram: "lifecycle" },
  ];
  for (const { file, type, diagram } of corpus) {
    it(`${file} → ${diagram}: topology + validate green`, async () => {
      const stem = file.replace(/\.mmd$/, "");
      const ir = convert(file, { ...(type ? { type } : {}), title: stem });
      expect(ir.diagram_type).toBe(diagram);
      expect((ir.meta as { title: string }).title).toBe(stem);
      await assertValidThroughPipeline(ir);
    });
  }
});

describe("convertMermaid — structural mapping", () => {
  it("workflow: lanes from subgraphs, layering cols, mainPath happy path, back edge return-left", () => {
    const ir = convert("workflow-review.mmd");
    const lanes = ir.lanes as Array<{ id: string }>;
    const nodes = ir.nodes as Array<Record<string, unknown>>;
    const edges = ir.edges as Array<Record<string, unknown>>;
    const mainPath = ir.mainPath as string[];
    expect(lanes.map((l) => l.id)).toEqual(["dev", "ra", "rb", "xcp"]);
    expect(nodes).toHaveLength(6);
    expect(nodes.find((n) => n.id === "sec")?.type).toBe("security");
    expect(nodes.find((n) => n.id === "sec")?.tag).toBe("decision");
    const cols = Object.fromEntries(nodes.map((n) => [n.id, n.col]));
    // Layer → well-spaced col subset [0,1,3,5]: open 0, reviewers 1, gate 3, ship 5.
    expect(cols).toEqual({ open: 0, r1: 1, r2: 1, sec: 3, ship: 5, reject: 5 });
    expect(mainPath).toEqual(["open", "r1", "sec", "ship"]);
    const back = edges.find((e) => e.from === "reject" && e.to === "open");
    expect(back?.route).toBe("return-left");
  });

  it("workflow: ungrouped chain → single main lane, slot cols [0,1,3,5]", () => {
    const ir = convert("workflow-chain.mmd");
    const nodes = ir.nodes as Array<{ id: string; lane: string; col: number }>;
    expect(nodes.every((n) => n.lane === "main")).toBe(true);
    expect(nodes.map((n) => n.col)).toEqual([0, 1, 3, 5]);
    expect(ir.mainPath).toEqual(["gate", "parse", "resolve", "serve"]);
  });

  it("architecture: grid mode, components from nodes (labels intact), boundaries from subgraphs", () => {
    const ir = convert("architecture-component-map.mmd", { type: "architecture" });
    expect((ir.layout as { mode: string }).mode).toBe("grid");
    const components = ir.components as Array<{ id: string; row: number; col: number; label: string }>;
    expect(components).toHaveLength(6);
    expect(components.every((c) => Number.isInteger(c.row) && Number.isInteger(c.col))).toBe(true);
    // Stadium labels must NOT leak their brackets (M1): `cache[("Resolved cache")]`.
    expect(components.find((c) => c.id === "cache")?.label).toBe("Resolved cache");
    const boundaries = ir.boundaries as Array<{ label: string; wraps: string[] }>;
    expect(boundaries.map((b) => b.label)).toEqual(["Resolver domain", "Media domain"]);
    expect(boundaries[0]!.wraps).toContain("resolver");
  });

  it("flowchart shapes: stadium and quoted labels keep their text, no stray brackets", () => {
    const ir = convertMermaid('flowchart LR\n  a([Stadium text]) --> b([Rounded])\n', { title: "shapes", type: "workflow" });
    const nodes = ir.nodes as Array<{ id: string; label: string }>;
    expect(nodes.find((n) => n.id === "a")?.label).toBe("Stadium text");
    expect(nodes.find((n) => n.id === "b")?.label).toBe("Rounded");
    const round = convertMermaid('flowchart LR\n  a["has ] bracket"] --> b["ok"]\n', { title: "quoted", type: "workflow" });
    expect((round.nodes as Array<{ id: string; label: string }>).find((n) => n.id === "a")!.label).toBe("has ] bracket");
  });

  it("dataflow: subgraph → stage flows with edge labels, default `to <target>`", () => {
    const ir = convert("dataflow-pipeline.mmd", { type: "dataflow" });
    expect(ir.stages).toEqual([{ label: "Sources" }, { label: "Ingest" }, { label: "Store" }]);
    const flows = ir.flows as Array<{ from: string; to: string; label: string }>;
    expect(flows.find((f) => f.from === "web")?.label).toBe("clickstream");
    // An unlabeled edge must still carry a (schema-required) flow label — the
    // target's readable label, not the sanitized id (m9).
    const unlabeled = convertMermaid(
      'flowchart LR\n  subgraph a["A"]\n    x["X"]\n  end\n  subgraph b["B"]\n    y["Y"]\n  end\n  x --> y\n',
      { type: "dataflow", title: "unlabeled" },
    );
    const f = (unlabeled.flows as Array<{ to: string; label: string }>)[0]!;
    expect(f.to).toBe("y");
    expect(f.label).toBe("to Y");
  });

  it("sequence: participants order, messages y, return variant, rect segments, viewBox", () => {
    const ir = convert("sequence-request.mmd");
    const participants = ir.participants as Array<Record<string, unknown>>;
    const messages = ir.messages as Array<{ id: string; from: string; to: string; y: number; variant?: string }>;
    const segments = ir.segments as Array<{ label: string }>;
    expect((participants[0] as { id: string }).id).toBe("client");
    expect(messages).toHaveLength(8);
    expect(messages.every((m) => m.y >= 160)).toBe(true);
    expect(messages.every((m, i) => m.y === 160 + 40 * i)).toBe(true);
    expect(messages[3]!.variant).toBe("return");
    expect(segments.map((s) => s.label)).toEqual(["lookup", "source"]);
    expect((ir.meta as { viewBox: number[] }).viewBox[0]).toBeGreaterThanOrEqual(480);
  });

  it("sequence: +/- activation shorthand and sublabel-lift for wide labels", () => {
    const ir = convert("sequence-activate.mmd");
    const participants = ir.participants as Array<{ id: string; type: string; label: string; sublabel?: string }>;
    expect(participants.find((p) => p.label === "Resolver")).toEqual({ id: "s", type: "backend", label: "Resolver", sublabel: "Resolver service" });
    const activations = ir.activations as Array<{ participant: string; from: number; to: number }>;
    expect(activations.some((a) => a.participant === "s" && a.from > 200 && a.to >= a.from)).toBe(true);
  });

  it("lifecycle: [*] entry → start type; exits → terminal lane success/failure; keyword lanes", () => {
    const ir = convert("lifecycle-feature.mmd");
    const states = ir.states as Array<{ label: string; type: string; lane: string; sublabel?: string }>;
    const lanes = ir.lanes as Array<{ id: string }>;
    expect(states.find((s) => s.label === "planned")?.type).toBe("start");
    expect(states.find((s) => s.label === "live")?.type).toBe("success");
    expect(states.find((s) => s.label === "live")?.lane).toBe("terminal");
    expect(states.find((s) => s.label === "dropped")?.type).toBe("failure");
    expect(lanes.map((l) => l.id)).toEqual(["main", "waiting", "terminal"]);
    // Entry/exit transition labels are carried onto sublabel, not dropped (m3).
    expect(states.find((s) => s.label === "planned")?.sublabel).toBe("scope");
    const kw = convert("lifecycle-keywords.mmd");
    const kwStates = kw.states as Array<{ label: string; type: string; lane: string; sublabel?: string }>;
    expect(kwStates.find((s) => s.label === "canary")?.lane).toBe("waiting");
    expect(kwStates.find((s) => s.label === "failure")?.type).toBe("failure");
    expect(kwStates.find((s) => s.label === "planning")?.sublabel).toBe("kickoff");
  });
});

describe("convertMermaid — bound errors name the line", () => {
  const cases: Array<[string, string, string]> = [
    [
      "sequenceDiagram\n  participant a as Client\n  alt happy\n    a-->>a: x\n  end\n",
      "line 3: sequence `alt/loop/opt/par/break` blocks are unbounded",
      "sequence alt block",
    ],
    [
      "stateDiagram-v2\n  [*] --> s1\n  state s1 {\n    a --> b\n  }\n",
      "line 3: unrecognized stateDiagram syntax",
      "state composite",
    ],
    [
      "flowchart LR\n  subgraph a[\"A\"]\n    subgraph b[\"B\"]\n      x\n    end\n  end\n",
      "line 3: nested subgraphs are unbounded",
      "nested subgraph",
    ],
    [
      "flowchart LR\n  A --> B & C\n",
      'line 2: expected a link, got "& C"',
      "`&&` fan link",
    ],
    [
      "sequenceDiagram\n  A--xB: async\n",
      'line 2: sequence variant "--x" is unbounded',
      "async `--x`",
    ],
    [
      "flowchart LR\n  A --> B\n  A --> B\n  subgraph s1[\"S\"]\n    x\n    y\n    z\n    w\n    v\n  end\n",
      "land in the same lane+column",
      "parallel nodes in one lane",
    ],
  ];
  for (const [src, needle, name] of cases) {
    it(name, () => {
      expect(() => convertMermaid(src)).toThrow(needle);
    });
  }

  it("routing bounds: same-lane skip edge errors (no automatic route clears it)", () => {
    expect(() => convertMermaid("flowchart LR\n  a[\"A\"] --> b[\"B\"]\n  b --> c[\"C\"]\n  a -->|skip| c\n")).toThrow("skips an intermediate node in the same lane");
  });
  it("routing bounds: shared-row loop back edge errors (exception lane needed)", () => {
    expect(() => convertMermaid("flowchart LR\n  a[\"A\"] --> b[\"B\"]\n  b --> c[\"C\"]\n  c --> a\n")).toThrow("loop source alone in its own subgraph");
  });
  it("routing bounds: cross-lane first edge through an intermediate-lane node errors", () => {
    const src =
      'flowchart LR\n  subgraph a["A"]\n    a0["A0"] --> b["B"]\n  end\n  subgraph m["M"]\n    x["X"]\n  end\n  subgraph c["C"]\n    y["Y"]\n  end\n  a0 --> x\n  b --> y\n';
    expect(() => convertMermaid(src)).toThrow("runs through a node in an intermediate lane");
  });
  it("rendering bounds: 5-stage dataflow, 5-deep architecture chain, 4-state lane error loudly", () => {
    const stages = Array.from({ length: 5 }, (_, i) => `  subgraph s${i}[\"S${i}\"]\n    n${i}[\"N${i}\"]\n  end`).join("\n");
    expect(() => convertMermaid(`flowchart LR\n${stages}\n`, { type: "dataflow" })).toThrow("4 stages");
    const chain = Array.from({ length: 5 }, (_, i) => `  n${i + 1}[\"N${i + 1}\"] --> n${i + 2}[\"N${i + 2}\"]`).join("\n");
    expect(() => convertMermaid(`flowchart LR\n  n1[\"N1\"]\n${chain}\n`, { type: "architecture" })).toThrow("4 columns");
    const holds = Array.from({ length: 5 }, (_, i) => `  hold${i} --> s${i + 1}`).join("\n");
    expect(() => convertMermaid(`stateDiagram-v2\n  [*] --> hold0\n  ${holds}\n`)).toThrow("caps at 4 columns");
    // The waiting (event) band caps at 3 columns — explicit labels carry the
    // keyword; the chain loops back so none of them is an entry/exit state
    // (those land in the main/terminal bands by rule).
    const canaries = Array.from({ length: 4 }, (_, i) => `  state "Waiting ${i}" as w${i}`).join("\n");
    const canLinks = ["  e --> w0", "  w0 --> w1", "  w1 --> w2", "  w2 --> w3", "  w3 --> e"].join("\n");
    expect(() => convertMermaid(`stateDiagram-v2\n  [*] --> e\n  ${canaries}\n  ${canLinks}\n`)).toThrow("caps at 3 columns");
  });
  it("circle shape ((…)) errors with a clear unbounded message", () => {
    expect(() => convertMermaid("flowchart LR\n  a((x)) --> b\n")).toThrow("circle shape ((…)) is unbounded");
  });
  it("sequence bounds: self-message and empty rect are convert-time errors", () => {
    expect(() => convertMermaid("sequenceDiagram\n  A->>A: ping\n")).toThrow("spans 0px");
    expect(() => convertMermaid("sequenceDiagram\n  participant a as A\n  participant b as B\n  rect empty\n  end\n  a->>b: hi\n")).toThrow("empty `rect`");
  });

  it("rejects other mermaid dialects with a clear error", () => {
    expect(() => convertMermaid("classDiagram\n  A --> B\n")).toThrow(/classDiagram.*not supported/);
    expect(() => detectMermaidDialect("gantt\n  task a\n")).toThrow(/gantt.*not supported/);
  });

  it("errors on --type misuse for auto-dialects", () => {
    expect(() => convertMermaid(readMermaid("sequence-request.mmd"), { type: "workflow" })).toThrow(/drop `--type`/);
  });

  it("a single word too wide for a box is an error, not a guess", () => {
    expect(() => convertMermaid("sequenceDiagram\n  participant a as TelecommunicationFederator\n  a->>b: hi\n")).toThrow(/too wide/);
  });
});

describe("semantic tables", () => {
  it("componentType precedence: messagebus → security → database → frontend → external → backend", () => {
    expect(semanticComponentType("Task queue")).toBe("messagebus");
    expect(semanticComponentType("Auth gateway")).toBe("security");
    expect(semanticComponentType("Postgres main")).toBe("database");
    expect(semanticComponentType("Web app")).toBe("frontend");
    expect(semanticComponentType("End user")).toBe("external");
    expect(semanticComponentType("Resolver")).toBe("backend");
  });
  it("whole-word matching: embedded keywords do not mis-type", () => {
    expect(semanticComponentType("Context store")).toBe("database"); // not external via "ext"
    expect(semanticComponentType("Section leader")).toBe("backend"); // not security via "sec"
    expect(semanticComponentType("Architect dashboard")).toBe("frontend"); // dashboard, not external
    expect(semanticComponentType("Restart worker")).toBe("backend"); // not start via "restart"
  });
  it("lifecycle types from names", () => {
    expect(semanticStateType("Canary")).toBe("waiting");
    expect(semanticStateType("Live")).toBe("success");
    expect(semanticStateType("Dropped")).toBe("failure");
    expect(semanticStateType("Planned")).toBe("start");
    expect(semanticStateType("Running")).toBe("active");
  });
});

describe("applyLabelFixes", () => {
  it("sets labelAt on the unique relationship carrying the label", () => {
    const ir = {
      schema_version: 1,
      diagram_type: "lifecycle",
      transitions: [
        { id: "t1", from: "a", to: "b", label: "approved" },
        { id: "t2", from: "b", to: "c" },
      ],
    };
    const fixed = applyLabelFixes(ir, [{ label: "approved", at: [171, 202] }]);
    expect((fixed.transitions as Array<{ labelAt?: number[] }>)[0]!.labelAt).toEqual([171, 202]);
    expect((fixed.transitions as Array<{ labelAt?: number[] }>)[1]!.labelAt).toBeUndefined();
  });
  it("leaves ambiguous labels untouched (no guess)", () => {
    const ir = {
      schema_version: 1,
      diagram_type: "workflow",
      edges: [
        { id: "e1", from: "a", to: "b", label: "x" },
        { id: "e2", from: "c", to: "d", label: "x" },
      ],
    };
    const fixed = applyLabelFixes(ir, [{ label: "x", at: [10, 10] }]);
    expect(fixed).toBe(ir);
    expect((fixed.edges as Array<{ labelAt?: number[] }>).every((e) => e.labelAt === undefined)).toBe(true);
  });
});

describe("mermaid:convert CLI contract (exit codes)", () => {
  const script = resolve(import.meta.dir, "..", "scripts", "mermaid-convert.ts");
  async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
    const p = Bun.spawn(["bun", script, ...args], {
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { status: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
  }
  const pkgFixtures = "bun-apps/s2-agent-ext-archify/tests/fixtures/mermaid";
  it("exit 0 on a valid conversion — stdout is pure JSON, status on stderr", async () => {
    const r = await runCli([join(pkgFixtures, "workflow-chain.mmd")]);
    expect(r.status).toBe(0);
    const ir = JSON.parse(r.stdout) as { diagram_type: string };
    expect(ir.diagram_type).toBe("workflow");
    expect(r.stderr).toContain("VALID");
  });
  it("exit 1 on unbounded syntax with line number", async () => {
    const r = await runCli([join(pkgFixtures, "errors", "sequence-alt.mmd")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("line 4");
  });
  it("exit 2 on --type misuse (usage)", async () => {
    const r = await runCli([join(pkgFixtures, "sequence-request.mmd"), "--type", "workflow"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
  it("exit 0 on --no-validate (conversion only, gate skipped, status on stderr)", async () => {
    const r = await runCli([join(pkgFixtures, "workflow-chain.mmd"), "--no-validate"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("diagram_type", "workflow");
    expect(r.stderr).toContain("NOT validated");
  });
  it("--help exits 0 and documents the unbounded-syntax bound", async () => {
    const r = await runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SYNTAX NOT SUPPORTED");
    expect(r.stdout).toContain("alt/loop/opt/par/break");
  });
});
