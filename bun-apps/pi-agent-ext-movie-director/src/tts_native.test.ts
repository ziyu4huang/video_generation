import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runTtsNative, type MsEdgeTtsFactory } from "./tts_native.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "md-tts-native-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeFactory(audioBytes: Buffer): { factory: MsEdgeTtsFactory; setMetadataCalls: unknown[][]; toStreamCalls: unknown[][] } {
  const setMetadataCalls: unknown[][] = [];
  const toStreamCalls: unknown[][] = [];
  const factory: MsEdgeTtsFactory = () => ({
    setMetadata: async (...args: unknown[]) => {
      setMetadataCalls.push(args);
    },
    toStream: (...args: unknown[]) => {
      toStreamCalls.push(args);
      const audioStream = Readable.from([audioBytes]);
      return { audioStream, metadataStream: null };
    },
    close: () => {},
  });
  return { factory, setMetadataCalls, toStreamCalls };
}

describe("runTtsNative", () => {
  it("writes the synthesized audio to the exact requested output path", async () => {
    const dir = tmpDir();
    const output = join(dir, "narration.mp3");
    const { factory } = fakeFactory(Buffer.from("fake-mp3-bytes"));

    const result = await runTtsNative({ text: "hello world" }, output, factory);

    expect(result.details.ok).toBe(true);
    expect(result.details.output).toBe(output);
    expect(readFileSync(output)).toEqual(Buffer.from("fake-mp3-bytes"));
  });

  it("passes voice + rate through to setMetadata/toStream", async () => {
    const dir = tmpDir();
    const output = join(dir, "narration.mp3");
    const { factory, setMetadataCalls, toStreamCalls } = fakeFactory(Buffer.from("x"));

    await runTtsNative({ text: "hi", voice: "zh-TW-HsiaoChenNeural", rate: "+15%" }, output, factory);

    expect(setMetadataCalls[0]?.[0]).toBe("zh-TW-HsiaoChenNeural");
    expect(toStreamCalls[0]?.[0]).toBe("hi");
    expect(toStreamCalls[0]?.[1]).toEqual({ rate: "+15%" });
  });

  it("defaults to en-US-AriaNeural when no voice is given", async () => {
    const dir = tmpDir();
    const output = join(dir, "narration.mp3");
    const { factory, setMetadataCalls } = fakeFactory(Buffer.from("x"));

    const result = await runTtsNative({ text: "hi" }, output, factory);

    expect(setMetadataCalls[0]?.[0]).toBe("en-US-AriaNeural");
    expect(result.details.voice).toBe("en-US-AriaNeural");
  });

  it("reports ok=false when the stream produces zero bytes", async () => {
    const dir = tmpDir();
    const output = join(dir, "narration.mp3");
    const { factory } = fakeFactory(Buffer.alloc(0));

    const result = await runTtsNative({ text: "hi" }, output, factory);

    expect(result.details.ok).toBe(false);
  });

  it("reports a structured failure when the client throws", async () => {
    const dir = tmpDir();
    const output = join(dir, "narration.mp3");
    const factory: MsEdgeTtsFactory = () => ({
      setMetadata: async () => {
        throw new Error("connection refused");
      },
      toStream: () => ({ audioStream: Readable.from([]), metadataStream: null }),
      close: () => {},
    });

    const result = await runTtsNative({ text: "hi" }, output, factory);

    expect(result.details.ok).toBe(false);
    expect(result.summary).toContain("connection refused");
  });
});
