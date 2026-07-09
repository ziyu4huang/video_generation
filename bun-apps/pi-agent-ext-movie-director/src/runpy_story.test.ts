/** Unit tests for runpy_story.ts — the run.py story adapter (angles/propose/shots).
 * Covers the pure CLI-arg builder (buildStoryArgs), the sentinel parser
 * (storyArtifactPathFromOutput), and the extraArgs allowlist. No spawn, no venv.
 */
import { describe, expect, it } from "bun:test";
import {
  buildStoryArgs,
  storyArtifactPathFromOutput,
  validateStoryExtraArgs,
} from "./runpy_story.ts";

describe("runpy_story buildStoryArgs", () => {
  it("angles: emits the sub-action + topic + count flags", () => {
    const args = buildStoryArgs({ subAction: "angles", topic: "a barista's first day", count: 3 }, null);
    expect(args[0]).toBe("story");
    expect(args[1]).toBe("angles");
    expect(args).toContain("--topic");
    expect(args).toContain("a barista's first day");
    expect(args).toContain("--count");
    expect(args).toContain("3");
  });

  it("propose: routes the propose sub-action", () => {
    const args = buildStoryArgs({ subAction: "propose", topic: "renewable energy", count: 2 }, null);
    expect(args[1]).toBe("propose");
    expect(args).toContain("--count");
  });

  it("shots: emits the proposal + concept-index + character flags", () => {
    const args = buildStoryArgs(
      { subAction: "shots", proposal: "/out/proposal.yaml", conceptIndex: 1, character: "/out/hero.png", judge: true },
      null,
    );
    expect(args[1]).toBe("shots");
    expect(args).toContain("--proposal");
    expect(args).toContain("/out/proposal.yaml");
    expect(args).toContain("--concept-index");
    expect(args).toContain("1");
    expect(args).toContain("--character");
    expect(args).toContain("/out/hero.png");
    expect(args).toContain("--judge");
  });

  it("defaults to the angles sub-action when none given", () => {
    const args = buildStoryArgs({ topic: "x" }, null);
    expect(args[1]).toBe("angles");
  });

  it("appends --gen-output-dir when provided", () => {
    const args = buildStoryArgs({ subAction: "angles", topic: "x" }, "/out/dir");
    expect(args).toContain("--gen-output-dir");
    expect(args).toContain("/out/dir");
  });
});

describe("runpy_story sentinel + allowlist", () => {
  it("parses the Angles: sentinel (last match wins)", () => {
    expect(storyArtifactPathFromOutput("noise\nAngles:    /out/a.json\n")).toBe("/out/a.json");
  });

  it("parses the Proposal: sentinel", () => {
    expect(storyArtifactPathFromOutput("Proposal:  /out/p.yaml\n")).toBe("/out/p.yaml");
  });

  it("returns null when no sentinel fired", () => {
    expect(storyArtifactPathFromOutput("just some stdout\n")).toBeNull();
  });

  it("accepts allowlisted extraArgs and rejects others", () => {
    expect(validateStoryExtraArgs(["--gen-output-dir", "/x"])).toEqual(["--gen-output-dir", "/x"]);
    expect(() => validateStoryExtraArgs(["--evil-flag"])).toThrow(/allowlist/);
  });
});
