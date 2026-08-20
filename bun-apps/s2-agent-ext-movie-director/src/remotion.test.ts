import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderRemotion,
  resolveRemotionBin,
  _resetRemotionBinCacheForTest,
  _BUNDLED_REMOTION_BIN_FOR_TEST,
  type RemotionEditDecisions,
  type SpawnImpl,
  type SpawnResult,
} from "./remotion.ts";

// Drive binary resolution deterministically: point REMOTION_BIN at a real file
// (this test file itself) so resolveRemotionBin returns it verbatim — no PATH
// probing, no bunx. fakeSpawn then matches by argv pattern, not command name.
const FAKE_BIN = import.meta.path;

beforeEach(() => {
  process.env.REMOTION_BIN = FAKE_BIN;
  _resetRemotionBinCacheForTest();
});
afterEach(() => {
  delete process.env.REMOTION_BIN;
  _resetRemotionBinCacheForTest();
});

function fakeSpawn(behavior: { renderExit?: number } = {}): SpawnImpl {
  return async (cmd: string, argv: string[]): Promise<SpawnResult> => {
    if (argv.includes("--version")) return { code: 0, stdout: "remotion 4.0.0", stderr: "" };
    if (argv.includes("render")) {
      const explIdx = argv.indexOf("Explainer");
      const out = argv[explIdx + 1];
      if (behavior.renderExit !== 0 && behavior.renderExit !== undefined) {
        return { code: behavior.renderExit, stdout: "", stderr: "render boom" };
      }
      if (out) writeFileSync(out, "x"); // placeholder so existsSync passes
      return { code: 0, stdout: "rendered", stderr: "" };
    }
    if (cmd === "ffprobe") {
      return {
        code: 0,
        stdout: JSON.stringify({
          format: { duration: "3.0", format_name: "mov,mp4" },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
            { codec_type: "audio", codec_name: "aac" },
          ],
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("resolveRemotionBin", () => {
  it("uses REMOTION_BIN verbatim when the file exists", async () => {
    const bin = await resolveRemotionBin();
    expect(bin).not.toBeNull();
    expect(bin!.cmd).toBe(FAKE_BIN);
    expect(bin!.pre).toEqual([]);
  });

  it("returns null when REMOTION_BIN is set but missing", async () => {
    process.env.REMOTION_BIN = "/does/not/exist/remotion";
    _resetRemotionBinCacheForTest();
    const bin = await resolveRemotionBin();
    expect(bin).toBeNull();
  });

  it("falls back to the bundled local install when REMOTION_BIN/PATH miss", async () => {
    // No env, PATH probe fails → resolution reaches the bundled-install step.
    delete process.env.REMOTION_BIN;
    _resetRemotionBinCacheForTest();
    const failing: SpawnImpl = async (_cmd, argv) =>
      argv.includes("--version") ? { code: 1, stdout: "", stderr: "not on PATH" } : { code: 0, stdout: "", stderr: "" };
    const bin = await resolveRemotionBin(failing);
    // Machine-portable: the bundled install resolves ONLY where `bun install`
    // ran in ../remotion/ (present here, absent on a fresh clone). Either way the
    // resolution must NOT silently pick bunx when a real install exists.
    if (existsSync(_BUNDLED_REMOTION_BIN_FOR_TEST)) {
      expect(bin).not.toBeNull();
      expect(bin!.cmd).toBe(_BUNDLED_REMOTION_BIN_FOR_TEST);
      expect(bin!.pre).toEqual([]);
    } else {
      expect(bin!.cmd).toBe("bunx");
    }
  });
});

describe("renderRemotion (mocked binary)", () => {
  it("writes props JSON, renders, and assembles a render_report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-rmx-"));
    try {
      const src = join(dir, "a.png");
      writeFileSync(src, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 3, animation: "ken-burns" }],
        overlays: [{ type: "section_title", in_seconds: 0, out_seconds: 2, text: "Hello" }],
        transition: "crossfade",
        theme: "dark",
      };
      const out = join(dir, "out.mp4");
      const report = await renderRemotion(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.outputs[0]!.path).toBe(out);
      expect(report.outputs[0]!.duration_seconds).toBe(3.0);
      expect(report.outputs[0]!.resolution).toBe("1920x1080");
      expect(report.outputs[0]!.codec).toBe("h264");
      expect(report.warnings).toEqual([]);
      expect(report.render_grammar).toBe("remotion");

      // Props JSON written with the contract fields.
      const props = JSON.parse(new TextDecoder().decode(readFileSync(join(dir, "remotion-props.json"))));
      expect(props.cuts[0].animation).toBe("ken-burns");
      expect(props.overlays[0].text).toBe("Hello");
      expect(props.transition).toBe("crossfade");
      expect(props.width).toBe(1920);
      expect(props.height).toBe(1080);
      expect(props.fps).toBe(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops missing sources with a warning but renders the survivors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-rmx-miss-"));
    try {
      const real = join(dir, "real.png");
      writeFileSync(real, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "ghost", source: join(dir, "ghost.png"), in_seconds: 0, out_seconds: 1, animation: "zoom-in" },
          { id: "real", source: real, in_seconds: 0, out_seconds: 1, animation: "zoom-in" },
        ],
      };
      const report = await renderRemotion(edit, { workDir: dir }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings.some((w) => w.includes("ghost") && w.includes("missing"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the binary is unresolvable", async () => {
    process.env.REMOTION_BIN = "/nope/remotion";
    _resetRemotionBinCacheForTest();
    const dir = mkdtempSync(join(tmpdir(), "md-rmx-nobin-"));
    try {
      const edit: RemotionEditDecisions = { version: "1.0", cuts: [{ id: "a", source: join(dir, "a.png"), in_seconds: 0, out_seconds: 1 }] };
      const report = await renderRemotion(edit, { workDir: dir }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("remotion binary not found"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a render failure with the stderr tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-rmx-fail-"));
    try {
      const src = join(dir, "a.png");
      writeFileSync(src, "x");
      const edit: RemotionEditDecisions = { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 1 }] };
      const report = await renderRemotion(edit, { workDir: dir, output: join(dir, "out.mp4") }, { spawnImpl: fakeSpawn({ renderExit: 7 }) });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("exit 7"))).toBe(true);
      expect(report.verification_notes.some((n) => n.includes("render boom"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips with an empty report when there are no cuts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-rmx-empty-"));
    try {
      const report = await renderRemotion({ version: "1.0", cuts: [] }, { workDir: dir }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("no cuts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("text cuts need no source file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-rmx-text-"));
    try {
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "t", type: "text", text: "Hi", in_seconds: 0, out_seconds: 2 }],
      };
      const report = await renderRemotion(edit, { workDir: dir, output: join(dir, "out.mp4") }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(existsSync(report.outputs[0]!.path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
