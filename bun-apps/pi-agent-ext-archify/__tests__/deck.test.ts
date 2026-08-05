import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../scripts/deck.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SCRIPT = join(PKG_ROOT, "scripts", "deck.ts");
const FIXTURE_IR = join(HERE, "fixtures", "mini.architecture.json");
const EXAMPLE_IR = join(PKG_ROOT, "vendored", "examples", "agent-run.lifecycle.json");

// --- unit: parseArgs (always runs; no browser) ---
describe("deck.parseArgs", () => {
  it("defaults the manifest to deck.config.json", () => {
    expect(parseArgs([]).manifest).toBe("deck.config.json");
  });

  it("accepts a positional manifest", () => {
    expect(parseArgs(["x.json"]).manifest).toBe("x.json");
  });

  it("parses --theme and --output", () => {
    const a = parseArgs(["m.json", "--theme", "dark", "--output", "o.pptx"]);
    expect(a.theme).toBe("dark");
    expect(a.output).toBe("o.pptx");
  });

  it("rejects an invalid --theme", () => {
    expect(() => parseArgs(["m.json", "--theme", "nope"])).toThrow(/light\|dark/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["m.json", "--bogus"])).toThrow(/Unknown flag/);
  });
});

// --- integration: full pipeline manifest → .pptx (browser-gated) ---
// Runs locally by default; in CI only when ARCHIFY_DECK_TEST_BROWSER=1 (chromium).
const RUN = process.env.CI ? process.env.ARCHIFY_DECK_TEST_BROWSER === "1" : true;
const describeMaybe = RUN ? describe : describe.skip;

describeMaybe("deck integration — manifest → .pptx", () => {
  it("produces a valid OOXML zip with 2 slides + >=2 media images", () => {
    const dir = mkdtempSync(join(tmpdir(), "archify-deck-test-"));
    const out = join(dir, "out.pptx");
    const manifest = {
      output: out,
      theme: "light",
      tag: "deck test",
      defaults: { font: "Arial", scale: 2 },
      slides: [
        { ir: FIXTURE_IR, title: "Slide one", subtitle: "architecture" },
        { ir: EXAMPLE_IR, title: "Slide two", subtitle: "lifecycle" },
      ],
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));

    const proc = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, join(dir, "manifest.json")],
      cwd: PKG_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`deck exited ${proc.exitCode}\nstdout: ${proc.stdout?.toString() ?? ""}\nstderr: ${proc.stderr?.toString() ?? ""}`);
    }

    expect(existsSync(out)).toBe(true);
    const buf = readFileSync(out);
    // valid ZIP local-file-header magic: PK\x03\x04
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    // the ZIP central directory stores entry names uncompressed → greppable as latin1
    const text = buf.toString("latin1");
    expect(text).toContain("ppt/slides/slide1.xml");
    expect(text).toContain("ppt/slides/slide2.xml");
    const mediaMatches = text.match(/ppt\/media\//g);
    expect(mediaMatches?.length ?? 0).toBeGreaterThanOrEqual(2);
  }, 60000);
});
