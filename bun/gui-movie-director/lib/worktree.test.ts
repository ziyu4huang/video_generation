import { test, expect, describe } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { derivePort, isMainWorktree, resolveDefaultPort, PRIMARY_PORT } from "./worktree";

describe("derivePort", () => {
  test("is stable (same input ⇒ same port)", () => {
    expect(derivePort("/a/b/c")).toBe(derivePort("/a/b/c"));
  });
  test("normalizes the path before hashing", () => {
    expect(derivePort("/a/b/c")).toBe(derivePort("/a/b/./c/"));
  });
  test("stays within [3099, 3998]", () => {
    for (let i = 0; i < 1000; i++) {
      const p = derivePort(`/x/${i}`);
      expect(p).toBeGreaterThanOrEqual(PRIMARY_PORT);
      expect(p).toBeLessThanOrEqual(PRIMARY_PORT + 899);
    }
  });
  test("gives a healthy spread across distinct inputs (no pathological collision)", () => {
    const ports = new Set<number>();
    for (let i = 0; i < 200; i++) ports.add(derivePort(`/wt/${i}`));
    // ~200 inputs into 900 buckets ⇒ birthday collisions are expected but modest.
    expect(ports.size).toBeGreaterThanOrEqual(150);
  });
});

describe("isMainWorktree (best-effort, never throws)", () => {
  test("true when .git is a directory (primary worktree)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-main-"));
    fs.mkdirSync(path.join(d, ".git"));
    expect(isMainWorktree(d)).toBe(true);
    fs.rmSync(d, { recursive: true });
  });
  test("false when .git is a file (linked worktree)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-linked-"));
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /somewhere/else\n");
    expect(isMainWorktree(d)).toBe(false);
    fs.rmSync(d, { recursive: true });
  });
  test("true when .git is absent (dist / non-git build)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-nogit-"));
    expect(isMainWorktree(d)).toBe(true);
    fs.rmSync(d, { recursive: true });
  });
});

describe("resolveDefaultPort", () => {
  test("primary worktree (real .git dir) ⇒ 3099", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-resolve-main-"));
    fs.mkdirSync(path.join(d, ".git"));
    expect(resolveDefaultPort(d)).toBe(PRIMARY_PORT);
    fs.rmSync(d, { recursive: true });
  });
  test("no-git dist build ⇒ 3099 (graceful default, no crash)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-resolve-dist-"));
    expect(resolveDefaultPort(d)).toBe(PRIMARY_PORT);
    fs.rmSync(d, { recursive: true });
  });
  test("linked worktree ⇒ derived port", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-resolve-linked-"));
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /x\n");
    expect(resolveDefaultPort(d)).toBe(derivePort(d));
    fs.rmSync(d, { recursive: true });
  });
});
