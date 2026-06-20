import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { guiPortMain, ageLabel } from "./gui-port";
import { registerServer, _setRegistryPathForTest } from "../lib/gui-registry";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-"));
  _setRegistryPathForTest(path.join(tmpDir, "servers.json"));
});
afterEach(() => {
  _setRegistryPathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function reg(root: string, port: number): void {
  registerServer({
    root,
    port,
    pid: process.pid,
    hostname: "127.0.0.1",
    url: `http://127.0.0.1:${port}`,
    startedAt: Date.now(),
  });
}

test("default prints own url (exit 0)", () => {
  reg("/wt/me", 3247);
  const r = guiPortMain({ argv: [], ownRoot: "/wt/me" });
  expect(r.code).toBe(0);
  expect(r.output).toBe("http://127.0.0.1:3247");
});

test("default exits 1 with hint when own server is not running", () => {
  reg("/wt/other", 3248);
  const r = guiPortMain({ argv: [], ownRoot: "/wt/me" });
  expect(r.code).toBe(1);
  expect(r.output).toContain("No GUI server registered");
});

test("default with no git identity still reports not-running", () => {
  const r = guiPortMain({ argv: [], ownRoot: null });
  expect(r.code).toBe(1);
  expect(r.output).toContain("No GUI server running");
});

test("--all lists every live server and marks this worktree", () => {
  reg("/wt/me", 3247);
  reg("/wt/other", 3248);
  const r = guiPortMain({ argv: ["--all"], ownRoot: "/wt/me" });
  expect(r.code).toBe(0);
  expect(r.output).toContain("http://127.0.0.1:3247");
  expect(r.output).toContain("http://127.0.0.1:3248");
  expect(r.output).toContain("← this worktree");
});

test("--all reports when none running", () => {
  const r = guiPortMain({ argv: ["--all"], ownRoot: "/wt/me" });
  expect(r.code).toBe(0);
  expect(r.output).toContain("No GUI servers running");
});

test("--json is machine-readable and carries root + own + all", () => {
  reg("/wt/me", 3247);
  const r = guiPortMain({ argv: ["--json"], ownRoot: "/wt/me" });
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.output);
  expect(parsed.root).toBe("/wt/me");
  expect(parsed.own.url).toBe("http://127.0.0.1:3247");
  expect(Array.isArray(parsed.all)).toBe(true);
  expect(parsed.all.length).toBe(1);
});

test("ageLabel formats seconds / minutes / hours", () => {
  const now = 1_000_000;
  expect(ageLabel(now - 5_000, now)).toBe("5s");
  expect(ageLabel(now - 125_000, now)).toBe("2m5s");
  expect(ageLabel(now - 3_700_000, now)).toBe("1h1m");
});
