import { describe, expect, test } from "bun:test";
import { inferSessionType } from "./session-type.ts";

describe("inferSessionType", () => {
  test("no tools → discussion", () => {
    expect(inferSessionType({ toolNames: [], conversationText: "" })).toBe("discussion");
  });
  test("read-only tools only → review (pi-smart-compact hint: read-only ≠ implementation)", () => {
    expect(inferSessionType({ toolNames: ["read", "grep", "ls"], conversationText: "" })).toBe("review");
  });
  test("edit tools + test-failure signal → debugging", () => {
    expect(inferSessionType({ toolNames: ["edit", "read"], conversationText: "FAIL tests/foo.test.ts\nError: expected 1" })).toBe("debugging");
  });
  test("edit tools, no failure signal → implementation", () => {
    expect(inferSessionType({ toolNames: ["edit", "read"], conversationText: "all good" })).toBe("implementation");
  });
});
