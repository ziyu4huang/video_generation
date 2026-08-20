import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { splitFencedYaml } from "@repo/s2-agent-core-interface";

describe("splitFencedYaml (fence-split leaf)", () => {
  it("splits a well-formed fence (data parsed, body returned)", () => {
    const raw = "---\nid: ltx:cfg-scale-7\ntags: [zettel, lever]\nconfidence: 0.93\n---\n# heading\n\nbody line";
    const out = splitFencedYaml(raw);
    assert.notEqual(out, null);
    assert.deepEqual(out!.data, {
      id: "ltx:cfg-scale-7",
      tags: ["zettel", "lever"],
      confidence: 0.93,
    });
    assert.equal(out!.body, "# heading\n\nbody line");
  });

  it("returns null when there is no opening fence", () => {
    assert.equal(splitFencedYaml("# just a heading\n\nno frontmatter"), null);
    assert.equal(splitFencedYaml("preamble\n---\nid: x\n---\nbody"), null);
  });

  it("returns null when the closing fence is missing", () => {
    assert.equal(splitFencedYaml("---\nid: x\nbody with no close"), null);
  });

  it("returns null for malformed YAML between the fences", () => {
    // `: : bad` is not a valid YAML mapping — parse throws → leaf returns null.
    const malformed = "---\n: : bad\n  : [unclosed\n---\nbody";
    assert.equal(splitFencedYaml(malformed), null);
  });

  it("never throws — even pathological input resolves to null", () => {
    const inputs = ["", "---", "---\n---\n", "---\n\t\n---\n", "---\nkey: [1, 2, 3\n---\nbody"];
    for (const raw of inputs) {
      // Must not throw; result is either a split or null.
      let result: ReturnType<typeof splitFencedYaml> | undefined;
      assert.doesNotThrow(() => {
        result = splitFencedYaml(raw);
      });
      assert.ok(result === null || (typeof result === "object" && "data" in result! && "body" in result!));
    }
  });

  it("tolerates a non-object YAML payload (scalar/document) → empty data, body kept", () => {
    // A bare scalar between fences parses to a non-object → leaf coerces to {}.
    const out = splitFencedYaml("---\njust-a-scalar\n---\nbody");
    assert.notEqual(out, null);
    assert.deepEqual(out!.data, {});
    assert.equal(out!.body, "body");
  });
});
