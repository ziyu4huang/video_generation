import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archifyDeckLint, discoverDeckSkeletons } from "../src/deck-lint-tool.ts";
import * as run from "../src/run.ts";

const PKG_ROOT = join(import.meta.dir, "..");
const IR_A = join(PKG_ROOT, "vendored", "examples", "web-app.architecture.json");
const IR_B = join(PKG_ROOT, "vendored", "examples", "agent-run.lifecycle.json");

function tempDir(prefix = "archify-deck-lint-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A minimal valid template with one required array slot. Named `kpi-probe` —
 * NOT `kpi-row` — because ticket 06 shipped a real `kpi-row.layout.json`, and
 * a user-tier template sharing a name with one in `<cwd>/templates` is the
 * registry's deliberate duplicate-within-tier load error.
 */
function writeKpiTemplate(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "kpi-probe.layout.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: "kpi-probe",
      description: "2–4 metric tiles across the content well",
      chrome: false,
      slots: { kpis: { kind: "array", of: ["value", "label"], min: 2, max: 4, required: true } },
      body: [
        {
          region: "content",
          box: { inset: [0.2, 0.3, 0.2, 0.5] },
          content: { kind: "text", role: "title", from: "{slide.title}" },
        },
      ],
    })
  );
  return path;
}

// The load-bearing constraint: a spy that FAILS the test if rendering is
// reached even once, for ANY input shape. DI-over-mock.module convention does
// not apply — there is no injection point to force, because the tool must have
// no render path at all; spying on the module export proves it.
describe("archify_deck_lint — renderless guarantee", () => {
  let spy: ReturnType<typeof spyOn<typeof run, "runArchify">>;

  beforeEach(() => {
    spy = spyOn(run, "runArchify");
  });
  afterEach(() => {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("the catalog path never renders", async () => {
    const r = await archifyDeckLint({}, { cwd: PKG_ROOT });
    expect(r.isError).toBeUndefined();
  });

  test("a manifest path never renders", async () => {
    const dir = tempDir();
    const manifestPath = join(dir, "deck.config.json");
    await Bun.write(manifestPath, JSON.stringify({ slides: [{ ir: IR_A, title: "T" }] }));
    const r = await archifyDeckLint({ manifest: manifestPath }, { cwd: PKG_ROOT });
    expect(r.isError).toBeUndefined();
  });

  test("an inline manifest never renders", async () => {
    const r = await archifyDeckLint(
      { manifest: { slides: [{ ir: IR_A, title: "Inline draft" }] }, baseDir: PKG_ROOT },
      { cwd: "/tmp" }
    );
    expect(r.isError).toBeUndefined();
  });

  test("a failing manifest never falls through to a build", async () => {
    const r = await archifyDeckLint(
      { manifest: { slides: [{ ir: join(tempDir(), "ghost.json"), title: "T" }] } },
      { cwd: PKG_ROOT }
    );
    expect(r.isError).toBe(true);
  });
});

describe("archify_deck_lint — catalog discovery (D9)", () => {
  test("the catalog also lists the shipped deck skeletons", async () => {
    const r = await archifyDeckLint({}, { cwd: PKG_ROOT });
    const decks = r.details["decks"] as { name: string }[];
    expect(decks.map((d) => d.name).sort()).toEqual([
      "incident-review",
      "product-proposal",
      "project-kickoff",
      "technical-review",
    ]);
    expect(r.content[0]!.text).toContain("Deck skeletons (4)");
  });

  test("no arguments lists the six code layouts plus every discovered template", async () => {
    const user = tempDir();
    writeKpiTemplate(user);
    const r = await archifyDeckLint({}, { cwd: PKG_ROOT, env: { ARCHIFY_TEMPLATES: user } });
    expect(r.isError).toBeUndefined();
    const layouts = r.details["layouts"] as { name: string; description: string; slots: object }[];
    // Six code layouts first, then the probe (its tier precedes the shipped
    // one), then ticket 06's seven shipped templates, alphabetically.
    expect(layouts.map((l) => l.name)).toEqual([
      "title",
      "section",
      "bullets",
      "split",
      "diagram",
      "statement",
      "kpi-probe",
      "agenda",
      "compare",
      "end",
      "kpi-row",
      "quote",
      "table",
      "timeline",
    ]);
    const kpi = layouts.find((l) => l.name === "kpi-probe")!;
    expect(kpi.description).toContain("metric tiles");
    expect(Object.keys(kpi.slots)).toEqual(["kpis"]);
    expect(r.content[0]!.text).toContain("kpi-probe — 2–4 metric tiles across the content well");
    // The shipped kpi-row is discoverable too — and it is NOT the probe's.
    const shipped = layouts.find((l) => l.name === "kpi-row")!;
    expect(shipped.description).not.toBe(kpi.description);
  });

  test("baseDir joins <baseDir>/templates to the search path", async () => {
    const base = tempDir();
    writeKpiTemplate(join(base, "templates"));
    const r = await archifyDeckLint({ baseDir: base }, { cwd: "/tmp" });
    const layouts = r.details["layouts"] as { name: string }[];
    expect(layouts.some((l) => l.name === "kpi-probe")).toBe(true);
  });
});

describe("archify_deck_lint — slot validation", () => {
  test("a missing slot reports the slot AND the template's own description", async () => {
    const user = tempDir();
    writeKpiTemplate(user);
    const env = { ARCHIFY_TEMPLATES: user };
    const r = await archifyDeckLint(
      { manifest: { slides: [{ title: "Q3 numbers", layout: "kpi-probe" }] } },
      { cwd: PKG_ROOT, env }
    );
    expect(r.isError).toBe(true);
    const text = r.content[0]!.text;
    expect(text).toContain("slide 1");
    expect(text).toContain("`kpis`");
    expect(text).toContain("2–4 metric tiles across the content well");
    expect((r.details["problems"] as string[]).length).toBe(1);
  });

  test("min/max violations on a filled array slot are reported", async () => {
    const user = tempDir();
    writeKpiTemplate(user);
    const env = { ARCHIFY_TEMPLATES: user };
    const r = await archifyDeckLint(
      {
        manifest: {
          slides: [
            { title: "Too few", layout: "kpi-probe", kpis: [{ value: "1ms" }] },
            { title: "Too many", layout: "kpi-probe", kpis: Array.from({ length: 5 }, (_, i) => ({ value: String(i) })) },
          ],
        },
      },
      { cwd: PKG_ROOT, env }
    );
    expect(r.isError).toBe(true);
    const problems = r.details["problems"] as string[];
    expect(problems[0]).toContain("at least 2");
    expect(problems[1]).toContain("at most 4");
  });

  test("code layouts and optional slots stay silent when satisfied", async () => {
    const user = tempDir();
    mkdirSync(user, { recursive: true });
    writeFileSync(
      join(user, "opt.layout.json"),
      JSON.stringify({
        name: "opt",
        description: "optional-slot probe",
        chrome: false,
        slots: { note: { kind: "text", required: false } },
        body: [
          {
            region: "content",
            box: "fill",
            content: { kind: "text", role: "title", from: "{slide.note}" },
          },
        ],
      })
    );
    const r = await archifyDeckLint(
      {
        manifest: {
          slides: [
            { title: "Plain bullets slide", layout: "bullets", bullets: ["a", "b"] },
            { title: "Optional omitted", layout: "opt" },
          ],
        },
      },
      { cwd: PKG_ROOT, env: { ARCHIFY_TEMPLATES: user } }
    );
    expect(r.isError).toBeUndefined();
  });
});

describe("archify_deck_lint — useful result for a valid deck", () => {
  test("returns the storyline, not just ok", async () => {
    const dir = tempDir();
    const manifestPath = join(dir, "deck.config.json");
    await Bun.write(
      manifestPath,
      JSON.stringify({
        slides: [
          { title: "Cold-path latency is what users feel", ir: IR_A },
          { title: "Warm cache removes it", layout: "bullets", bullets: ["a"] },
        ],
      })
    );
    const r = await archifyDeckLint({ manifest: manifestPath }, { cwd: PKG_ROOT });
    expect(r.isError).toBeUndefined();
    expect(r.details["storyline"]).toBe(
      "1. Cold-path latency is what users feel\n2. Warm cache removes it"
    );
    expect(r.content[0]!.text).toContain("storyline");
    expect(r.details["slides"]).toBe(2);
  });

  test("advisory lint notes ride along in details without blocking", async () => {
    const r = await archifyDeckLint(
      { manifest: { slides: [{ title: "Latency", ir: IR_B }] } },
      { cwd: PKG_ROOT }
    );
    expect(r.isError).toBeUndefined(); // label title is a warn, not a structural problem
    expect(r.details["lint"]).toBeTruthy();
  });

  test("a missing IR is reported by slide number, before any lint runs", async () => {
    const ghost = join(tempDir(), "ghost.json");
    const r = await archifyDeckLint(
      {
        manifest: {
          slides: [
            { title: "Real", ir: IR_A },
            { title: "Ghost", ir: ghost },
          ],
        },
      },
      { cwd: PKG_ROOT }
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("slide 2");
    expect(r.content[0]!.text).toContain(ghost);
  });

  test("inline object + relative baseDir anchors an unwritten draft", async () => {
    const base = tempDir();
    const rel = base.startsWith("/") ? base.slice(1) : base;
    const r = await archifyDeckLint(
      { manifest: { slides: [{ title: "Draft", ir: "./draft.json" }] }, baseDir: rel },
      { cwd: "/" }
    );
    expect(r.isError).toBe(true); // draft.json does not exist there…
    expect(r.content[0]!.text).toContain(join(base, "draft.json")); // …but resolved under baseDir
  });

  test("parse failures surface as printable errors", async () => {
    expect(
      (await archifyDeckLint({ manifest: { slides: [] } }, { cwd: PKG_ROOT })).isError
    ).toBe(true);
    expect(
      (await archifyDeckLint({ manifest: { slides: [{ title: "No layout or ir" }] } }, { cwd: PKG_ROOT }))
        .isError
    ).toBe(true);
  });
});

describe("discoverDeckSkeletons — fold-back tiers (t01)", () => {
  /** A minimal valid skeleton outline: the description is the first H1 after frontmatter. */
  function writeSkeleton(dir: string, name: string, description: string): string {
    mkdirSync(join(dir, "decks"), { recursive: true });
    const path = join(dir, "decks", `${name}.outline.md`);
    writeFileSync(path, `---\n---\n# ${description}\n\n## Slide one\n:::bullets\n- a\n`);
    return path;
  }

  test("a shippedDir override finds a DIFFERENT-root shipped tree, not the package's", () => {
    const shipped = tempDir();
    writeSkeleton(shipped, "custom", "Custom shipped deck");
    const out = discoverDeckSkeletons({ root: tempDir(), shippedDir: shipped });
    expect(out.map((d) => d.name)).toEqual(["custom"]);
    expect(out[0]!.description).toBe("Custom shipped deck");
    expect(out[0]!.source).toBe(join(shipped, "decks", "custom.outline.md"));
  });

  test("the four shipped skeletons are still the default (regression guard)", () => {
    const out = discoverDeckSkeletons({ root: PKG_ROOT });
    expect(out.map((d) => d.name).sort()).toEqual([
      "incident-review",
      "product-proposal",
      "project-kickoff",
      "technical-review",
    ]);
  });

  test("$ARCHIFY_TEMPLATES decks join the user tier, before the shipped tier", () => {
    const user = tempDir();
    writeSkeleton(user, "my-deck", "My user deck");
    const out = discoverDeckSkeletons({ root: PKG_ROOT, env: { ARCHIFY_TEMPLATES: user } });
    // User tier precedes shipped: our deck is found; the shipped four remain.
    expect(out.map((d) => d.name).sort()).toContain("my-deck");
    expect(out.find((d) => d.name === "my-deck")!.source).toBe(
      join(user, "decks", "my-deck.outline.md")
    );
  });

  test("a user-tier skeleton shadows a same-named shipped skeleton", () => {
    const user = tempDir();
    // Shadow the shipped `technical-review` with a user one; first hit wins.
    writeSkeleton(user, "technical-review", "User version");
    const out = discoverDeckSkeletons({ root: PKG_ROOT, env: { ARCHIFY_TEMPLATES: user } });
    const hit = out.filter((d) => d.name === "technical-review");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.description).toBe("User version");
    expect(hit[0]!.source).toBe(join(user, "decks", "technical-review.outline.md"));
  });

  test("the catalog surface lists a user-tier skeleton end to end", async () => {
    const user = tempDir();
    writeSkeleton(user, "my-deck", "My user deck");
    const r = await archifyDeckLint({}, { cwd: PKG_ROOT, env: { ARCHIFY_TEMPLATES: user } });
    expect(r.isError).toBeUndefined();
    const decks = r.details["decks"] as { name: string; description: string }[];
    expect(decks.find((d) => d.name === "my-deck")?.description).toBe("My user deck");
    expect(r.content[0]!.text).toContain("my-deck");
  });
});
