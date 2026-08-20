/**
 * Tests for scope resolution.
 *
 * Two real hazards drive these cases:
 *  - a DELETED worktree still owns session history, and those are the finished
 *    efforts, so the family prefix must keep them;
 *  - a LIVE worktree can sit outside the family prefix (/private/tmp/...), so the
 *    worktree roots must be unioned in.
 */
import { test, expect, describe } from "bun:test";
import { buildScope, inScope } from "../scope.ts";

const scope = buildScope("/Users/me/proj/video_generation", [
  "/Users/me/proj/video_generation",
  "/private/tmp/precheck-rename",
]);

describe("inScope", () => {
  test("accepts the main worktree", () => {
    expect(inScope("/Users/me/proj/video_generation", scope)).toBe(true);
  });

  test("accepts a sibling worktree by family prefix", () => {
    expect(inScope("/Users/me/proj/video_generation__embed", scope)).toBe(true);
  });

  test("accepts a DELETED worktree still holding history", () => {
    expect(inScope("/Users/me/proj/video_generation__archify", scope)).toBe(true);
  });

  test("accepts a subdirectory of a worktree", () => {
    expect(inScope("/Users/me/proj/video_generation__archify/bun-apps/s2-agent", scope)).toBe(true);
  });

  test("accepts a live worktree outside the family prefix", () => {
    expect(inScope("/private/tmp/precheck-rename", scope)).toBe(true);
  });

  test("rejects an unrelated repo", () => {
    expect(inScope("/Users/me/proj/something_else", scope)).toBe(false);
  });

  test("rejects a scratchpad under an unrelated tmp path", () => {
    expect(inScope("/private/tmp/claude-501/scratchpad", scope)).toBe(false);
  });

  test("rejects a session with no cwd", () => {
    expect(inScope(undefined, scope)).toBe(false);
  });
});
