/**
 * image-presentation.test.ts — pure-function matrix for the /output/0/<rel>
 * markdown helpers (spec Component 5) + the webui_present description edit.
 */
import { describe, expect, test } from "bun:test";
import { imageMd, imageMdFromDetails } from "../src/image-presentation.js";
import { createPresentTool } from "../src/present-tool.js";
import * as path from "node:path";

const OUT = path.resolve("/tmp/fake-out");

describe("imageMd", () => {
  test("flat file -> /output/0/<basename>", () => {
    expect(imageMd(path.join(OUT, "shot_001.png"), OUT)).toBe("![image](/output/0/shot_001.png)");
  });

  test("subpath preserved (profile_TS/front.png)", () => {
    expect(imageMd(path.join(OUT, "profile_TS", "front.png"), OUT)).toBe(
      "![image](/output/0/profile_TS/front.png)"
    );
  });

  test("escape outside the output dir -> null", () => {
    expect(imageMd(path.resolve("/tmp/elsewhere", "evil.png"), OUT)).toBeNull();
  });

  test("sibling-dir bypass (../out-secret/x.png, no trailing-sep bug) -> null", () => {
    expect(imageMd(path.resolve("/tmp/out-secret", "x.png"), OUT)).toBeNull();
  });

  test("the output dir itself -> null", () => {
    expect(imageMd(OUT, OUT)).toBeNull();
  });

  test("non-image extension (mp4) -> null (video presentation is deferred fog)", () => {
    expect(imageMd(path.join(OUT, "clip.mp4"), OUT)).toBeNull();
  });

  test("case-insensitive image extension (.PNG)", () => {
    expect(imageMd(path.join(OUT, "SHOT.PNG"), OUT)).toBe("![image](/output/0/SHOT.PNG)");
  });

  test("a file literally named ..foo.png INSIDE the dir still serves (no false escape)", () => {
    expect(imageMd(path.join(OUT, "..foo.png"), OUT)).toBe("![image](/output/0/..foo.png)");
  });

  test("space in the filename is percent-encoded (marked rejects raw spaces)", () => {
    expect(imageMd(path.join(OUT, "a b.png"), OUT)).toBe("![image](/output/0/a%20b.png)");
  });

  test("parens: space encoded, balanced parens preserved (CommonMark-safe destination)", () => {
    expect(imageMd(path.join(OUT, "shot (1).png"), OUT)).toBe("![image](/output/0/shot%20(1).png)");
  });

  test("a clean path is unchanged by percent-encoding (encodeURI no-op)", () => {
    expect(imageMd(path.join(OUT, "plain_shot.png"), OUT)).toBe("![image](/output/0/plain_shot.png)");
  });
});

describe("imageMdFromDetails", () => {
  test("details.output string", () => {
    expect(imageMdFromDetails({ output: path.join(OUT, "a.png") }, OUT)).toEqual([
      "![image](/output/0/a.png)",
    ]);
  });

  test("details.output null -> skipped", () => {
    expect(imageMdFromDetails({ output: null }, OUT)).toEqual([]);
  });

  test("outputs string-array", () => {
    expect(imageMdFromDetails({ outputs: [path.join(OUT, "a.png"), path.join(OUT, "b.jpg")] }, OUT)).toEqual([
      "![image](/output/0/a.png)",
      "![image](/output/0/b.jpg)",
    ]);
  });

  test("outputs object-array [{path}] — the [object Object] regression", () => {
    // Real flux2/ltx shape: details.outputs entries are objects with .path.
    // Naive template interpolation rendered "[object Object]"; this MUST map
    // through .path and produce real markdown.
    expect(
      imageMdFromDetails(
        { outputs: [{ path: path.join(OUT, "a.png") }, { path: path.join(OUT, "sub", "b.webp") }] },
        OUT
      )
    ).toEqual(["![image](/output/0/a.png)", "![image](/output/0/sub/b.webp)"]);
  });

  test("mixed object/string outputs array", () => {
    expect(
      imageMdFromDetails({ outputs: [path.join(OUT, "a.png"), { path: path.join(OUT, "b.png") }] }, OUT)
    ).toEqual(["![image](/output/0/a.png)", "![image](/output/0/b.png)"]);
  });

  test("output first, then outputs[] — order preserved; dedupe across both", () => {
    expect(
      imageMdFromDetails(
        { output: path.join(OUT, "a.png"), outputs: [path.join(OUT, "a.png"), path.join(OUT, "b.png")] },
        OUT
      )
    ).toEqual(["![image](/output/0/a.png)", "![image](/output/0/b.png)"]);
  });

  test("non-image filtered (mp4 excluded, png kept)", () => {
    expect(
      imageMdFromDetails({ outputs: [path.join(OUT, "clip.mp4"), path.join(OUT, "a.png")] }, OUT)
    ).toEqual(["![image](/output/0/a.png)"]);
  });

  test("object entry with non-string .path skipped, object without .path skipped", () => {
    expect(imageMdFromDetails({ outputs: [{ path: 42 }, { nope: 1 }] }, OUT)).toEqual([]);
  });

  test("empty / absent / non-object details -> []", () => {
    expect(imageMdFromDetails({}, OUT)).toEqual([]);
    expect(imageMdFromDetails(null, OUT)).toEqual([]);
    expect(imageMdFromDetails("string", OUT)).toEqual([]);
    expect(imageMdFromDetails({ outputs: [] }, OUT)).toEqual([]);
  });
});

describe("webui_present description teaches the /output pattern", () => {
  test("description mentions ![image](/output/0/<name>)", () => {
    const tool = createPresentTool({
      present: () => "id",
      registerPending: async () => ({ cancelled: true }),
      hasPending: () => false,
      cancelPending: () => {},
    });
    expect(tool.description).toContain("![image](/output/0/<name>)");
    expect(tool.promptSnippet).toContain("/output/0/");
  });
});
