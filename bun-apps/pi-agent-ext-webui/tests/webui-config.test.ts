/**
 * webui-config.test.ts — the optionality gate (architecture v2 §3.1).
 */
import { describe, expect, it } from "bun:test";
import { isWebuiDisabled, resolveWebuiEnabled } from "../src/webui-config.js";

describe("isWebuiDisabled", () => {
  it("false when WEBUI_DISABLED is absent", () => {
    expect(isWebuiDisabled({})).toBe(false);
  });

  it("false when WEBUI_DISABLED is empty", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "" })).toBe(false);
  });

  it("true for '1'", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "1" })).toBe(true);
  });

  it("true for 'true' (case-insensitive)", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "TRUE" })).toBe(true);
  });

  it("false for any other value ('0', 'yes', 'on')", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "0" })).toBe(false);
    expect(isWebuiDisabled({ WEBUI_DISABLED: "yes" })).toBe(false);
    expect(isWebuiDisabled({ WEBUI_DISABLED: "on" })).toBe(false);
  });

  it("defaults to process.env when no arg given", () => {
    expect(typeof isWebuiDisabled()).toBe("boolean");
  });
});

describe("resolveWebuiEnabled", () => {
  it("env alone: enabled by default, disabled by WEBUI_DISABLED", () => {
    expect(resolveWebuiEnabled({})).toBe(true);
    expect(resolveWebuiEnabled({ WEBUI_DISABLED: "1" })).toBe(false);
  });

  it("explicit override wins over env (both directions)", () => {
    expect(resolveWebuiEnabled({ WEBUI_DISABLED: "1" }, true)).toBe(true);
    expect(resolveWebuiEnabled({}, false)).toBe(false);
  });
});
