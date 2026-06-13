import { describe, it, expect } from "bun:test";
import { qualityCommand } from "./quality";
import { invariants } from "./test-helpers";

invariants(qualityCommand);

describe("quality: isDisabled", () => {
  it("is disabled when quality_inputs is absent", () => {
    expect(qualityCommand.isDisabled!({})).toBe(true);
  });

  it("is disabled when quality_inputs is empty array", () => {
    expect(qualityCommand.isDisabled!({ quality_inputs: [] })).toBe(true);
  });

  it("is enabled when at least one image is provided", () => {
    expect(qualityCommand.isDisabled!({ quality_inputs: ["/img.png"] })).toBe(false);
  });
});

describe("quality: buildParams", () => {
  it("passes through quality_inputs array", () => {
    const images = ["/a.png", "/b.png"];
    const r = qualityCommand.buildParams!({ quality_inputs: images });
    expect(r.quality_inputs).toEqual(images);
  });
});
