import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, parseRegistry } from "./registry.ts";

/** Build a minimal valid registry with one static-deployed ext + one dynamic-local ext on disk. */
function fixture(): { text: string; bunAppsDir: string } {
  const bunAppsDir = mkdtempSync(join(tmpdir(), "registry-test-"));
  const mk = (pkg: string, entry: string) => {
    mkdirSync(join(bunAppsDir, pkg, "extensions"), { recursive: true });
    writeFileSync(join(bunAppsDir, pkg, "extensions", entry), "export default () => {};");
  };
  mk("s2-agent-ext-task", "task.ts");
  mk("s2-agent-ext-movie-director", "movie-director.ts");
  const text = `
deploy:
  outRoot: ~/proj/dist/s2-agent-sh
  version: { from: package.json, gitSha: true }
  freeze: true
  current: true
hostApi: 2
hostModules: ["@earendil-works/pi-coding-agent"]
extensions:
  - name: task
    package: s2-agent-ext-task
    entry: extensions/task.ts
    load: static
    deploy:
      order: 10
  - name: movie-director
    package: s2-agent-ext-movie-director
    entry: extensions/movie-director.ts
    load: dynamic
    version: "0.1.0"
    excludeReason: bound to this machine's swift CLIs and services
lazyExtensions: {}
`;
  return { text, bunAppsDir };
}

describe("loadRegistry (ticket 02 flip)", () => {
  const PKG_DIR = join(import.meta.dir, "..");
  const BUN_APPS = join(PKG_DIR, "..");

  test("deep-equals parseRegistry on the real retired YAML (the flip bridge)", () => {
    // While the YAML still exists (until ticket 04), the retired bridge and
    // the new REGISTRY-based read must agree exactly — this is the in-package
    // twin of src/registry-config.test.ts's equivalence net, asserted from the
    // consumer side (loadRegistry) rather than the projection side.
    const yamlText = readFileSync(join(PKG_DIR, "s2-agent.registry.yaml"), "utf8");
    const fromYaml = parseRegistry(yamlText, { bunAppsDir: BUN_APPS });
    const fromTs = loadRegistry({ bunAppsDir: BUN_APPS });
    expect(fromTs).toEqual(fromYaml);
  });

  test("returns the manifest-ready shape (active extensions, deployed blocks normalized)", () => {
    const r = loadRegistry({ bunAppsDir: BUN_APPS });
    expect(r.extensions.length).toBeGreaterThan(10);
    for (const e of r.extensions) {
      expect(e.skills).toBeBoolean();
      if (e.deploy) {
        expect(e.deploy.copy).toBeArray();
        expect(e.deploy.vendor).toBeArray();
        expect(e.deploy.enabled).toBeBoolean();
      } else {
        expect(e.excludeReason).toBeString();
      }
    }
  });
});

describe("parseRegistry", () => {
  test("parses the fixture", () => {
    const { text, bunAppsDir } = fixture();
    const r = parseRegistry(text, { bunAppsDir });
    expect(r.extensions).toHaveLength(2);
    expect(r.extensions[0]).toMatchObject({ name: "task", load: "static", skills: false });
    expect(r.extensions[0]?.deploy).toEqual({ order: 10, copy: [], vendor: [], externals: [], vendorExclude: [], enabled: true });
    expect(r.extensions[1]).toMatchObject({ load: "dynamic", excludeReason: expect.stringContaining("swift") });
    expect(r.hostApi).toBe(2);
  });
  test("deploy.keep is projected when valid, rejected when not", () => {
    const { text, bunAppsDir } = fixture();
    const withKeep = parseRegistry(text.replace("  current: true\n", "  current: true\n  keep: 3\n"), { bunAppsDir });
    expect(withKeep.deploy.keep).toBe(3);
    // absent → the key is simply not emitted (deploy applies its own default)
    expect(parseRegistry(text, { bunAppsDir }).deploy.keep).toBeUndefined();
    for (const bad of ["keep: 0", "keep: -1", "keep: two", "keep: 2.5"]) {
      expect(() => parseRegistry(text.replace("  current: true\n", `  current: true\n  ${bad}\n`), { bunAppsDir })).toThrow(
        /keep/,
      );
    }
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
  test("non-mapping lazyExtensions (list or scalar) → throws", () => {
    const { text, bunAppsDir } = fixture();
    const list = text.replace("lazyExtensions: {}", "lazyExtensions:\n  - foo");
    expect(() => parseRegistry(list, { bunAppsDir })).toThrow(/lazyExtensions/);
    const scalar = text.replace("lazyExtensions: {}", "lazyExtensions: 5");
    expect(() => parseRegistry(scalar, { bunAppsDir })).toThrow(/lazyExtensions/);
  });
  test("non-mapping deploy.version → throws", () => {
    const { text, bunAppsDir } = fixture();
    const bad = text.replace("version: { from: package.json, gitSha: true }", "version:\n      - package.json");
    expect(() => parseRegistry(bad, { bunAppsDir })).toThrow(/version/);
  });
  test("non-mapping deploy → throws", () => {
    const { text, bunAppsDir } = fixture();
    const bad = text.replace(/deploy:\n(?:  .*\n)+/, "deploy:\n  - not-a-mapping\n");
    expect(() => parseRegistry(bad, { bunAppsDir })).toThrow(/"deploy"/);
  });
  test("load outside {static,dynamic} → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("load: static", "load: eager"), { bunAppsDir })).toThrow(/load/);
  });
  test("a package both vendored and external → throws (silent wrong-build class)", () => {
    const { text, bunAppsDir } = fixture();
    const bad = text.replace(
      "      order: 10",
      '      order: 10\n      vendor: ["playwright-core"]\n      externals: ["playwright-core"]',
    );
    expect(() => parseRegistry(bad, { bunAppsDir })).toThrow(/both vendored and external.*playwright-core/);
  });
  test("vendorExclude parses through to the deploy block", () => {
    const { text, bunAppsDir } = fixture();
    const r = parseRegistry(
      text.replace("      order: 10", '      order: 10\n      vendorExclude: ["@fontsource/*"]'),
      { bunAppsDir },
    );
    expect(r.extensions[0]?.deploy?.vendorExclude).toEqual(["@fontsource/*"]);
  });
  test("a vendor root that vendorExclude also drops → throws (ship-and-drop contradiction)", () => {
    const { text, bunAppsDir } = fixture();
    for (const [exclude, label] of [
      ['vendorExclude: ["@hyperframes/producer"]', "exact"],
      ['vendorExclude: ["@hyperframes/*"]', "scope pattern"],
    ] as const) {
      const bad = text.replace(
        "      order: 10",
        `      order: 10\n      vendor: ["@hyperframes/producer"]\n      ${exclude}`,
      );
      expect(() => parseRegistry(bad, { bunAppsDir })).toThrow(/vendorExclude also drops.*@hyperframes\/producer/);
    }
  });
});
