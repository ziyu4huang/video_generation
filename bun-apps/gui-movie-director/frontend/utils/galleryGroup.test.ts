import { describe, it, expect } from "bun:test";
import {
  normalizeTransformerKey,
  groupByTransformer,
} from "./galleryGroup";
import type { GalleryImage } from "../types";

function img(name: string, transformer?: string): GalleryImage {
  return {
    name,
    url: `/output/0/${name}`,
    size: 1,
    createdAt: name, // fake timestamp — only order matters
    run: transformer ? { transformer } : null,
    manifest: null,
  };
}

describe("normalizeTransformerKey", () => {
  it("strips -8bit", () =>
    expect(normalizeTransformerKey("ernie-redmix-redzit15-8bit")).toBe(
      "ernie-redmix-redzit15",
    ));
  it("strips -4bit with group size", () =>
    expect(normalizeTransformerKey("ernie-redmix-redzit15-4bit-g32")).toBe(
      "ernie-redmix-redzit15",
    ));
  it("leaves the 4-bit base alone", () =>
    expect(normalizeTransformerKey("ernie-redmix-redzit15")).toBe(
      "ernie-redmix-redzit15",
    ));
  it("strips -requant-test", () =>
    expect(normalizeTransformerKey("klein-9b-requant-test")).toBe("klein-9b"));
  it("strips -bf16", () =>
    expect(normalizeTransformerKey("some-model-bf16")).toBe("some-model"));
  it("does NOT collapse a model-family suffix (-dark-beast-bfs)", () =>
    expect(normalizeTransformerKey("klein-9b-dark-beast-bfs")).toBe(
      "klein-9b-dark-beast-bfs",
    ));
  it("does NOT collapse a version suffix (-v126)", () =>
    expect(normalizeTransformerKey("zimage-moody-v126")).toBe(
      "zimage-moody-v126",
    ));
  it("handles empty / null", () => {
    expect(normalizeTransformerKey("")).toBe("");
    expect(normalizeTransformerKey(null)).toBe("");
    expect(normalizeTransformerKey(undefined)).toBe("");
  });
});

describe("groupByTransformer", () => {
  it("clusters a 4-bit vs 8-bit A/B pair into one group", () => {
    const groups = groupByTransformer([
      img("a.png", "ernie-redmix-redzit15-8bit"),
      img("b.png", "ernie-redmix-redzit15"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("ernie-redmix-redzit15");
    expect(groups[0].items.map((i) => i.name)).toEqual(["a.png", "b.png"]);
  });

  it("keeps different model families in separate groups", () => {
    const groups = groupByTransformer([
      img("a.png", "klein-9b"),
      img("b.png", "klein-9b-dark-beast-bfs"),
      img("c.png", "dasiwa"),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "klein-9b",
      "klein-9b-dark-beast-bfs",
      "dasiwa",
    ]);
  });

  it("orders groups newest-first (first-seen = newest member)", () => {
    const groups = groupByTransformer([
      img("newest-dasiwa.png", "dasiwa"),
      img("old-klein.png", "klein-9b"),
      img("newer-dasiwa.png", "dasiwa"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["dasiwa", "klein-9b"]);
    expect(groups[0].items.map((i) => i.name)).toEqual([
      "newest-dasiwa.png",
      "newer-dasiwa.png",
    ]);
  });

  it("floats the no-model group to the end", () => {
    const groups = groupByTransformer([
      img("upload1.png"), // no run
      img("render.png", "klein-9b"),
      img("upload2.png"), // no run
    ]);
    expect(groups[groups.length - 1].isNoModel).toBe(true);
    expect(groups[groups.length - 1].items).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const input = [
      img("a.png", "dasiwa"),
      img("b.png", "klein-9b"),
    ];
    const snapshot = input.map((i) => i.name);
    groupByTransformer(input);
    expect(input.map((i) => i.name)).toEqual(snapshot);
  });

  it("returns an empty array for empty input", () =>
    expect(groupByTransformer([])).toEqual([]));
});
