/**
 * settings.ts — unit tests for the opt-in persistent status bar settings IO.
 * Pure decision fn (withWayfindStatusBar) is tested in isolation; the IO
 * wrappers (readWayfindStatusBar / writeWayfindStatusBar) are round-tripped via
 * the PI_CODING_AGENT_DIR override (mirrors how response-language/__tests__
 * isolates getAgentDir).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWayfindStatusBar, withWayfindStatusBar, writeWayfindStatusBar } from "../src/settings.js";

const S = (entries: Record<string, unknown>) => entries;

describe("withWayfindStatusBar (pure)", () => {
  test("sets the key to true on a clone", () => {
    expect(withWayfindStatusBar(S({ theme: "dark" }), true)).toEqual(S({ theme: "dark", wayfindStatusBar: true }));
  });

  test("sets the key to false on a clone", () => {
    expect(withWayfindStatusBar(S({ theme: "dark" }), false)).toEqual(S({ theme: "dark", wayfindStatusBar: false }));
  });

  test("overwrites an existing value", () => {
    expect(withWayfindStatusBar(S({ wayfindStatusBar: true }), false)).toEqual(S({ wayfindStatusBar: false }));
  });

  test("preserves sibling keys (shallow-merge)", () => {
    expect(
      withWayfindStatusBar(S({ responseLanguage: "zh-TW", askUserLanguage: "en", wayfindStatusBar: false }), true),
    ).toEqual(S({ responseLanguage: "zh-TW", askUserLanguage: "en", wayfindStatusBar: true }));
  });

  test("handles undefined current (empty base)", () => {
    expect(withWayfindStatusBar(undefined, true)).toEqual(S({ wayfindStatusBar: true }));
  });

  test("does not mutate the input", () => {
    const input = S({ wayfindStatusBar: false });
    withWayfindStatusBar(input, true);
    expect(input).toEqual(S({ wayfindStatusBar: false }));
  });
});

describe("readWayfindStatusBar / writeWayfindStatusBar (IO round-trip via PI_CODING_AGENT_DIR)", () => {
  let tmp: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-wf-sb-"));
    prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("default: missing file → false (never throws)", () => {
    expect(readWayfindStatusBar()).toBe(false);
  });

  test("writes true and round-trips", () => {
    writeWayfindStatusBar(true);
    expect(readWayfindStatusBar()).toBe(true);
  });

  test("writes false and round-trips", () => {
    writeWayfindStatusBar(false);
    expect(readWayfindStatusBar()).toBe(false);
  });

  test("preserves other keys when merging", () => {
    writeFileSync(join(tmp, "settings.json"), `${JSON.stringify({ theme: "dark", responseLanguage: "en" })}\n`);
    writeWayfindStatusBar(true);
    expect(readWayfindStatusBar()).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmp, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({ theme: "dark", responseLanguage: "en", wayfindStatusBar: true });
  });

  test("absent key → false (default off)", () => {
    writeFileSync(join(tmp, "settings.json"), `${JSON.stringify({ theme: "dark" })}\n`);
    expect(readWayfindStatusBar()).toBe(false);
  });

  test("non-boolean value → false (string 'true' is NOT truthy)", () => {
    writeFileSync(join(tmp, "settings.json"), `${JSON.stringify({ wayfindStatusBar: "true" })}\n`);
    expect(readWayfindStatusBar()).toBe(false);
  });

  test("non-boolean value → false (number)", () => {
    writeFileSync(join(tmp, "settings.json"), `${JSON.stringify({ wayfindStatusBar: 1 })}\n`);
    expect(readWayfindStatusBar()).toBe(false);
  });

  test("malformed JSON → false (never throws)", () => {
    writeFileSync(join(tmp, "settings.json"), "{ not valid json");
    expect(readWayfindStatusBar()).toBe(false);
  });

  test("creates the agent dir (mkdir -p) when absent, then writes", () => {
    // Point PI_CODING_AGENT_DIR at a nested path that doesn't exist yet.
    const nested = join(tmp, "deep", "agent");
    process.env.PI_CODING_AGENT_DIR = nested;
    writeWayfindStatusBar(true);
    expect(readWayfindStatusBar()).toBe(true);
  });
});
