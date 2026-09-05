import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

import { listModelNames, scanModels } from "../lib/models";

let fixtureSeq = 0;

function fixture(): string {
  fixtureSeq += 1;
  const dir = path.join("/tmp", `flux2-gui-models-${process.pid}-${Date.now()}-${fixtureSeq}`);
  // weight-bearing transformer + lora
  mkdirSync(path.join(dir, "transformer", "klein-9b"), { recursive: true });
  writeFileSync(path.join(dir, "transformer", "klein-9b", "model.safetensors"), "x");
  // empty dir → NOT listed
  mkdirSync(path.join(dir, "transformer", "empty-variant"), { recursive: true });
  // non-model file at root ignored
  writeFileSync(path.join(dir, "transformer", "README.md"), "doc");
  mkdirSync(path.join(dir, "lora", "details-9b"), { recursive: true });
  writeFileSync(path.join(dir, "lora", "details-9b", "adapter.safetensors"), "x");
  return dir;
}

describe("listModelNames", () => {
  test("lists only weight-bearing dirs, sorted", () => {
    const dir = fixture();
    expect(listModelNames("transformer", dir)).toEqual(["klein-9b"]);
    expect(listModelNames("lora", dir)).toEqual(["details-9b"]);
  });

  test("missing kind dir → empty, never throws", () => {
    expect(listModelNames("nope", "/tmp/does-not-exist-flux2-gui")).toEqual([]);
  });
});

describe("scanModels", () => {
  test("inventory carries all kinds + echoes the dir", () => {
    const dir = fixture();
    const inv = scanModels(dir);
    expect(inv.transformers).toEqual(["klein-9b"]);
    expect(inv.loras).toEqual(["details-9b"]);
    expect(inv.upscaleModels).toEqual([]);
    expect(inv.modelsDir).toBe(dir);
  });
});
