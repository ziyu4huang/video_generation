import { describe, it, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { envInt } from "../../src/utils/env.js";

describe("envInt", () => {
  const NAME = "HERMES_TEST_ENV_INT";
  afterEach(() => { delete process.env[NAME]; });

  it("returns the fallback when the var is unset", () => {
    assert.strictEqual(envInt(NAME, 42), 42);
  });
  it("returns the fallback when the var is empty", () => {
    process.env[NAME] = "";
    assert.strictEqual(envInt(NAME, 42), 42);
  });
  it("parses a non-negative integer", () => {
    process.env[NAME] = "7";
    assert.strictEqual(envInt(NAME, 42), 7);
  });
  it("floors a float", () => {
    process.env[NAME] = "7.9";
    assert.strictEqual(envInt(NAME, 42), 7);
  });
  it("rejects a negative value (fallback)", () => {
    process.env[NAME] = "-3";
    assert.strictEqual(envInt(NAME, 42), 42);
  });
  it("rejects a non-numeric value (fallback)", () => {
    process.env[NAME] = "abc";
    assert.strictEqual(envInt(NAME, 42), 42);
  });
});
