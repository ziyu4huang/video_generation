import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatAbsoluteTime, formatRelativeTime } from "../src/time-format.js";

const NOW = 1_700_000_000_000; // fixed reference "now"

test("formatRelativeTime buckets", () => {
  assert.equal(formatRelativeTime(NOW - 5_000, NOW), "just now"); // <60s
  assert.equal(formatRelativeTime(NOW - 120_000, NOW), "2m ago"); // <60m
  assert.equal(formatRelativeTime(NOW - 3 * 3_600_000, NOW), "3h ago"); // <24h
  assert.equal(formatRelativeTime(NOW - 2 * 86_400_000, NOW), "2d ago"); // >=24h
});

test("formatAbsoluteTime looks like HH:MM", () => {
  assert.match(formatAbsoluteTime(NOW), /^\d{1,2}:\d{2}$/);
});
