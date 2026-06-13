import { describe, it, expect } from "bun:test";
import { ALL_COMMANDS } from "./registry";

describe("ALL_COMMANDS registry", () => {
  it("has 15 command entries", () => {
    expect(ALL_COMMANDS.length).toBe(15);
  });

  it("all command actions are unique", () => {
    const actions = ALL_COMMANDS.map((cmd) => cmd.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("all actions are non-empty strings", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(typeof cmd.action).toBe("string");
      expect(cmd.action.length).toBeGreaterThan(0);
    }
  });

  it("contains expected actions", () => {
    const actions = new Set(ALL_COMMANDS.map((cmd) => cmd.action));
    const expected = [
      "t2i", "i2i", "anime2real", "expansion", "faceswap", "swap",
      "controlnet", "angle", "profile", "quality", "workflow",
      "video-generate", "video-relay", "video-restore", "restore",
    ];
    for (const action of expected) {
      expect(actions.has(action)).toBe(true);
    }
  });

  it("all commands have at least one field", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(cmd.fields.length).toBeGreaterThan(0);
    }
  });

  it("all commands have submitLabel and runningLabel", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(typeof cmd.submitLabel).toBe("string");
      expect(typeof cmd.runningLabel).toBe("string");
    }
  });
});
