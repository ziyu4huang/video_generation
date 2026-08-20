/**
 * Structural test for the movie-director saved workflows. Discovers both
 * flat single-file scripts (workflows/<name>.js) and workflow-pack
 * directories (workflows/<name>/manifest.json + entry) under workflows/.
 * For each discovered workflow:
 *   (a) parseWorkflowScript must succeed (valid workflow syntax + meta export)
 *   (b) every call('movie.X', …) reference must resolve to a registered host-fn
 *       (catches typo'd command names before a real run hits "not registered")
 *
 * Deterministic, no GPU, no model. Applies to all saved workflows as they land,
 * regardless of whether they're a flat script or a pack.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowScript, readManifest, resolveWorkflowScript, runWorkflowScript } from "@repo/s2-agent-ext-workflow";
import { buildMovieHostFnRegistry } from "../src/host-fns.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");

interface DiscoveredWorkflow {
  /** The workflow's name — from manifest.name (pack) or the filename minus .js (flat file). */
  name: string;
  /** The entry script's source text. */
  script: string;
}

/** Discover every workflow under `dir`: pack directories (has manifest.json)
 *  and flat `<name>.js` files. Entries starting with "_" are skipped (helper
 *  scripts like _resume-probe.js, not saved workflows). */
function discoverWorkflows(dir: string): DiscoveredWorkflow[] {
  const out: DiscoveredWorkflow[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("_")) continue;
    const entryPath = join(dir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      if (!existsSync(join(entryPath, "manifest.json"))) continue;
      const manifest = readManifest(entryPath);
      const script = readFileSync(join(entryPath, manifest.entry), "utf8");
      out.push({ name: manifest.name, script });
      continue;
    }
    if (stat.isFile() && entry.endsWith(".js")) {
      out.push({ name: entry.replace(/\.js$/, ""), script: readFileSync(entryPath, "utf8") });
    }
  }
  return out;
}

const workflows = discoverWorkflows(WORKFLOWS_DIR);

describe("movie-director saved workflows (structural)", () => {
  const registry = buildMovieHostFnRegistry();
  const registered = new Set(registry.list());

  test("there is at least one workflow", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  test("all 4 canonical saved workflows are discovered", () => {
    const names = workflows.map((w) => w.name).sort();
    expect(names).toEqual(["produce-video", "research-first", "review-cut", "scene-assets"]);
  });

  for (const wf of workflows) {
    describe(wf.name, () => {
      test("parses as a valid workflow script", () => {
        const { meta } = parseWorkflowScript(wf.script);
        expect(meta.name).toBe(wf.name);
        expect(Array.isArray(meta.phases)).toBe(true);
        expect(meta.phases!.length).toBeGreaterThan(0);
      });

      test("every call('movie.X', …) reference resolves to a registered host-fn", () => {
        // match call('movie.write-checkpoint' or call("movie.generate" etc.
        const refs = [...wf.script.matchAll(/call\(\s*['"]movie\.([a-z0-9-]+)['"]/gi)].map(
          (m) => `movie.${m[1]}`,
        );
        expect(refs.length, `${wf.name} should use at least one movie.* host-fn`).toBeGreaterThan(0);
        const unresolved = refs.filter((r) => !registered.has(r));
        expect(unresolved, `unresolved movie.* refs in ${wf.name}: ${unresolved.join(", ")}`).toEqual([]);
      });
    });
  }
});

describe("saved workflows resolve via the shared workflow-pack resolver", () => {
  const REPO_ROOT = join(HERE, "..", "..", "..");

  for (const name of ["produce-video", "research-first", "review-cut", "scene-assets"]) {
    describe(name, () => {
      test("resolveWorkflowScript finds it as a package-workflows pack", () => {
        const resolved = resolveWorkflowScript(name, { cwd: REPO_ROOT });
        expect(resolved.source).toBe("package-workflows");
        expect(resolved.pack?.manifest.name).toBe(name);
        expect(resolved.pack?.manifest.entry).toBe("index.js");
      });

      test("runWorkflowScript dry-run parses and validates without executing", async () => {
        const receipt = await runWorkflowScript({ name, cwd: REPO_ROOT, dryRun: true });
        expect(receipt.dryRun).toBe(true);
        expect(receipt.meta.name).toBe(name);
        expect(receipt.source).toBe("package-workflows");
      });
    });
  }
});
