import { describe, expect, test } from "bun:test";
import { guessImageMimeType } from "./ask.ts";

describe("guessImageMimeType", () => {
  test("defaults to png for flux2's PNG outputs and unknown extensions", () => {
    expect(guessImageMimeType("/x/photo.png")).toBe("image/png");
    expect(guessImageMimeType("/x/photo")).toBe("image/png");
  });

  test("detects jpg/jpeg/webp/gif/bmp", () => {
    expect(guessImageMimeType("/x/a.jpg")).toBe("image/jpeg");
    expect(guessImageMimeType("/x/a.jpeg")).toBe("image/jpeg");
    expect(guessImageMimeType("/x/a.webp")).toBe("image/webp");
    expect(guessImageMimeType("/x/a.gif")).toBe("image/gif");
    expect(guessImageMimeType("/x/a.bmp")).toBe("image/bmp");
  });

  test("is case-insensitive on the extension", () => {
    expect(guessImageMimeType("/x/A.JPG")).toBe("image/jpeg");
  });
});
