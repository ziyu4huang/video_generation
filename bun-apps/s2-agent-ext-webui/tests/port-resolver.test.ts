import { describe, expect, it } from "bun:test";
import { resolvePort } from "../src/port-resolver.js";

describe("resolvePort", () => {
  it("WEBUI_PORT is honored", () => {
    expect(resolvePort({ WEBUI_PORT: "8080" })).toBe(8080);
  });

  it("PORT is honored when WEBUI_PORT is absent", () => {
    expect(resolvePort({ PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT wins over PORT when both are set", () => {
    expect(resolvePort({ WEBUI_PORT: "8080", PORT: "9000" })).toBe(8080);
  });

  it("neither set -> 0 (ephemeral)", () => {
    expect(resolvePort({})).toBe(0);
  });

  it("WEBUI_PORT non-numeric -> falls through to PORT", () => {
    expect(resolvePort({ WEBUI_PORT: "abc", PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT out of range (high) -> falls through", () => {
    expect(resolvePort({ WEBUI_PORT: "99999", PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT negative -> falls through", () => {
    expect(resolvePort({ WEBUI_PORT: "-5", PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT hex / scientific notation rejected (strict decimal)", () => {
    expect(resolvePort({ WEBUI_PORT: "0x10", PORT: "9000" })).toBe(9000);
    expect(resolvePort({ WEBUI_PORT: "1e3", PORT: "9000" })).toBe(9000);
    expect(resolvePort({ WEBUI_PORT: "+5", PORT: "9000" })).toBe(9000);
    expect(resolvePort({ WEBUI_PORT: "5.5", PORT: "9000" })).toBe(9000);
    expect(resolvePort({ WEBUI_PORT: "08080", PORT: "9000" })).toBe(8080); // leading zeros OK
  });

  it("WEBUI_PORT empty -> falls through", () => {
    expect(resolvePort({ WEBUI_PORT: "", PORT: "9000" })).toBe(9000);
  });

  it("both invalid -> 0", () => {
    expect(resolvePort({ WEBUI_PORT: "abc", PORT: "xyz" })).toBe(0);
  });

  it("does NOT default to 8090", () => {
    expect(resolvePort({})).toBe(0);
    expect(resolvePort({})).not.toBe(8090);
  });

  it("defaults to process.env when no arg given (unset in the runner -> 0)", () => {
    const savedWebui = process.env.WEBUI_PORT;
    const savedPort = process.env.PORT;
    delete process.env.WEBUI_PORT;
    delete process.env.PORT;
    try {
      expect(resolvePort()).toBe(0);
      expect(typeof resolvePort()).toBe("number");
      process.env.WEBUI_PORT = "9001";
      expect(resolvePort()).toBe(9001);
    } finally {
      if (savedWebui === undefined) delete process.env.WEBUI_PORT;
      else process.env.WEBUI_PORT = savedWebui;
      if (savedPort === undefined) delete process.env.PORT;
      else process.env.PORT = savedPort;
    }
  });
});
