import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkpointPath, costLogPath, DATA_DIR, EXT_ROOT, historyDir, projectDir, projectsRoot } from "./paths.ts";

describe("EXT_ROOT / DATA_DIR", () => {
  it("EXT_ROOT is this package's root (parent of src/)", () => {
    expect(EXT_ROOT.endsWith("s2-agent-ext-movie-director")).toBe(true);
  });

  it("DATA_DIR is EXT_ROOT/data", () => {
    expect(DATA_DIR).toBe(join(EXT_ROOT, "data"));
  });
});

describe("projectsRoot", () => {
  it("defaults to ~/video_generation__output/movie-director/projects when MLX_OUTPUT_DIR is unset", () => {
    expect(projectsRoot({})).toBe(join(homedir(), "video_generation__output", "movie-director", "projects"));
  });

  it("uses MLX_OUTPUT_DIR/movie-director/projects when set", () => {
    expect(projectsRoot({ MLX_OUTPUT_DIR: "/tmp/custom-out" })).toBe(join("/tmp/custom-out", "movie-director", "projects"));
  });

  it("falls back to the default when MLX_OUTPUT_DIR is an empty string", () => {
    expect(projectsRoot({ MLX_OUTPUT_DIR: "" })).toBe(join(homedir(), "video_generation__output", "movie-director", "projects"));
  });
});

describe("project-scoped path helpers", () => {
  const env = { MLX_OUTPUT_DIR: "/tmp/custom-out" };

  it("projectDir joins projectsRoot + projectId", () => {
    expect(projectDir("proj-1", env)).toBe(join("/tmp/custom-out", "movie-director", "projects", "proj-1"));
  });

  it("checkpointPath is projectDir/checkpoint_<stage>.json", () => {
    expect(checkpointPath("proj-1", "script", env)).toBe(
      join("/tmp/custom-out", "movie-director", "projects", "proj-1", "checkpoint_script.json"),
    );
  });

  it("costLogPath is projectDir/cost_log.json", () => {
    expect(costLogPath("proj-1", env)).toBe(join("/tmp/custom-out", "movie-director", "projects", "proj-1", "cost_log.json"));
  });

  it("historyDir is projectDir/history", () => {
    expect(historyDir("proj-1", env)).toBe(join("/tmp/custom-out", "movie-director", "projects", "proj-1", "history"));
  });
});
