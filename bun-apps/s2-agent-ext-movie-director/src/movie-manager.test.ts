/**
 * Unit test for the WorkflowManager factory that makes the /movie commands
 * crash-resumable. (Handler routing: movie-workflows-routing.test.ts; resume
 * replay: Phase 3.)
 */
import { describe, test, expect } from "bun:test";
import { WorkflowManager } from "@repo/s2-agent-ext-ultracode";
import { createMovieManager } from "./movie-manager.ts";

describe("movie-manager: createMovieManager", () => {
  test("returns a real WorkflowManager", () => {
    const mgr = createMovieManager(process.cwd());
    expect(mgr instanceof WorkflowManager).toBe(true);
  });

  test("each call yields a fresh instance (no shared listener/cache state to leak)", () => {
    const a = createMovieManager(process.cwd());
    const b = createMovieManager(process.cwd());
    expect(b).not.toBe(a);
  });
});
