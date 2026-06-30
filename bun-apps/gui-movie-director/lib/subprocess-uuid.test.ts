import { describe, it, expect } from "bun:test";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Bun.randomUUIDv7()", () => {
  it("matches UUID format regex", () => {
    expect(Bun.randomUUIDv7()).toMatch(UUID_V7_RE);
  });

  it("version digit is 7 (third group starts with 7)", () => {
    const id = Bun.randomUUIDv7();
    const thirdGroup = id.split("-")[2];
    expect(thirdGroup[0]).toBe("7");
  });

  it("variant bits are [89ab] in fourth group", () => {
    const id = Bun.randomUUIDv7();
    const fourthGroup = id.split("-")[3];
    expect("89ab").toContain(fourthGroup[0]);
  });

  it("sequential UUIDs are lexicographically non-decreasing (time-ordered prefix)", () => {
    const ids = Array.from({ length: 20 }, () => Bun.randomUUIDv7());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1] <= ids[i]).toBe(true);
    }
  });

  it("generates unique values across 20 sequential calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => Bun.randomUUIDv7()));
    expect(ids.size).toBe(20);
  });
});
