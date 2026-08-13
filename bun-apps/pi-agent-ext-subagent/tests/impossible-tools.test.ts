import { test } from "bun:test";
import assert from "node:assert/strict";
import { missingRequiredTools } from "../src/impossible-tools.js";

test("missingRequiredTools: undefined required ⇒ undefined (no requirement)", () => {
  assert.equal(missingRequiredTools(undefined, ["read", "bash"], undefined), undefined);
  assert.equal(missingRequiredTools([], ["read", "bash"], undefined), undefined);
});

test("missingRequiredTools: required present in allowlist ⇒ undefined", () => {
  assert.equal(missingRequiredTools(["read"], ["read", "bash"], undefined), undefined);
  assert.equal(missingRequiredTools(["read", "bash"], ["read", "bash"], undefined), undefined);
});

test("missingRequiredTools: required absent from allowlist ⇒ the missing names", () => {
  assert.deepEqual(missingRequiredTools(["memory"], ["read", "bash"], undefined), ["memory"]);
  assert.deepEqual(missingRequiredTools(["read", "memory"], ["read", "bash"], undefined), ["memory"]);
});

test("missingRequiredTools: excludeTools denies a 'present' tool ⇒ it is missing", () => {
  // 'edit' is in the allowlist but excluded → after exclusion it is unavailable.
  assert.deepEqual(missingRequiredTools(["edit"], ["read", "edit", "write"], ["edit"]), ["edit"]);
  // 'read' survives the exclusion. (deepEqual: compares array CONTENT, not reference identity.)
  assert.deepEqual(missingRequiredTools(["read", "edit"], ["read", "edit"], ["edit"]), ["edit"]);
});

test("missingRequiredTools: undefined resolved (no concrete allowlist) ⇒ undefined (never false-abort)", () => {
  // The child inherits a default/gated set we can't enumerate here → can't confirm a miss.
  assert.equal(missingRequiredTools(["memory"], undefined, undefined), undefined);
});

test("missingRequiredTools: preserves required order, no dedup", () => {
  assert.deepEqual(missingRequiredTools(["z", "a", "z"], ["a"], undefined), ["z", "z"]);
});
