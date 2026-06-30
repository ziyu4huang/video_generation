import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  registerServer,
  unregisterServer,
  listLiveServers,
  findOwnServer,
  isPidAlive,
  getRegistryPath,
  _setRegistryPathForTest,
  type ServerEntry,
} from "./gui-registry";

let tmpFile: string;
let tmpDir: string;

function entry(root: string, port: number, pid = process.pid): ServerEntry {
  return { root, port, pid, hostname: "127.0.0.1", url: `http://127.0.0.1:${port}`, startedAt: 123 };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  tmpFile = path.join(tmpDir, "servers.json");
  _setRegistryPathForTest(tmpFile);
});
afterEach(() => {
  _setRegistryPathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("register + findOwnServer round-trip", () => {
  registerServer(entry("/wt/a", 3247));
  expect(findOwnServer("/wt/a")?.port).toBe(3247);
  expect(findOwnServer("/wt/b")).toBeUndefined();
});

test("unregister removes the entry", () => {
  registerServer(entry("/wt/a", 3247));
  unregisterServer("/wt/a");
  expect(findOwnServer("/wt/a")).toBeUndefined();
});

test("re-register overwrites (same root, new port)", () => {
  registerServer(entry("/wt/a", 3247));
  registerServer(entry("/wt/a", 3248));
  expect(findOwnServer("/wt/a")?.port).toBe(3248);
});

test("listLiveServers prunes dead-pid entries (and rewrites the file)", () => {
  registerServer(entry("/wt/a", 3247, 999999)); // bogus pid ⇒ dead
  registerServer(entry("/wt/b", 3248, process.pid)); // us ⇒ alive
  const live = listLiveServers();
  expect(live.find((s) => s.root === "/wt/a")).toBeUndefined();
  expect(live.find((s) => s.root === "/wt/b")?.port).toBe(3248);
  // dead entry pruned on disk:
  const onDisk = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
  expect("/wt/a" in onDisk).toBe(false);
  expect("/wt/b" in onDisk).toBe(true);
});

test("isPidAlive: self alive, bogus dead", () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(999999)).toBe(false);
  expect(isPidAlive(0)).toBe(false);
});

test("getRegistryPath falls back to a per-location file when git is absent", () => {
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
  try {
    const p = getRegistryPath(noGit);
    expect(p).toBe(path.join(noGit, ".gui-servers.json"));
  } finally {
    fs.rmSync(noGit, { recursive: true, force: true });
  }
});
