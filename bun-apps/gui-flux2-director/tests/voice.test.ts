import { describe, expect, test } from "bun:test";

import { buildVoiceMixArgs, concatListBody, isValidVoice } from "../lib/voice";
import { storySecondsToNarrationWords } from "../lib/narration";

describe("buildVoiceMixArgs", () => {
  test("ducks the bed, delays + pads the voice, truncates at video end", () => {
    const args = buildVoiceMixArgs("/in/seg0.mp4", "/in/narration_0.wav", "/in/voiced_0.mp4");
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("volume=0.32"); // LTX bed ducked under narration
    expect(fc).toContain("adelay=300:all=1"); // lead-in before the first word
    expect(fc).toContain("apad"); // silence-pad the voice...
    expect(fc).toContain("duration=first"); // ...then cut at the VIDEO's end
    expect(fc).toContain("normalize=0"); // amix must not halve the levels
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy"); // video never re-encodes
    expect(args.at(-1)).toBe("/in/voiced_0.mp4");
  });
});

describe("concatListBody", () => {
  test("one file line per path, single quotes escaped", () => {
    const body = concatListBody(["/a/voiced_0.mp4", "/it's/voiced_1.mp4"]);
    expect(body.split("\n").filter(Boolean).length).toBe(2);
    expect(body).toContain("file '/a/voiced_0.mp4'");
    expect(body).toContain("file '/it'\\''s/voiced_1.mp4'");
  });
});

describe("isValidVoice", () => {
  test("empty is auto; ids look like af_heart", () => {
    expect(isValidVoice("")).toBe(true);
    expect(isValidVoice("af_heart")).toBe(true);
    expect(isValidVoice("zm_yunjian")).toBe(true);
    expect(isValidVoice("../evil")).toBe(false);
    expect(isValidVoice("AF_HEART")).toBe(false);
  });
});

describe("storySecondsToNarrationWords", () => {
  test("≈2.5 words/second with a floor", () => {
    expect(storySecondsToNarrationWords(2)).toBe(5);
    expect(storySecondsToNarrationWords(4)).toBe(10);
    expect(storySecondsToNarrationWords(8)).toBe(20);
    expect(storySecondsToNarrationWords(1)).toBe(4); // floor for very short clips
  });
});
