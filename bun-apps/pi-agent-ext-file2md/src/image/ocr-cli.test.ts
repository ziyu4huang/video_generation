import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { runVisionOcr } from "./ocr.js";

// src/image → pkg → bun-apps → repo root.
const CLI = new URL("../../../../swift/vision-ocr-cli/.build/release/vision-ocr-cli", import.meta.url)
  .pathname;
const FIXTURE = new URL("../../../../swift/vision-ocr-cli/fixtures/hello-123.png", import.meta.url)
  .pathname;

describe("vision-ocr-cli integration (ticket 07 T2)", () => {
  it("OCRs the committed fixture → JSON {text,width,height,format}", { skip: !existsSync(CLI) }, async () => {
    const r = await runVisionOcr(FIXTURE, { cliPath: CLI });
    assert.ok(r, "runVisionOcr returned a result");
    assert.match(r.text.toUpperCase(), /HELLO/);
    assert.equal(r.width, 800);
    assert.equal(r.height, 200);
    assert.equal(r.format, "png");
  });
  it("returns undefined (never throws) when the binary is absent", async () => {
    const r = await runVisionOcr(FIXTURE, { cliPath: "/nonexistent/vision-ocr-cli" });
    assert.equal(r, undefined);
  });
});
