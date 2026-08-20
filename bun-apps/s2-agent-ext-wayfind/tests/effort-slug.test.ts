import { describe, expect, it } from "bun:test";
import { effortSlug, slugify } from "../src/wayfinder.js";

describe("effortSlug", () => {
  it("prepends today's date (YYYY-MM-DD-) to the bare slug", () => {
    const today = new Date();
    const prefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(effortSlug("Add Video Relay")).toBe(`${prefix}-add-video-relay`);
  });

  it("lowercases, hyphenates, trims the slug half", () => {
    expect(effortSlug("  Fix the /plan handoff!  ")).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-fix-the-plan-handoff$/);
  });

  it("falls back to 'effort' when the slug half is empty", () => {
    expect(effortSlug("   ")).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-effort$/);
  });
});

describe("slugify (unchanged — bare, no date)", () => {
  it("produces a bare slug with no date prefix (used for ticket slugs)", () => {
    expect(slugify("Storage Layer")).toBe("storage-layer");
    expect(slugify("Storage Layer")).not.toMatch(/^[0-9]{4}-/);
  });
});
