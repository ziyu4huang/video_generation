import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegistry } from "./registry.ts";

/** Build a minimal valid registry with one static-deployed ext + one dynamic-local ext on disk. */
function fixture(): { text: string; bunAppsDir: string } {
  const bunAppsDir = mkdtempSync(join(tmpdir(), "registry-test-"));
  const mk = (pkg: string, entry: string) => {
    mkdirSync(join(bunAppsDir, pkg, "extensions"), { recursive: true });
    writeFileSync(join(bunAppsDir, pkg, "extensions", entry), "export default () => {};");
  };
  mk("pi-agent-ext-task", "task.ts");
  mk("pi-agent-ext-movie-director", "movie-director.ts");
  const text = `
deploy:
  outRoot: ~/proj/dist/pi-agent-sh
  version: { from: package.json, gitSha: true }
  freeze: true
  current: true
hostApi: 2
hostModules: ["@earendil-works/pi-coding-agent"]
extensions:
  - name: task
    package: pi-agent-ext-task
    entry: extensions/task.ts
    load: static
    deploy:
      order: 10
  - name: movie-director
    package: pi-agent-ext-movie-director
    entry: extensions/movie-director.ts
    load: dynamic
    version: "0.1.0"
    excludeReason: bound to this machine's swift CLIs and services
lazyExtensions: {}
`;
  return { text, bunAppsDir };
}

describe("parseRegistry", () => {
  test("parses the fixture", () => {
    const { text, bunAppsDir } = fixture();
    const r = parseRegistry(text, { bunAppsDir });
    expect(r.extensions).toHaveLength(2);
    expect(r.extensions[0]).toMatchObject({ name: "task", load: "static", skills: false, binarySkills: false });
    expect(r.extensions[0]?.deploy).toEqual({ order: 10, copy: [], vendor: [], externals: [], enabled: true });
    expect(r.extensions[1]).toMatchObject({ load: "dynamic", excludeReason: expect.stringContaining("swift") });
    expect(r.hostApi).toBe(2);
  });
  test("unknown TOP key → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("hostApi:", "hostapiX:"), { bunAppsDir })).toThrow(/hostapiX/);
  });
  test("unknown extension key → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("load: static", "loads: static"), { bunAppsDir })).toThrow(/loads/);
  });
  test("no deploy block and no excludeReason → throws", () => {
    const { text, bunAppsDir } = fixture();
    const bad = text.replace(/\n\s*excludeReason: bound[^\n]*/, "");
    expect(() => parseRegistry(bad, { bunAppsDir })).toThrow(/excludeReason/);
  });
  test("duplicate deploy order → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("order: 10", "order: 99"), { bunAppsDir })).not.toThrow();
    const { text: t2, bunAppsDir: d2 } = fixture();
    // add a second ext with the same order via string surgery on the dynamic entry
    const dup = t2.replace("load: dynamic", "load: dynamic\n    deploy:\n      order: 10");
    expect(() => parseRegistry(dup, { bunAppsDir: d2 })).toThrow(/order/);
  });
  test("deploy block + excludeReason on the same entry → throws naming the extension", () => {
    const { text, bunAppsDir } = fixture();
    const bad = text.replace("excludeReason: bound to this machine's swift CLIs and services", "deploy:\n      order: 20\n    excludeReason: stale rationale");
    expect(() => parseRegistry(bad, { bunAppsDir })).toThrow(/movie-director/);
  });
  test("entry not on disk → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("extensions/task.ts", "extensions/nope.ts"), { bunAppsDir })).toThrow(/nope/);
  });
  test("load outside {static,dynamic} → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("load: static", "load: eager"), { bunAppsDir })).toThrow(/load/);
  });
});
