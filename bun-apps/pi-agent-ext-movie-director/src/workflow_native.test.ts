import { describe, expect, it } from "bun:test";
import {
  runWorkflowNative,
  type BaseGenFn,
  type FaceDetailFn,
  type UpscaleFn,
} from "./workflow_native.ts";

const fakeBase: BaseGenFn = async (opts) => ({
  path: opts.input ? "/out/i2i.png" : "/out/t2i.png",
  seed: 42,
  width: 640,
  height: 960,
});

describe("runWorkflowNative — the portable subset (base gen [+ ESRGAN upscale])", () => {
  it("throws when neither prompt nor input is given (mirrors Python's ValueError)", async () => {
    await expect(runWorkflowNative({})).rejects.toThrow(/no prompt/i);
  });

  it("runs T2I when no input image is given", async () => {
    const seen: { command: "t2i" | "i2i" | null } = { command: null };
    const runBase: BaseGenFn = async (opts) => {
      seen.command = opts.input ? "i2i" : "t2i";
      return fakeBase(opts);
    };
    const result = await runWorkflowNative({ prompt: "a portrait", _runBase: runBase });

    expect(seen.command).toBe("t2i");
    expect(result.stages).toEqual(["base"]);
    expect(result.finalImage).toBe("/out/t2i.png");
    expect(result.baseImage).toBe("/out/t2i.png");
    expect(result.upscaledImage).toBeNull();
    expect(result.seed).toBe(42);
  });

  it("runs I2I when an input image is given", async () => {
    const seen: { command: "t2i" | "i2i" | null } = { command: null };
    const runBase: BaseGenFn = async (opts) => {
      seen.command = opts.input ? "i2i" : "t2i";
      return fakeBase(opts);
    };
    const result = await runWorkflowNative({ prompt: "refine this", input: "/src.png", _runBase: runBase });

    expect(seen.command).toBe("i2i");
    expect(result.finalImage).toBe("/out/i2i.png");
  });

  it("chains ESRGAN upscale onto the base image when requested", async () => {
    const upscaleCalls: string[] = [];
    const runUpscale: UpscaleFn = async (input) => {
      upscaleCalls.push(input);
      return { path: "/out/t2i_upscaled.png", width: 2560, height: 3840 };
    };

    const result = await runWorkflowNative({
      prompt: "a portrait",
      upscale: true,
      _runBase: fakeBase,
      _runUpscale: runUpscale,
    });

    expect(upscaleCalls).toEqual(["/out/t2i.png"]);
    expect(result.stages).toEqual(["base", "upscale"]);
    expect(result.finalImage).toBe("/out/t2i_upscaled.png");
    expect(result.baseImage).toBe("/out/t2i.png");
    expect(result.upscaledImage).toBe("/out/t2i_upscaled.png");
    expect(result.width).toBe(2560);
    expect(result.height).toBe(3840);
  });

  it("chains face-detail onto the base image when requested", async () => {
    const faceDetailCalls: string[] = [];
    const runFaceDetail: FaceDetailFn = async (input) => {
      faceDetailCalls.push(input);
      return { path: "/out/t2i_facedetail.png", width: 640, height: 960 };
    };

    const result = await runWorkflowNative({
      prompt: "a portrait",
      faceDetail: true,
      _runBase: fakeBase,
      _runFaceDetail: runFaceDetail,
    });

    expect(faceDetailCalls).toEqual(["/out/t2i.png"]);
    expect(result.stages).toEqual(["base", "face_detail"]);
    expect(result.finalImage).toBe("/out/t2i_facedetail.png");
    expect(result.faceDetailImage).toBe("/out/t2i_facedetail.png");
  });

  it("chains upscale onto the face-detail output, not the base image, when both are requested", async () => {
    const upscaleCalls: string[] = [];
    const runFaceDetail: FaceDetailFn = async () => ({ path: "/out/t2i_facedetail.png", width: 640, height: 960 });
    const runUpscale: UpscaleFn = async (input) => {
      upscaleCalls.push(input);
      return { path: "/out/t2i_facedetail_upscaled.png", width: 2560, height: 3840 };
    };

    const result = await runWorkflowNative({
      prompt: "a portrait",
      faceDetail: true,
      upscale: true,
      _runBase: fakeBase,
      _runFaceDetail: runFaceDetail,
      _runUpscale: runUpscale,
    });

    expect(upscaleCalls).toEqual(["/out/t2i_facedetail.png"]);
    expect(result.stages).toEqual(["base", "face_detail", "upscale"]);
    expect(result.finalImage).toBe("/out/t2i_facedetail_upscaled.png");
  });

  it("does not call face-detail when faceDetail is false/unset", async () => {
    let called = false;
    const runFaceDetail: FaceDetailFn = async () => {
      called = true;
      return { path: "/never.png", width: null, height: null };
    };
    const result = await runWorkflowNative({ prompt: "x", _runBase: fakeBase, _runFaceDetail: runFaceDetail });
    expect(called).toBe(false);
    expect(result.stages).toEqual(["base"]);
  });

  it("propagates a face-detail failure (no partial-success mode)", async () => {
    const runFaceDetail: FaceDetailFn = async () => {
      throw new Error("workflow: face-detail failed: boom");
    };
    await expect(
      runWorkflowNative({ prompt: "x", faceDetail: true, _runBase: fakeBase, _runFaceDetail: runFaceDetail }),
    ).rejects.toThrow(/boom/);
  });

  it("does not call upscale when upscale is false/unset", async () => {
    let upscaleCalled = false;
    const runUpscale: UpscaleFn = async () => {
      upscaleCalled = true;
      return { path: "/never.png", width: null, height: null };
    };

    const result = await runWorkflowNative({ prompt: "x", _runBase: fakeBase, _runUpscale: runUpscale });

    expect(upscaleCalled).toBe(false);
    expect(result.stages).toEqual(["base"]);
  });

  it("propagates a base-gen failure (no partial-success mode)", async () => {
    const runBase: BaseGenFn = async () => {
      throw new Error("workflow: base generation (t2i) failed: boom");
    };
    await expect(
      runWorkflowNative({ prompt: "x", _runBase: runBase }),
    ).rejects.toThrow(/boom/);
  });

  it("propagates an upscale failure (no partial-success mode)", async () => {
    const runUpscale: UpscaleFn = async () => {
      throw new Error("workflow: upscale failed: boom");
    };
    await expect(
      runWorkflowNative({ prompt: "x", upscale: true, _runBase: fakeBase, _runUpscale: runUpscale }),
    ).rejects.toThrow(/boom/);
  });
});
