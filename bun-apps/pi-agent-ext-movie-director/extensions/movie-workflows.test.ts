/**
 * Structural test for the movie-director saved workflows. For each .js under
 * workflows/:
 *   (a) parseWorkflowScript must succeed (valid workflow syntax + meta export)
 *   (b) every call('movie.X', …) reference must resolve to a registered host-fn
 *       (catches typo'd command names before a real run hits "not registered")
 *
 * Deterministic, no GPU, no model. Applies to all 4 workflows as they land.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowScript } from "@repo/pi-agent-ext-workflow";
import { buildMovieHostFnRegistry } from "../src/host-fns.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".js") && !f.startsWith("_"));

describe("movie-director saved workflows (structural)", () => {
  const registry = buildMovieHostFnRegistry();
  const registered = new Set(registry.list());

  test("there is at least one workflow file", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  test("all 4 canonical saved workflows are discovered", () => {
    const names = workflowFiles.map((f) => f.replace(/\.js$/, "")).sort();
    expect(names).toEqual(["produce-video", "research-first", "review-cut", "scene-assets"]);
  });

  for (const file of workflowFiles) {
    const name = file.replace(/\.js$/, "");
    const script = readFileSync(join(WORKFLOWS_DIR, file), "utf8");

    describe(`${name}.js`, () => {
      test("parses as a valid workflow script", () => {
        const { meta } = parseWorkflowScript(script);
        expect(meta.name).toBe(name);
        expect(Array.isArray(meta.phases)).toBe(true);
        expect(meta.phases!.length).toBeGreaterThan(0);
      });

      test("every call('movie.X', …) reference resolves to a registered host-fn", () => {
        // match call('movie.write-checkpoint' or call("movie.generate" etc.
        const refs = [...script.matchAll(/call\(\s*['"]movie\.([a-z0-9-]+)['"]/gi)].map(
          (m) => `movie.${m[1]}`,
        );
        expect(refs.length, `${name} should use at least one movie.* host-fn`).toBeGreaterThan(0);
        const unresolved = refs.filter((r) => !registered.has(r));
        expect(unresolved, `unresolved movie.* refs in ${name}: ${unresolved.join(", ")}`).toEqual([]);
      });
    });
  }
});
