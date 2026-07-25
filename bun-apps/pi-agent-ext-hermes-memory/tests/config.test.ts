import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, shouldRunStartupSync } from "../src/config.js";
import { AGENT_ROOT } from "../src/paths.js";
import { derivePerUserNamespace } from "../src/store/surreal/per-user-db.js";

const TEST_CONFIG_PATH = path.join(os.tmpdir(), `hermes-memory-config-test-${process.pid}.json`);

afterEach(() => {
  fs.rmSync(TEST_CONFIG_PATH, { force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryMode, "policy-only");
    assert.strictEqual(config.memoryPolicyStyle, "full");
    assert.strictEqual(config.memoryPolicyCustomText, undefined);
    assert.strictEqual(config.memoryCharLimit, 10000);
    assert.strictEqual(config.userCharLimit, 10000);
    assert.strictEqual(config.nudgeInterval, 10);
    assert.strictEqual(config.reviewRecentMessages, 0);
    assert.strictEqual(config.reviewEnabled, true);
    assert.strictEqual(config.reviewTransport, "direct");
    assert.strictEqual(config.flushOnCompact, true);
    assert.strictEqual(config.flushOnShutdown, true);
    assert.strictEqual(config.flushMinTurns, 6);
    assert.strictEqual(config.flushRecentMessages, 0);
    assert.strictEqual(config.memoryOverflowStrategy, "auto-consolidate");
    assert.strictEqual(config.autoConsolidate, true);
    assert.strictEqual(config.failureInjectionEnabled, true);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 7);
    assert.strictEqual(config.failureInjectionMaxEntries, 5);
    assert.strictEqual(config.projectsMemoryDir, "projects-memory");
    assert.deepStrictEqual(config.sessionSearch, { variant: "legacy" });
    assert.strictEqual(config.llmModelOverride, undefined);
    assert.strictEqual(config.llmThinkingOverride, undefined);
  });

  it("PI_HERMES_CONSOLIDATING=1 forces autoConsolidate:false + vault-offload (consolidation child must not recurse)", () => {
    const prev = process.env.PI_HERMES_CONSOLIDATING;
    process.env.PI_HERMES_CONSOLIDATING = "1";
    try {
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.autoConsolidate, false, "consolidating child must not auto-consolidate");
      assert.strictEqual(config.memoryOverflowStrategy, "vault-offload", "consolidating child falls to vault-offload floor");
    } finally {
      if (prev === undefined) delete process.env.PI_HERMES_CONSOLIDATING;
      else process.env.PI_HERMES_CONSOLIDATING = prev;
    }
  });

  it("overrides defaults when config file exists", () => {
    // Write a config file
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryCharLimit: 3000,
      memoryMode: "legacy-inject",
      memoryPolicyStyle: "custom",
      memoryPolicyCustomText: "<memory-policy>Custom</memory-policy>",
      nudgeInterval: 15,
      reviewRecentMessages: 25,
      flushRecentMessages: 40,
      failureInjectionEnabled: false,
      failureInjectionMaxAgeDays: 30,
      failureInjectionMaxEntries: 2,
      projectsMemoryDir: "my-memory",
      llmModelOverride: " openrouter/deepseek/deepseek-v4-flash ",
      llmThinkingOverride: "minimal",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryMode, "legacy-inject");
    assert.strictEqual(config.memoryPolicyStyle, "custom");
    assert.strictEqual(config.memoryPolicyCustomText, "<memory-policy>Custom</memory-policy>");
    assert.strictEqual(config.memoryCharLimit, 3000);
    assert.strictEqual(config.nudgeInterval, 15);
    assert.strictEqual(config.reviewRecentMessages, 25);
    assert.strictEqual(config.flushRecentMessages, 40);
    assert.strictEqual(config.failureInjectionEnabled, false);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 30);
    assert.strictEqual(config.failureInjectionMaxEntries, 2);
    assert.strictEqual(config.projectsMemoryDir, "my-memory");
    assert.strictEqual(config.llmModelOverride, "openrouter/deepseek/deepseek-v4-flash");
    assert.strictEqual(config.llmThinkingOverride, "minimal");
    // Unset values use defaults
    assert.strictEqual(config.userCharLimit, 10000);
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("handles partial config (missing keys use defaults)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ reviewEnabled: false }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewEnabled, false);
    assert.strictEqual(config.memoryMode, "policy-only");
    assert.strictEqual(config.memoryPolicyStyle, "full");
    assert.strictEqual(config.memoryCharLimit, 10000); // default
    assert.strictEqual(config.reviewRecentMessages, 0);
    assert.strictEqual(config.flushRecentMessages, 0);
    assert.strictEqual(config.failureInjectionEnabled, true);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 7);
    assert.strictEqual(config.failureInjectionMaxEntries, 5);
    assert.strictEqual(config.projectsMemoryDir, "projects-memory");
    assert.strictEqual(config.llmModelOverride, undefined);
    assert.strictEqual(config.llmThinkingOverride, undefined);
  });

  it("expands ~/ memoryDir into an absolute home path", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryDir: "~/.pi/agent/pi-hermes-memory",
    }));

    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryDir, path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory"));
  });

  it("resolves relative memoryDir values against the agent root instead of cwd", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryDir: "custom-memory-root",
    }));

    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryDir, path.join(AGENT_ROOT, "custom-memory-root"));
  });

  it("normalizes projectsMemoryDir inside the agent root and ignores unsafe values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      projectsMemoryDir: ` ${path.join(AGENT_ROOT, "team-projects")}/ `,
    }));
    let config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.projectsMemoryDir, "team-projects");

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      projectsMemoryDir: "../escape",
    }));
    config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.projectsMemoryDir, "projects-memory");

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      projectsMemoryDir: "team/projects-memory",
    }));
    config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.projectsMemoryDir, "projects-memory");
  });

  it("handles partial config with all boolean overrides", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 20,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewEnabled, false);
    assert.strictEqual(config.flushOnCompact, false);
    assert.strictEqual(config.flushOnShutdown, false);
    assert.strictEqual(config.flushMinTurns, 20);
    assert.strictEqual(config.memoryCharLimit, 10000);
    assert.strictEqual(config.userCharLimit, 10000);
    assert.strictEqual(config.nudgeInterval, 10);
  });

  it("accepts review and flush recent-message limits independently", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      reviewRecentMessages: 12,
      flushRecentMessages: 34,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewRecentMessages, 12);
    assert.strictEqual(config.flushRecentMessages, 34);
  });

  it("ignores invalid recent-message limits", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      reviewRecentMessages: -1,
      flushRecentMessages: "5",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewRecentMessages, 0);
    assert.strictEqual(config.flushRecentMessages, 0);
  });

  it("handles empty file gracefully (falls back to defaults)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, "");
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("handles malformed JSON (falls back to defaults)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, "{ bad json }");
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryCharLimit, 10000);
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("ignores unknown keys in config file", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      unknownKey: "value",
      anotherKey: 123,
      memoryCharLimit: 1000,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryCharLimit, 1000);
    assert.strictEqual(config.memoryMode, "policy-only");
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("ignores invalid memoryMode values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryMode: "invalid",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryMode, "policy-only");
  });

  it("accepts valid memoryPolicyStyle values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    for (const style of ["full", "compact", "custom", "none"] as const) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ memoryPolicyStyle: style }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.memoryPolicyStyle, style);
    }
  });

  it("ignores invalid memoryPolicyStyle values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryPolicyStyle: "invalid",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryPolicyStyle, "full");
  });

  it("accepts string memoryPolicyCustomText and ignores non-string values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryPolicyCustomText: "custom policy",
    }));
    let config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryPolicyCustomText, "custom policy");

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryPolicyCustomText: 123,
    }));
    config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryPolicyCustomText, undefined);
  });

  it("accepts valid memoryOverflowStrategy values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    for (const policy of ["auto-consolidate", "reject", "fifo-evict"] as const) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ memoryOverflowStrategy: policy }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.memoryOverflowStrategy, policy);
      assert.strictEqual(config.autoConsolidate, policy === "auto-consolidate");
    }
  });

  it("accepts valid sessionSearch variants", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    for (const variant of ["legacy", "anchors"] as const) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ sessionSearch: { variant } }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.deepStrictEqual(config.sessionSearch, { variant });
    }
  });

  it("accepts valid reviewTransport values and ignores invalid ones", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    // "subprocess" was removed in the spawnSubagent migration — the fallback is now spawnSubagent, not a pi -p subprocess.
    for (const transport of ["direct"] as const) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ reviewTransport: transport }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.reviewTransport, transport);
    }

    // Invalid values fall back to "direct"
    for (const invalid of ["subprocess", "branch"] as const) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ reviewTransport: invalid }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.reviewTransport, "direct");
    }
  });

  it("accepts valid llmThinkingOverride values and ignores invalid ones", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ llmThinkingOverride: level }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.llmThinkingOverride, level);
    }

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ llmThinkingOverride: "ultra" }));
    const invalid = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(invalid.llmThinkingOverride, undefined);
  });

  it("ignores blank llmModelOverride values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ llmModelOverride: "   " }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.llmModelOverride, undefined);
  });

  it("ignores invalid sessionSearch variants", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      sessionSearch: { variant: "invalid" },
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.deepStrictEqual(config.sessionSearch, { variant: "legacy" });
  });

  it("ignores invalid memoryOverflowStrategy values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryOverflowStrategy: "invalid",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryOverflowStrategy, "auto-consolidate");
    assert.strictEqual(config.autoConsolidate, true);
  });

  it("maps legacy autoConsolidate boolean to memoryOverflowStrategy when strategy is absent", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ autoConsolidate: false }));
    let config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.autoConsolidate, false);
    assert.strictEqual(config.memoryOverflowStrategy, "reject");

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ autoConsolidate: true }));
    config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.autoConsolidate, true);
    assert.strictEqual(config.memoryOverflowStrategy, "auto-consolidate");
  });

  it("lets explicit memoryOverflowStrategy override legacy autoConsolidate", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      autoConsolidate: true,
      memoryOverflowStrategy: "fifo-evict",
    }));
    let config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryOverflowStrategy, "fifo-evict");
    assert.strictEqual(config.autoConsolidate, false);

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      autoConsolidate: false,
      memoryOverflowStrategy: "auto-consolidate",
    }));
    config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryOverflowStrategy, "auto-consolidate");
    assert.strictEqual(config.autoConsolidate, true);
  });

  it("accepts correction pattern string arrays including empty arrays", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      correctionStrongPatterns: ["^custom strong"],
      correctionWeakPatterns: [],
      correctionNegativePatterns: ["^custom negative"],
      correctionDirectiveWords: ["shipit"],
    }));

    const config = loadConfig(TEST_CONFIG_PATH);
    assert.deepStrictEqual(config.correctionStrongPatterns, ["^custom strong"]);
    assert.deepStrictEqual(config.correctionWeakPatterns, []);
    assert.deepStrictEqual(config.correctionNegativePatterns, ["^custom negative"]);
    assert.deepStrictEqual(config.correctionDirectiveWords, ["shipit"]);
  });

  it("ignores invalid correction pattern array values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      correctionStrongPatterns: "^custom strong",
      correctionWeakPatterns: ["^custom weak", 123],
      correctionNegativePatterns: [false],
      correctionDirectiveWords: { word: "shipit" },
    }));

    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.correctionStrongPatterns, undefined);
    assert.strictEqual(config.correctionWeakPatterns, undefined);
    assert.strictEqual(config.correctionNegativePatterns, undefined);
    assert.strictEqual(config.correctionDirectiveWords, undefined);
  });
});

describe("config dbBackend", () => {
  it("defaults to sqlite when unset", () => {
    const cfg = loadConfig(path.join(os.tmpdir(), `hm-cfg-${Date.now()}.json`));
    assert.strictEqual(cfg.dbBackend, "sqlite");
  });
  it("parses dbBackend: surrealdb and surreal connection overrides", () => {
    const p = path.join(os.tmpdir(), `hm-cfg-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({
      dbBackend: "surrealdb",
      surreal: { endpoint: "http://db:8000", namespace: "ns1", database: "db1" },
    }));
    const cfg = loadConfig(p);
    assert.strictEqual(cfg.dbBackend, "surrealdb");
    assert.strictEqual(cfg.surreal?.endpoint, "http://db:8000");
    assert.strictEqual(cfg.surreal?.namespace, "ns1");
    fs.rmSync(p, { force: true });
  });
  it("rejects unknown dbBackend and falls back to default", () => {
    const p = path.join(os.tmpdir(), `hm-cfg-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({ dbBackend: "mongodb" }));
    const cfg = loadConfig(p);
    assert.strictEqual(cfg.dbBackend, "sqlite");
    fs.rmSync(p, { force: true });
  });
});

describe("shouldRunStartupSync (consolidation child skips the .md→db re-index)", () => {
  // Root cause (wayfinder surrealdb-path repro): every consolidation child is
  // a full extension session, so it re-ran the startup syncMarkdownMemories
  // — ~540 sequential HTTP round-trips on surrealdb (~6.6s × 4 targets) that sqlite
  // does in 15ms. The child only reads .md + writes the result, so the re-index
  // is pure waste. Guard it behind PI_HERMES_CONSOLIDATING (set by runConsolidator).
  it("runs the startup .md→db sync by default (normal sessions)", () => {
    const prev = process.env.PI_HERMES_CONSOLIDATING;
    delete process.env.PI_HERMES_CONSOLIDATING;
    try {
      assert.strictEqual(shouldRunStartupSync(), true);
    } finally {
      if (prev !== undefined) process.env.PI_HERMES_CONSOLIDATING = prev;
    }
  });

  it("skips the startup .md→db sync when PI_HERMES_CONSOLIDATING=1 (consolidation child)", () => {
    const prev = process.env.PI_HERMES_CONSOLIDATING;
    process.env.PI_HERMES_CONSOLIDATING = "1";
    try {
      assert.strictEqual(shouldRunStartupSync(), false);
    } finally {
      if (prev === undefined) delete process.env.PI_HERMES_CONSOLIDATING;
      else process.env.PI_HERMES_CONSOLIDATING = prev;
    }
  });
});

describe("config surreal per-user namespace", () => {
  it("derives user_<user> namespace + memory database when no surreal block exists", () => {
    const p = path.join(os.tmpdir(), `hm-cfg-${Date.now()}.json`);
    const cfg = loadConfig(p);
    assert.ok(cfg.surreal, "loadConfig should populate a surreal block with the default ns+db");
    assert.strictEqual(cfg.surreal!.namespace, derivePerUserNamespace());
    assert.match(cfg.surreal!.namespace, /^user_[a-z0-9_]+$/);
    assert.ok(!cfg.surreal!.namespace.includes("-"), "no hyphens — must be a valid unescaped surrealdb identifier");
    assert.strictEqual(cfg.surreal!.database, "memory");
    fs.rmSync(p, { force: true });
  });

  it("derives per-user namespace + memory database when a surreal block exists but ns/db are unset", () => {
    const p = path.join(os.tmpdir(), `hm-cfg-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({ dbBackend: "surrealdb", surreal: { endpoint: "http://db:8000" } }));
    const cfg = loadConfig(p);
    assert.strictEqual(cfg.surreal?.endpoint, "http://db:8000");
    assert.strictEqual(cfg.surreal?.namespace, derivePerUserNamespace());
    assert.strictEqual(cfg.surreal?.database, "memory");
    fs.rmSync(p, { force: true });
  });

  it("preserves explicit surreal.namespace and surreal.database (explicit wins, not overwritten)", () => {
    const p = path.join(os.tmpdir(), `hm-cfg-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({ dbBackend: "surrealdb", surreal: { namespace: "my_ns", database: "my_db" } }));
    const cfg = loadConfig(p);
    assert.strictEqual(cfg.surreal?.namespace, "my_ns");
    assert.strictEqual(cfg.surreal?.database, "my_db");
    assert.notStrictEqual(cfg.surreal?.namespace, derivePerUserNamespace());
    fs.rmSync(p, { force: true });
  });
});
