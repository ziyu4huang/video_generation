import { describe, expect, test } from "bun:test";
import { buildManifestObject, manifestText, type ManifestJson } from "./registry-to-manifest.ts";
import type { Registry } from "./registry.ts";

// Hand-built registry literal (no YAML, no fs) covering the shapes the
// emitter must distinguish: a deployed skill carrier, a
// deploy-less entry, a plain one, and dynamic entries with/without version.
const registry: Registry = {
  deploy: {
    outRoot: "/tmp/s2-agent-out",
    version: { from: "package.json", gitSha: true },
    freeze: true,
    current: true,
  },
  hostApi: 1,
  hostModules: ["session"],
  extensions: [
    {
      name: "alpha",
      package: "s2-agent-ext-alpha",
      entry: "extensions/alpha.ts",
      load: "static",
      skills: true,
      deploy: { order: 1, copy: [], vendor: [], externals: [], vendorExclude: [], assets: [], enabled: true },
    },
    {
      name: "beta",
      package: "s2-agent-ext-beta",
      entry: "extensions/beta.ts",
      load: "static",
      skills: true,
      excludeReason: "local-only helper",
    },
    {
      name: "gamma",
      package: "s2-agent-ext-gamma",
      entry: "extensions/gamma.ts",
      load: "static",
      skills: false,
      deploy: { order: 2, copy: [], vendor: [], externals: [], vendorExclude: [], assets: [], enabled: true },
    },
    {
      name: "delta",
      package: "s2-agent-ext-delta",
      entry: "extensions/delta.ts",
      load: "dynamic",
      skills: false,
      version: "0.1.0",
      deploy: { order: 3, copy: [], vendor: [], externals: [], vendorExclude: [], assets: [], enabled: true },
    },
    {
      name: "epsilon",
      package: "s2-agent-ext-epsilon",
      entry: "extensions/epsilon.ts",
      load: "dynamic",
      skills: false,
      excludeReason: "experimental",
    },
  ],
  lazyExtensions: { "lazy-one": "s2-agent-ext-lazy-one/extensions/lazy-one.ts" },
};

describe("buildManifestObject", () => {
  test("staticExtensions is the registry-ordered list of load:static packages", () => {
    const m = buildManifestObject(registry);
    expect(m.staticExtensions).toEqual(["s2-agent-ext-alpha", "s2-agent-ext-beta", "s2-agent-ext-gamma"]);
  });

  test("skills includes BOTH deployed and non-deployed skill carriers, in registry order", () => {
    const m = buildManifestObject(registry);
    expect(m.skills).toEqual(["s2-agent-ext-alpha/skills", "s2-agent-ext-beta/skills"]);
  });

  test("extensions carries only load:dynamic entries with package-prefixed entries and version only when set", () => {
    const m = buildManifestObject(registry);
    expect(m.extensions).toHaveLength(2);
    expect(m.extensions[0]).toEqual({
      name: "delta",
      entry: "s2-agent-ext-delta/extensions/delta.ts",
      version: "0.1.0",
    });
    expect(m.extensions[1]).toEqual({ name: "epsilon", entry: "s2-agent-ext-epsilon/extensions/epsilon.ts" });
    expect("version" in m.extensions[1]).toBe(false);
  });

  test("lazyExtensions passes through verbatim", () => {
    const m = buildManifestObject(registry);
    expect(m.lazyExtensions).toEqual({ "lazy-one": "s2-agent-ext-lazy-one/extensions/lazy-one.ts" });
  });

  test("$generated is present and the first key of the emitted object", () => {
    const m = buildManifestObject(registry);
    expect(m.$generated).toBe("from src/registry-config.ts by regen:manifest — do not edit");
    expect(Object.keys(m)[0]).toBe("$generated");
  });
});

describe("manifestText", () => {
  test("is tab-indented JSON with a trailing newline and parses back deep-equal", () => {
    const m = buildManifestObject(registry);
    const text = manifestText(m);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(JSON.stringify(m, null, "\t") + "\n");
    expect(JSON.parse(text)).toEqual(m as unknown as ManifestJson);
  });
});
