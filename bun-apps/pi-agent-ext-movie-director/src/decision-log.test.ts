import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDecision, getDecisionLog } from "./decision-log.ts";

let env: Record<string, string | undefined>;
beforeEach(() => {
  env = { MLX_OUTPUT_DIR: mkdtempSync(join(tmpdir(), "md-decision-log-")) };
});

describe("decision log", () => {
  test("records a real substitution (resolved !== used)", () => {
    recordDecision("p1", "provider", "tts", "say", "edge-tts", "generate:tts:speak", env);
    const log = getDecisionLog("p1", env);
    expect(log.entries.length).toBe(1);
    expect(log.entries[0]!.category).toBe("provider");
    expect(log.entries[0]!.subject).toBe("tts");
    expect(log.entries[0]!.resolved).toBe("say");
    expect(log.entries[0]!.used).toBe("edge-tts");
    expect(log.entries[0]!.reason).toBe("generate:tts:speak");
    expect(typeof log.entries[0]!.recorded_at).toBe("string");
  });

  test("is a no-op when resolved === used (the common case)", () => {
    recordDecision("p1", "provider", "image_generation", "krea2", "krea2", undefined, env);
    expect(getDecisionLog("p1", env).entries.length).toBe(0);
  });

  test("is append-only across multiple calls", () => {
    recordDecision("p1", "provider", "tts", "say", "edge-tts", undefined, env);
    recordDecision("p1", "provider", "tts", "say", "edge-tts", undefined, env);
    expect(getDecisionLog("p1", env).entries.length).toBe(2);
  });

  test("empty log for an unknown project", () => {
    expect(getDecisionLog("nonexistent", env).entries).toEqual([]);
  });
});
