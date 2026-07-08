import { describe, expect, test } from "bun:test";
import { applyShotLanguage, renderShotLanguage } from "./shotLanguage.ts";

describe("renderShotLanguage", () => {
  test("empty/undefined renders empty string", () => {
    expect(renderShotLanguage(undefined)).toBe("");
    expect(renderShotLanguage({})).toBe("");
  });

  test("single field renders its humanized phrase", () => {
    expect(renderShotLanguage({ shotSize: "close_up" })).toBe("close-up");
    expect(renderShotLanguage({ cameraMovement: "dolly_in" })).toBe("dollying in");
    expect(renderShotLanguage({ lensMm: 35 })).toBe("shot on a 35mm lens");
    expect(renderShotLanguage({ lightingKey: "golden_hour" })).toBe("golden hour lighting");
    expect(renderShotLanguage({ depthOfField: "shallow" })).toBe("shallow depth of field");
    expect(renderShotLanguage({ depthOfField: "medium" })).toBe("medium depth of field");
    expect(renderShotLanguage({ colorTemperature: "warm" })).toBe("warm color temperature");
  });

  test("all fields render in a stable, comma-joined order", () => {
    const clause = renderShotLanguage({
      shotSize: "extreme_close_up",
      cameraMovement: "dolly_in",
      lensMm: 35,
      lightingKey: "golden_hour",
      depthOfField: "shallow",
      colorTemperature: "warm",
    });
    expect(clause).toBe(
      "extreme close-up, dollying in, shot on a 35mm lens, golden hour lighting, shallow depth of field, warm color temperature",
    );
  });
});

describe("applyShotLanguage", () => {
  test("returns the prompt unchanged when shotLanguage is undefined/empty", () => {
    expect(applyShotLanguage("a cat playing piano", undefined)).toBe("a cat playing piano");
    expect(applyShotLanguage("a cat playing piano", {})).toBe("a cat playing piano");
  });

  test("appends the rendered clause with a comma separator", () => {
    expect(applyShotLanguage("a cat playing piano", { shotSize: "close_up" })).toBe(
      "a cat playing piano, close-up.",
    );
  });

  test("trims the prompt and uses a space separator after trailing punctuation", () => {
    expect(applyShotLanguage("a cat playing piano.  ", { shotSize: "close_up" })).toBe(
      "a cat playing piano. close-up.",
    );
    expect(applyShotLanguage("a cat playing piano,", { cameraMovement: "dolly_in" })).toBe(
      "a cat playing piano, dollying in.",
    );
  });
});
