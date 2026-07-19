import { validateManifest } from "../src/workflow-pack-manifest.js";

test("validateManifest accepts version, agents, and io block", () => {
  const m = validateManifest({
    name: "demo", description: "d", entry: "entry.js",
    version: "0.1.0",
    agents: "agents/*.md",
    io: {
      inputs: "inputs/",
      outputs: { naming: "timestamped", retention: "last-N" },
      intermediate: { persist: true, retention: "purge-after-run" },
      runs: { retention: "all" },
    },
  });
  expect(m.version).toBe("0.1.0");
  expect(m.agents).toBe("agents/*.md");
  expect(m.io?.outputs?.naming).toBe("timestamped");
  expect(m.io?.intermediate?.persist).toBe(true);
});

test("validateManifest rejects a non-string version", () => {
  expect(() => validateManifest({ name: "d", description: "d", entry: "e.js", version: 1 }))
    .toThrow(/version/);
});

test("validateManifest omits io/version/agents when not supplied", () => {
  const m = validateManifest({ name: "d", description: "d", entry: "e.js" });
  expect("io" in m).toBe(false);
  expect("version" in m).toBe(false);
  expect("agents" in m).toBe(false);
});
