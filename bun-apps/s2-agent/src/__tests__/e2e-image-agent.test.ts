/**
 * e2e-image-agent — REAL-MODEL integration e2e for the image agent.
 *
 * This is the layer above the offline probe (e2e-extensions) and the L2 judgment
 * workflow (run-ext-e2e.sh). It does what those structurally cannot: spawn the
 * ACTUAL s2-agent launcher with a real model + a natural-language prompt and
 * verify the flux2 tool is driven end-to-end — reply language, tool invocation,
 * and a real PNG landing at the requested timestamped path.
 *
 * It mirrors the operator's manual invocation:
 *   ./s2-agent.sh --model <model> -p "verify I can use Flux tool, reply in zh-TW,
 *      generate <subject> to ./output/flux-output/<name>-<timestamp>.png and open it"
 *
 * WHY A DEDICATED GATE (PI_AGENT_E2E_IMAGE=1)
 *   This spends LLM tokens and minutes (loads a 9B model per generation). It is
 *   deliberately NOT part of PI_AGENT_E2E / run-test.ts / CI. Opt in via
 *   `bash bun-apps/s2-agent/scripts/run-image-agent-e2e.sh`. A flaky model reply
 *   must never fail a build.
 *
 * DEFAULT SUBJECT IS NEUTRAL
 *   The canonical example used a person as the subject; the committed default here
 *   uses a Japanese garden so the test artifact has no borderline content. The
 *   MECHANICS under test are identical (path pattern, timestamp, zh-TW, open).
 *   Override with any subject via PI_AGENT_E2E_PROMPT.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect } from "bun:test";
import { PI_AGENT_DIR, REPO_ROOT } from "./e2e-harness.ts";

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

/** Fires only when the operator explicitly opts in. */
export const IMAGE_E2E_ENABLED = truthy(process.env.PI_AGENT_E2E_IMAGE);

/**
 * Model id. DEFAULT (since 2026-08-24): deepseek/deepseek-v4-flash-vision-exp —
 * the CI/E2E lane per the "LM Studio out of CI" operator directive (local gemma
 * stays the interactive brain; this is a test lane, and the full provider/model
 * id is immune to a user-level defaultProvider hijack). Needs DEEPSEEK_API_KEY.
 * Any model the operator has authenticated works via PI_AGENT_E2E_MODEL.
 */
const MODEL = process.env.PI_AGENT_E2E_MODEL || "deepseek/deepseek-v4-flash-vision-exp";

/** Overridable prompt; default keeps the example's mechanics with a neutral subject. */
const PROMPT =
  process.env.PI_AGENT_E2E_PROMPT ||
  "verify I can use the Flux tool, reply to me in zh-TW, please generate an image of <a beautiful Japanese garden with cherry blossoms in spring> to ./output/flux-output/<name-of-image>-<timestamp>.png and open it for me";

// flux2 resolves `./output/flux-output/` against repoRoot (an allowed root), so
// the PNG lands here regardless of the launcher's cwd.
const OUT_DIR = join(REPO_ROOT, "output", "flux-output");
const FLUX2_BIN = join(REPO_ROOT, "swift", "flux2-image-director", ".build", "release", "flux2");
const METALIB = join(REPO_ROOT, "swift", "flux2-image-director", ".build", "release", "mlx.metallib");

const BINARY_READY = existsSync(FLUX2_BIN) && existsSync(METALIB);

// Generation (~1-3 min) + model load + reasoning headroom. The test timeout
// sits above this so a healthy run never hits the wall.
const RUN_TIMEOUT_MS = Number(process.env.PI_AGENT_E2E_TIMEOUT_MS || 600_000);
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 120_000;

// A timestamp-ish filename token: a dash followed by ≥6 digits (the example used
// <name>-20260704_090139.png). Permissive enough to accept _ or - separators.
const TIMESTAMP_NAME = /-\d{6,}([_-]\d{6,})*\.png$/i;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Spawn the launcher exactly as the operator does, capture output, kill on timeout. */
async function runLauncher(prompt: string, timeoutMs: number): Promise<RunResult> {
  const launcher = join(REPO_ROOT, "s2-agent.sh");
  const proc = Bun.spawn(["bash", launcher, "--model", MODEL, "-p", prompt], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.stderr.write(`\n[e2e-image-agent] timeout (${timeoutMs}ms) killing s2-agent.sh\n`);
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** PNGs in OUT_DIR that are newer than `sinceMs` and match the timestamp name shape. */
function newTimestampedPngs(sinceMs: number): string[] {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".png") && TIMESTAMP_NAME.test(f))
    .map((f) => join(OUT_DIR, f))
    .filter((p) => {
      try {
        return statSync(p).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    });
}

describe.skipIf(!IMAGE_E2E_ENABLED)("e2e: image agent — real model drives flux2 tool", () => {
  test.skipIf(!BINARY_READY)(
    "generates a timestamped PNG and replies in zh-TW",
    async () => {
      // 2s grace so mtime floor doesn't false-negative on clock skew.
      const startMs = Date.now() - 2000;
      const before = new Set(newTimestampedPngs(0));

      const res = await runLauncher(PROMPT, RUN_TIMEOUT_MS);

      const combined = (res.stdout + "\n" + res.stderr).replace(/\x1b\[[0-9;]*m/g, "");

      // Diagnostics first: if the launcher failed or timed out, surface why
      // instead of letting the downstream assertions fail opaquely.
      if (res.timedOut) {
        throw new Error(`s2-agent.sh timed out after ${RUN_TIMEOUT_MS}ms.\n--- tail ---\n${combined.slice(-800)}`);
      }
      if (res.code !== 0) {
        throw new Error(`s2-agent.sh exited ${res.code}.\n--- stdout tail ---\n${res.stdout.slice(-800)}\n--- stderr tail ---\n${res.stderr.slice(-800)}`);
      }

      // 1. Reply is in zh-TW (contains Han characters). The model is instructed
      //    to reply in zh-TW; a CJK-free reply means it ignored the instruction
      //    or the prompt never reached the model.
      expect(combined, "reply must contain zh-TW (Han) text").toMatch(/[一-鿿]/);

      // 2. A NEW timestamped PNG exists, non-zero size. This is the core contract:
      //    the flux2 tool was actually invoked and wrote a real file at the
      //    requested <name>-<timestamp>.png path pattern.
      const after = newTimestampedPngs(startMs).filter((p) => !before.has(p));
      expect(after.length, `expected a new timestamped PNG under ${OUT_DIR}; got ${after.length}`).toBeGreaterThan(0);
      const png = after[0] as string;
      const size = statSync(png).size;
      expect(size, `PNG is empty (0 bytes): ${png}`).toBeGreaterThan(0);

      // 3. SOFT: the agent should have attempted to open the file. Not hard-
      //    asserted — `open` varies by host and isn't the contract under test —
      //    but its absence is surfaced as a warning so a silent regression
      //    (agent stops honoring "open it") is visible.
      const mentionedOpen = /開啟|打開|\bopen\b/i.test(combined);
      if (!mentionedOpen) {
        console.warn(`[e2e-image-agent] soft: reply did not mention opening the file (${png})`);
      }

      console.log(`[e2e-image-agent] ✓ PNG: ${png} (${size} bytes); model=${MODEL}`);
    },
    TEST_TIMEOUT_MS,
  );

  // When the gate is on but the binary isn't built, say so — don't fail opaquely.
  test.skipIf(BINARY_READY)(
    "flux2 binary/metallib missing — build it before this tier can run",
    () => {
      console.warn(
        `[e2e-image-agent] SKIP: missing ${FLUX2_BIN} or ${METALIB}.\n` +
          `Build: ( cd swift/flux2-image-director && swift build -c release ) && bash swift/flux2-image-director/scripts/build-metallib.sh`,
      );
      expect(true).toBe(true);
    },
  );
});

// Always-on no-op when the gate is off, so `bun test` reports the skip reason
// instead of looking like the file doesn't exist.
describe.skipIf(IMAGE_E2E_ENABLED)("e2e: image agent (set PI_AGENT_E2E_IMAGE=1 to enable)", () => {
  test("opt-in only — never runs in CI / run-test.ts", () => {
    expect(IMAGE_E2E_ENABLED).toBe(false);
  });
});

// Keep the import meaningful for tooling that walks the package tree.
void PI_AGENT_DIR;
