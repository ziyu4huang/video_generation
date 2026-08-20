import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSkillsDir, superpowersExtension } from "../src/superpowers.js";

/**
 * Compiled-binary ($bunfs) mode behavior. In a `bun build --compile` binary,
 * import.meta.url is a $bunfs virtual path — resolving `../skills` from it
 * yields `/$bunfs/skills`, which does not exist on the real filesystem. The
 * real skills are extracted by s2-agent's extract-embedded-assets patch to
 * $BUN_PI_EMBEDDED_EXTRACT_DIR/s2-agent-ext-superpowers/skills and passed to
 * pi via `--skill`. resolveSkillsDir must follow that extraction dir, and
 * resources_discover must never advertise a non-existent path.
 */

const BUNFS_URL = "file:///$bunfs/root/s2-agent";
const ENV_KEY = "BUN_PI_EMBEDDED_EXTRACT_DIR";

let savedEnv: string | undefined;
let extractDir: string;
let savedDefaults: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  // Suppress the Phase-3 default exclude so binary-mode tests assert pure dir
  // resolution (the whole extraction skills/ dir), decoupled from exclude policy.
  savedDefaults = process.env["PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS"];
  process.env["PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS"] = "0";
  extractDir = mkdtempSync(join(tmpdir(), "sp-extract-"));
  mkdirSync(join(extractDir, "s2-agent-ext-superpowers", "skills"), { recursive: true });
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (savedDefaults === undefined) delete process.env["PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS"];
  else process.env["PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS"] = savedDefaults;
  rmSync(extractDir, { recursive: true, force: true });
});

function captureResourcesDiscover(fromUrl: string): () => Promise<{ skillPaths: string[] }> {
  let handler: (() => Promise<{ skillPaths: string[] }>) | undefined;
  const pi = {
    on(event: string, fn: unknown) {
      if (event === "resources_discover") handler = fn as typeof handler;
    },
  } as unknown as ExtensionAPI;
  superpowersExtension(pi, fromUrl);
  if (!handler) throw new Error("resources_discover handler not registered");
  return handler;
}

describe("resolveSkillsDir in compiled-binary mode", () => {
  it("resolves to the embedded-assets extraction dir when the env var is set", () => {
    process.env[ENV_KEY] = extractDir;
    expect(resolveSkillsDir(BUNFS_URL)).toBe(join(extractDir, "s2-agent-ext-superpowers", "skills"));
  });

  it("still resolves source-mode URLs relative to the module (env var ignored)", () => {
    process.env[ENV_KEY] = extractDir;
    const srcUrl = new URL("../src/superpowers.ts", import.meta.url).href;
    expect(resolveSkillsDir(srcUrl)).toBe(join(import.meta.dir, "..", "skills"));
  });
});

describe("resources_discover in compiled-binary mode", () => {
  it("advertises no skillPaths when the resolved dir does not exist", async () => {
    delete process.env[ENV_KEY];
    const discover = captureResourcesDiscover(BUNFS_URL);
    expect((await discover()).skillPaths).toEqual([]);
  });

  it("advertises the extraction dir when it exists", async () => {
    process.env[ENV_KEY] = extractDir;
    const discover = captureResourcesDiscover(BUNFS_URL);
    expect((await discover()).skillPaths).toEqual([join(extractDir, "s2-agent-ext-superpowers", "skills")]);
  });
});
