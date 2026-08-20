/**
 * runpy_image.test.ts — unit tests for the run.py IMAGE adapter.
 *
 * Drives runPyImage via the `_spawnImpl` seam (no MLX venv / no model load), the
 * same pattern caption.test.ts uses. Covers: argv construction, the manifest
 * sentinel parse, the success gate (0-exit AND a real image), the no-image
 * 0-exit non-success case, non-zero exit, and the extraArgs allowlist guard.
 */
import { describe, expect, it } from "bun:test";
import {
  buildImageArgs,
  manifestPathFromOutput,
  readImageManifest,
  validateImageExtraArgs,
  runPyImage,
} from "./runpy_image.ts";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildImageArgs", () => {
  it("minimal: image t2i (run.py's default action) + gen-output-dir", () => {
    expect(buildImageArgs({}, "/tmp/out")).toEqual([
      "image", "t2i", "--gen-output-dir", "/tmp/out",
    ]);
  });

  it("controlnet with prompt + input-image + controlnet flags", () => {
    const args = buildImageArgs(
      {
        action: "controlnet",
        prompt: "back view",
        inputImage: "/in/photo.png",
        controlnetType: "pose",
        controlnetStrength: 0.8,
      },
      null,
    );
    expect(args).toEqual([
      "image", "controlnet",
      "--prompt", "back view",
      "--input-image", "/in/photo.png",
      "--controlnet-type", "pose",
      "--controlnet-strength", "0.8",
    ]);
  });

  it("purify forwards --backend when set (closes a silent-drop gap for an explicit backend choice)", () => {
    const args = buildImageArgs(
      { action: "purify", inputImage: "/in/photo.png", purifyMode: "enhance", backend: "transformer" },
      null,
    );
    expect(args).toEqual([
      "image", "purify",
      "--input-image", "/in/photo.png",
      "--purify-mode", "enhance",
      "--backend", "transformer",
    ]);
  });

  it("purify omits --backend when unset (Python's own seedvr2 default, unchanged)", () => {
    const args = buildImageArgs({ action: "purify", inputImage: "/in/photo.png" }, null);
    expect(args).not.toContain("--backend");
  });

  it("faceswap: input + face + mode via subAction-free path", () => {
    const args = buildImageArgs(
      { action: "faceswap", input: "/in/body.png", face: "/in/face.png" },
      null,
    );
    expect(args).toContain("--input");
    expect(args).toContain("/in/body.png");
    expect(args).toContain("--face");
    expect(args).toContain("/in/face.png");
    expect(args[1]).toBe("faceswap");
  });

  it("review carries its secondary positional sub_action", () => {
    const args = buildImageArgs({ action: "review", subAction: "vae" }, null);
    expect(args).toEqual(["image", "review", "vae"]);
  });

  it("inpaint: input + mask + crop map to the masked-redraw flags", () => {
    const args = buildImageArgs(
      { action: "inpaint", input: "/in/photo.png", mask: "/in/mask.png",
        prompt: "clear sky, no object", crop: true },
      null,
    );
    expect(args[1]).toBe("inpaint");
    expect(args).toContain("--input");
    expect(args).toContain("/in/photo.png");
    expect(args).toContain("--mask");
    expect(args).toContain("/in/mask.png");
    expect(args).toContain("--crop");
    expect(args).toContain("--prompt");
  });

  it("cutout: action routes transparent-bg cutout (subject via extraArgs)", () => {
    const args = buildImageArgs(
      { action: "cutout", input: "/in/portrait.png" },
      null,
    );
    expect(args[1]).toBe("cutout");
    expect(args).toContain("--input");
    expect(args).toContain("/in/portrait.png");
    // --subject / --fill-holes / --trim reach run.py through the extraArgs allowlist.
    expect(validateImageExtraArgs(["--subject", "woman", "--fill-holes", "--trim"]))
      .toEqual(["--subject", "woman", "--fill-holes", "--trim"]);
  });

  it("styletransfer: action routes restyle (style-preset/playbook/strength via extraArgs)", () => {
    const args = buildImageArgs(
      { action: "styletransfer", input: "/in/photo.png", prompt: "neon synthwave" },
      null,
    );
    expect(args[1]).toBe("styletransfer");
    expect(args).toContain("--input");
    expect(args).toContain("/in/photo.png");
    expect(args).toContain("--prompt");
    // --style-preset / --playbook / --strength reach run.py via the allowlist.
    expect(validateImageExtraArgs(
      ["--style-preset", "watercolor", "--playbook", "/p/clean-professional.yaml", "--strength", "0.6"],
    )).toEqual(
      ["--style-preset", "watercolor", "--playbook", "/p/clean-professional.yaml", "--strength", "0.6"],
    );
  });

  // "character" moved OFF this run.py adapter (2026-07-13, session 6) onto
  // character_native.ts — see registry.ts's character_native entry and
  // character_native.test.ts for its coverage. It is no longer a valid
  // ImageAction here.

  it("kontext: action routes in-context re-render + its dedicated flags", () => {
    const args = buildImageArgs(
      {
        action: "kontext",
        input: "/in/hero.png",
        prompt: "<same person>, knight in armor",
        guidance: 2.5,
        scheduler: "linear",
        quantize: 8,
        scenes: 3,
        promptSubject: "a woman with red hair",
      },
      null,
    );
    expect(args[1]).toBe("kontext");
    expect(args).toContain("--input");
    expect(args).toContain("/in/hero.png");
    // Every kontext-specific flag is emitted as a kebab token + value.
    expect(args).toContain("--guidance");
    expect(args).toContain("2.5");
    expect(args).toContain("--scheduler");
    expect(args).toContain("--quantize");
    expect(args).toContain("--scenes");
    expect(args).toContain("3");
    expect(args).toContain("--prompt-subject");
    expect(args).toContain("a woman with red hair");
  });

  it("self-test boolean emits bare --self-test; string emits the fixture name", () => {
    expect(buildImageArgs({ selfTest: true }, null)).toContain("--self-test");
    const named = buildImageArgs({ action: "workflow", selfTest: "workflow:portrait" }, null);
    expect(named).toContain("--self-test");
    expect(named).toContain("workflow:portrait");
  });
});

describe("manifestPathFromOutput", () => {
  it("parses the success sentinel `Manifest:   <path>`", () => {
    expect(manifestPathFromOutput("Run config: /x.run.json\nManifest:   /x.manifest.json\n", "")).toBe("/x.manifest.json");
  });

  it("parses the error sentinel on stderr (last match wins)", () => {
    expect(manifestPathFromOutput("", "Manifest (error): /e.manifest.json\n")).toBe("/e.manifest.json");
  });

  it("returns null when no sentinel fired (sub-action without run_session)", () => {
    expect(manifestPathFromOutput("did stuff\n", "more stuff\n")).toBeNull();
  });
});

describe("readImageManifest", () => {
  it("parses status + output_files + transformer model + elapsed", () => {
    const dir = join(tmpdir(), `md-runpy-img-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, "out.manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        status: "success",
        elapsed_seconds: 12.5,
        output_files: [{ path: "/o/out.png", seed: 42, size_bytes: 1024, width: 1024, height: 1024 }],
        models: { transformer: { path: "/mlx-models/transformer/flux2-klein" } },
      }),
    );
    const parsed = readImageManifest(manifestPath)!;
    expect(parsed.status).toBe("success");
    expect(parsed.outputs).toEqual([{ path: "/o/out.png", seed: 42, sizeBytes: 1024, width: 1024, height: 1024 }]);
    expect(parsed.model).toBe("flux2-klein");
    expect(parsed.elapsedSeconds).toBe(12.5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("derives model id from the parent dir when path is .../model.safetensors", () => {
    const dir = join(tmpdir(), `md-runpy-img-mf-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, "out.manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        status: "success",
        output_files: [{ path: "/o.png" }],
        models: { transformer: { path: "/mlx-models/transformer/moody-pro-mix/model.safetensors" } },
      }),
    );
    const parsed = readImageManifest(manifestPath)!;
    expect(parsed.model).toBe("moody-pro-mix");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a missing/unreadable file (never throws)", () => {
    expect(readImageManifest("/no/such/file.json")).toBeNull();
  });
});

describe("validateImageExtraArgs", () => {
  it("accepts allowlisted flags + their values", () => {
    expect(validateImageExtraArgs(["--upscale", "--json-summary"])).toEqual(["--upscale", "--json-summary"]);
  });

  it("rejects a non-allowlisted leading-dash token", () => {
    expect(() => validateImageExtraArgs(["--dangerous-flag"])).toThrow(/not in the allowlist/);
  });
});

describe("runPyImage — spawn injection (no venv / no model load)", () => {
  it("ok=true when run.py exits 0 AND the manifest reports success with a real image", async () => {
    const dir = join(tmpdir(), `md-runpy-img-ok-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // Create the real image so the gate's existsSync check passes.
    const img = join(dir, "out.png");
    writeFileSync(img, "x");
    const manifestPath = join(dir, "out.manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        status: "success",
        elapsed_seconds: 5.0,
        output_files: [{ path: img, seed: 7, size_bytes: 1, width: 512, height: 512 }],
        models: { transformer: { path: "/m/transformer/zimage" } },
      }),
    );

    const out = await runPyImage({
      options: { action: "t2i", prompt: "moody portrait" },
      outputDir: dir,
      _spawnImpl: async () => ({
        stdout: `Manifest:   ${manifestPath}\n`,
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(out.details.ok).toBe(true);
    expect(out.details.exitCode).toBe(0);
    expect(out.details.manifestStatus).toBe("success");
    expect(out.details.outputs[0]!.path).toBe(img);
    expect(out.details.model).toBe("zimage");
    expect(out.summary).toContain("✓");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ok=false when run.py exits 0 but wrote NO image (review/list-only ≠ success)", async () => {
    const out = await runPyImage({
      options: { action: "t2i" },
      _spawnImpl: async () => ({ stdout: "(no manifest sentinel, nothing written)", stderr: "", exitCode: 0 }),
    });
    expect(out.details.ok).toBe(false);
    expect(out.details.exitOk).toBe(true);
    expect(out.details.imageExists).toBe(false);
  });

  it("ok=false on non-zero exit (manifest error status surfaces in summary)", async () => {
    const dir = join(tmpdir(), `md-runpy-img-err-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, "err.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ status: "error", output_files: null, error: { message: "boom: model missing" } }));

    const out = await runPyImage({
      options: { action: "controlnet" },
      _spawnImpl: async () => ({ stdout: "", stderr: `boom: model missing\nManifest (error): ${manifestPath}`, exitCode: 2 }),
    });
    expect(out.details.ok).toBe(false);
    expect(out.details.exitCode).toBe(2);
    expect(out.details.manifestStatus).toBe("error");
    expect(out.stderrTail).toContain("boom");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to globbing the newest image when no manifest sentinel fired", async () => {
    const dir = join(tmpdir(), `md-runpy-img-glob-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const img = join(dir, "output_123.png");
    writeFileSync(img, "x");

    const out = await runPyImage({
      options: { action: "faceswap", input: "/in/body.png", face: "/in/face.png" },
      outputDir: dir,
      _spawnImpl: async () => ({ stdout: "did stuff (no manifest)", stderr: "", exitCode: 0 }),
    });
    expect(out.details.ok).toBe(true);
    expect(out.details.outputs[0]!.path).toBe(img);
    expect(existsSync(out.details.outputs[0]!.path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("glob fallback is RECURSIVE — finds images in a subfolder (profile/workflow output shape)", async () => {
    const dir = join(tmpdir(), `md-runpy-img-sub-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    // run.py profile writes to output/profile_<stamp>/ — a subfolder, no manifest.
    const sub = join(dir, "profile_20260708_120000");
    mkdirSync(sub, { recursive: true });
    const view = join(sub, "front.png");
    writeFileSync(view, "x");

    const out = await runPyImage({
      options: { action: "profile", input: "/in/hero.png" },
      outputDir: dir,
      _spawnImpl: async () => ({ stdout: "profile done (no manifest sentinel)", stderr: "", exitCode: 0 }),
    });
    expect(out.details.ok).toBe(true);
    expect(out.details.outputs[0]!.path).toBe(view);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ok=false + graceful summary when the spawn itself throws", async () => {
    const out = await runPyImage({
      options: { action: "t2i" },
      _spawnImpl: async () => { throw new Error("ENOENT: python"); },
    });
    expect(out.details.ok).toBe(false);
    expect(out.summary).toContain("image spawn failed");
  });
});
