import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, shouldRunStartupSync } from "../src/config.js";
import { AGENT_ROOT, __setAgentRootForTest } from "../src/paths.js";
import { derivePerUserNamespace } from "../src/store/surreal/per-user-db.js";

const TEST_CONFIG_PATH = path.join(os.tmpdir(), `hermes-memory-config-test-${process.pid}.json`);

// loadConfig reads PI_HERMES_CONSOLIDATING (=1 forces vault-offload for the
// consolidation child). The characterization tests below assume it is UNSET,
// but the agent harness exports it when running tests inside a live session,
// silently flipping defaults to vault-offload and breaking them. Snapshot +
// delete it before each test so this file is hermetic to that external env.
const CONSOLIDATING_ENV = "PI_HERMES_CONSOLIDATING";
let savedConsolidatingEnv: string | undefined;

beforeEach(() => {
  savedConsolidatingEnv = process.env[CONSOLIDATING_ENV];
  delete process.env[CONSOLIDATING_ENV];
});

afterEach(() => {
  if (savedConsolidatingEnv === undefined) delete process.env[CONSOLIDATING_ENV];
  else process.env[CONSOLIDATING_ENV] = savedConsolidatingEnv;
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
      failureCharLimit: 50000,
      lockAcquireRetries: 50,
      lockOpRetries: 7,
      lockOpBackoffMs: 1500,
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
    // Previously silently-dropped fields (ticket 03 / config-parity guard):
    // a config-file value must now actually propagate, not fall through to the
    // consumer's `config.X ?? envOrDefault()` fallback.
    assert.strictEqual(config.failureCharLimit, 50000);
    assert.strictEqual(config.lockAcquireRetries, 50);
    assert.strictEqual(config.lockOpRetries, 7);
    assert.strictEqual(config.lockOpBackoffMs, 1500);
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

  it("carries errorCapture throttle fields through from the config file", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      errorCaptureRateLimit: 2,
      errorCaptureRateWindowMs: 30_000,
      errorCaptureDedupCacheSize: 10,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.errorCaptureRateLimit, 2);
    assert.strictEqual(config.errorCaptureRateWindowMs, 30_000);
    assert.strictEqual(config.errorCaptureDedupCacheSize, 10);
  });

  it("leaves errorCapture throttle fields undefined when unset (env/default applies at use-site)", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.errorCaptureRateLimit, undefined);
    assert.strictEqual(config.errorCaptureRateWindowMs, undefined);
    assert.strictEqual(config.errorCaptureDedupCacheSize, undefined);
  });

  it("ignores invalid errorCapture throttle values (negative / non-number)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      errorCaptureRateLimit: -1,
      errorCaptureRateWindowMs: "fast",
      errorCaptureDedupCacheSize: true,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.errorCaptureRateLimit, undefined);
    assert.strictEqual(config.errorCaptureRateWindowMs, undefined);
    assert.strictEqual(config.errorCaptureDedupCacheSize, undefined);
  });

  it("carries usedDetection + usedSignatureMinChars through from the config file", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      usedDetection: false,
      usedSignatureMinChars: 40,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.usedDetection, false);
    assert.strictEqual(config.usedSignatureMinChars, 40);
  });

  it("defaults usedDetection to true and usedSignatureMinChars to DEFAULT_USED_SIGNATURE_MIN_CHARS (24) when unset", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.usedDetection, true);
    assert.strictEqual(config.usedSignatureMinChars, 24);
  });

  it("ignores invalid usedDetection / usedSignatureMinChars values (non-boolean / negative)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      usedDetection: "off",
      usedSignatureMinChars: -5,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.usedDetection, true);
    assert.strictEqual(config.usedSignatureMinChars, 24);
  });

  // ─── Decay (ticket #1b / UPSP §1) — the full config surface, the #06
  // config-gap lesson baked in: a config-file value MUST reach the consumer
  // object; missing/invalid falls back to the DEFAULT_CONFIG defaults. ───
  it("carries all four decay fields through from the config file", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      decayEnabled: false,
      decayHalflifeDays: 30,
      decayWorthWeight: 0.2,
      decayUsedBonus: 0.05,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.decayEnabled, false);
    assert.strictEqual(config.decayHalflifeDays, 30);
    assert.strictEqual(config.decayWorthWeight, 0.2);
    assert.strictEqual(config.decayUsedBonus, 0.05);
  });

  it("defaults decay fields to true / 14 / 0.15 / 0.1 when unset", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.decayEnabled, true);
    assert.strictEqual(config.decayHalflifeDays, 14);
    assert.strictEqual(config.decayWorthWeight, 0.15);
    assert.strictEqual(config.decayUsedBonus, 0.1);
  });

  it("ignores invalid decay values (non-boolean / negative) and falls back to defaults", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      decayEnabled: "off",
      decayHalflifeDays: -1,
      decayWorthWeight: -0.5,
      decayUsedBonus: "high",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.decayEnabled, true);
    assert.strictEqual(config.decayHalflifeDays, 14);
    assert.strictEqual(config.decayWorthWeight, 0.15);
    assert.strictEqual(config.decayUsedBonus, 0.1);
  });

  it("rejects decayHalflifeDays: 0 (would yield NaN heat) → default 14", () => {
    // halflife 0 ⇒ exp(-age/0) = NaN ⇒ clamp(NaN) = NaN, corrupting the D5
    // deterministic heat ordering. The > 0 guard rejects it → default.
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ decayHalflifeDays: 0 }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.decayHalflifeDays, 14);
  });

  // ─── Proactive consolidation (Task 1 / UPSP §1) — the full config surface,
  // the #06 config-gap lesson baked in: a config-file value MUST reach the
  // consumer object; missing/invalid falls back to the DEFAULT_CONFIG defaults.
  // Mirrors the decay* tests directly above (same loadConfig(temp-file) fixture).
  it("defaults the five proactive knobs to the spec values when unset", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.proactiveConsolidateEnabled, false);
    assert.strictEqual(config.proactiveHeatFloor, 0.25);
    assert.strictEqual(config.proactiveMaxCandidates, 20);
    assert.strictEqual(config.proactivePressureThreshold, 10);
    assert.strictEqual(config.proactiveCooldownMinutes, 30);
  });

  it("carries all five proactive knobs through from the config file (allowlisted)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      proactiveConsolidateEnabled: true,
      proactiveHeatFloor: 0.5,
      proactiveMaxCandidates: 5,
      proactivePressureThreshold: 3,
      proactiveCooldownMinutes: 10,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.proactiveConsolidateEnabled, true);
    assert.strictEqual(config.proactiveHeatFloor, 0.5);
    assert.strictEqual(config.proactiveMaxCandidates, 5);
    assert.strictEqual(config.proactivePressureThreshold, 3);
    assert.strictEqual(config.proactiveCooldownMinutes, 10);
  });

  it("ignores invalid proactive knob values and falls back to defaults (parse-allowlist guards)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      proactiveConsolidateEnabled: "yes",
      proactiveHeatFloor: "high",
      proactiveMaxCandidates: -1,
      proactivePressureThreshold: "x",
      proactiveCooldownMinutes: null,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.proactiveConsolidateEnabled, false);
    assert.strictEqual(config.proactiveHeatFloor, 0.25);
    assert.strictEqual(config.proactiveMaxCandidates, 20);
    assert.strictEqual(config.proactivePressureThreshold, 10);
    assert.strictEqual(config.proactiveCooldownMinutes, 30);
  });

  // ─── survivingK (ticket 19 T3) — caps the post-dedup returned list. Mirrors
  // vectorTopK's `typeof === "number" && Number.isFinite && > 0 → Math.floor`
  // parse-allowlist guard. The #06 config-gap lesson: registered in
  // DEFAULT_CONFIG AND the parse allowlist from day one. Default 10.
  it("defaults survivingK to DEFAULT_SURVIVING_K (10) when unset", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.survivingK, 10);
  });

  it("carries survivingK through from the config file (allowlisted, floors to int)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ survivingK: 3.9 }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.survivingK, 3); // >0 floor + Math.floor
  });

  it("ignores invalid survivingK values (≤0 / non-number / null) → default kept", () => {
    // NaN/Infinity are structurally unrepresentable in JSON (JSON.parse yields
    // null / throws), so the representative invalid set here is the JSON-
    // representable one; the same `typeof===number && isFinite && >0` guard
    // defends the in-memory path against NaN/Infinity too.
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    for (const invalid of [-1, 0, "x", true, null]) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ survivingK: invalid }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.survivingK, 10, `invalid ${JSON.stringify(invalid)} keeps default`);
    }
  });

  // ─── boostWeight (ticket 20 T2) — multi-signal frequency-vote dominance
  // weight (PINNED formula: final = (signalCount - 1) * boostWeight +
  // bestRankScore). Mirrors survivingK's 4-point pattern but WITHOUT the
  // Math.floor — it is a continuous weight, not a count. The #06 config-gap
  // lesson: registered in DEFAULT_CONFIG AND the parse allowlist from day
  // one. Default 1.0 (DEFAULT_BOOST_WEIGHT).
  it("defaults boostWeight to DEFAULT_BOOST_WEIGHT (1.0) when unset", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.boostWeight, 1.0);
  });

  it("carries boostWeight through from the config file (allowlisted, no floor)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ boostWeight: 2.5 }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.boostWeight, 2.5); // continuous weight, not floored
  });

  it("ignores invalid boostWeight values (≤0 / non-number / null) → default kept", () => {
    // NaN/Infinity are structurally unrepresentable in JSON (see survivingK's
    // note above); the `typeof===number && isFinite && >0` guard defends the
    // in-memory path against them too.
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    for (const invalid of [-1, 0, "x", true, null]) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ boostWeight: invalid }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.boostWeight, 1.0, `invalid ${JSON.stringify(invalid)} keeps default`);
    }
  });

});

describe("config dbBackend", () => {
  it("defaults to surrealdb when unset (ticket 05; sqlite stays a transparent fallback)", () => {
    const cfg = loadConfig(path.join(os.tmpdir(), `hm-cfg-${Date.now()}.json`));
    assert.strictEqual(cfg.dbBackend, "surrealdb");
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
    assert.strictEqual(cfg.dbBackend, "surrealdb");
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

describe("loadConfig agent-root isolation", () => {
  it("loadConfig() with no path reads the test-overridden agent root, not the real ~/.pi/agent", () => {
    // Regression: DEFAULT_CONFIG_PATH was computed at module load from the
    // real AGENT_ROOT and frozen as the loadConfig() default param, so it
    // ignored __setAgentRootForTest and read the real hermes-memory-config.json
    // (e.g. dbBackend: surrealdb) — breaking test isolation.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cfg-root-"));
    const sentinel = 4242;
    fs.writeFileSync(
      path.join(tmp, "hermes-memory-config.json"),
      JSON.stringify({ memoryCharLimit: sentinel }),
    );
    __setAgentRootForTest(tmp);
    try {
      const config = loadConfig(); // no explicit path → must use the live agent root
      assert.strictEqual(
        config.memoryCharLimit,
        sentinel,
        "loadConfig() must read the overridden agent root's config, not the frozen module-load path",
      );
    } finally {
      __setAgentRootForTest(null);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Repo-local project-memory overlay (ticket 01, decision 01) ──────────────
// A repo opts into autocommit by dropping {"autoCommitProjectMemory": true} at
// <cwd>/.agents/memory/config.json. The overlay is NARROW: only project-memory
// keys (autoCommitProjectMemory, projectMemoryDir) may ride it — dbBackend /
// surreal.* / llm* are ignored so a repo can never silently repoint its DB.
// Discovered via the same cwd-relative resolver as the MEMORY.md SoT.

describe("loadConfig repo-local project-memory overlay (ticket 01)", () => {
  it("defaults autoCommitProjectMemory to false when no overlay exists", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.autoCommitProjectMemory, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies autoCommitProjectMemory from <cwd>/.agents/memory/config.json", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ autoCommitProjectMemory: true }));
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.autoCommitProjectMemory, true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies projectName from <cwd>/.agents/memory/config.json (ticket 09 — cross-worktree tag coherence)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ projectName: "video_generation" }));
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.projectName, "video_generation", "projectName rides the repo-local overlay");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("overlay is NARROW: ignores dbBackend / surreal / llm keys (no per-repo DB repointing)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      autoCommitProjectMemory: true,
      dbBackend: "surrealdb",
      surreal: { endpoint: "http://evil:8000", namespace: "pwn", database: "pwn" },
      llmModelOverride: "stolen/model",
    }));
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.autoCommitProjectMemory, true, "project-memory key applied");
      assert.strictEqual(config.dbBackend, "surrealdb", "dbBackend NOT overridden by repo-local overlay (stays surrealdb default)");
      assert.ok(!config.surreal || config.surreal.endpoint !== "http://evil:8000", "surreal NOT overridden by overlay");
      assert.strictEqual(config.llmModelOverride, undefined, "llm override NOT applied from overlay");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("overlay projectMemoryDir:null is honored (global opt-out)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ projectMemoryDir: null }));
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.projectMemoryDir, null);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("malformed overlay JSON is a silent no-op (falls back to defaults)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.autoCommitProjectMemory, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ignores non-boolean autoCommitProjectMemory values", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ autoCommitProjectMemory: "yes" }));
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.autoCommitProjectMemory, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does NOT read the overlay when projectMemoryDir===null in the global config", () => {
    // Global config opts out of in-repo project memory → memory lives in the
    // global store; there is no in-repo config.json to consult, so even if one
    // is present it must be ignored.
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ projectMemoryDir: null }));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ autoCommitProjectMemory: true }));
    try {
      const config = loadConfig(TEST_CONFIG_PATH, cwd);
      assert.strictEqual(config.projectMemoryDir, null);
      assert.strictEqual(config.autoCommitProjectMemory, false, "overlay must NOT be read when projectMemoryDir is null globally");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loadConfig() with no cwd reads the overlay from process.cwd()", () => {
    // Mirrors the agent-root isolation test: the no-cwd default must honor the
    // live cwd, not a frozen module-load path. We point process.cwd() at a
    // tmpdir via a sentinel overlay and assert it propagates.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-overlay-"));
    const dir = path.join(cwd, ".agents", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ autoCommitProjectMemory: true }));
    const origCwd = process.cwd();
    try {
      process.chdir(cwd);
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.autoCommitProjectMemory, true, "loadConfig() must read the overlay from process.cwd()");
    } finally {
      process.chdir(origCwd);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

it("failureModel: default legacy, reads v1, ignores invalid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-fm-"));
  const cfgPath = path.join(dir, "hermes-memory-config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({}));
  assert.strictEqual(loadConfig(cfgPath).failureModel, "legacy");
  fs.writeFileSync(cfgPath, JSON.stringify({ failureModel: "v1" }));
  assert.strictEqual(loadConfig(cfgPath).failureModel, "v1");
  fs.writeFileSync(cfgPath, JSON.stringify({ failureModel: "bogus" }));
  assert.strictEqual(loadConfig(cfgPath).failureModel, "legacy");
});
