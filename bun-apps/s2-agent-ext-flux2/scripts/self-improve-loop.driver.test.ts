/**
 * Unit tests for the deterministic (non-model) exemplar append in the
 * self-improve-loop driver. Pins goal 0402 criterion #2: persistence cannot die
 * with a weak-model agent — it is a plain fs append in the driver, exercised
 * here with no workflow / no model / no GPU.
 */
import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendExemplar, loadFewShot } from "./self-improve-loop.driver.ts";

function ex(meanFaith: number, prompt = "p") {
  return { prompt, params: { seed: 1 }, verdict: { meanFaith, ok: true } };
}

describe("appendExemplar (deterministic driver persistence)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "exemplar-"));
    file = path.join(dir, "self-improve.exemplars.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the file on first append (one valid JSON line)", () => {
    const r = appendExemplar(file, ex(0.9), 40);
    assert.equal(r.written, true);
    assert.equal(r.totalLines, 1);
    assert.ok(existsSync(file));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), ex(0.9));
  });

  it("appends a second exemplar and keeps both", () => {
    appendExemplar(file, ex(0.9), 40);
    const r = appendExemplar(file, ex(0.8), 40);
    assert.equal(r.totalLines, 2);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("caps to maxActive by retiring the LOWEST meanFaith", () => {
    appendExemplar(file, ex(0.3), 3);
    appendExemplar(file, ex(0.5), 3);
    appendExemplar(file, ex(0.9), 3);
    // 4th append → over cap (3) → lowest (0.3) retired.
    const r = appendExemplar(file, ex(0.7), 3);
    assert.equal(r.totalLines, 3);
    const faiths = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).verdict.meanFaith).sort();
    assert.deepEqual(faiths, [0.5, 0.7, 0.9], "0.3 (lowest) retired, new 0.7 kept");
  });

  it("no exemplar → written=false, file untouched", () => {
    const r = appendExemplar(file, null, 40);
    assert.equal(r.written, false);
    assert.equal(r.reason, "no exemplar");
    assert.ok(!existsSync(file));
  });

  it("survives a corrupted existing line (drops only the bad line)", () => {
    rmSync(file, { force: true });
    // Pre-write a file with one valid + one garbage line.
    writeFileSync(file, JSON.stringify(ex(0.4)) + "\nGARBAGE_NOT_JSON\n", "utf8");
    const r = appendExemplar(file, ex(0.8), 40);
    assert.equal(r.written, true);
    assert.equal(r.totalLines, 2, "garbage line dropped, valid prior + new kept");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    for (const l of lines) JSON.parse(l); // all parse
  });
});

describe("loadFewShot (cross-run few-shot selection)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fewshot-"));
    file = path.join(dir, "self-improve.exemplars.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the HIGHEST-meanFaith winningPrompt among matching base prompts", () => {
    const base = "a dancer's pose";
    const records = [
      { prompt: base, winningPrompt: base + " (faith 0.7 version)", verdict: { meanFaith: 0.7 } },
      { prompt: base, winningPrompt: base + " (faith 0.95 version)", verdict: { meanFaith: 0.95 } },
      { prompt: "a different pose", winningPrompt: "other", verdict: { meanFaith: 1.0 } },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const fs = loadFewShot(file, base);
    assert.equal(fs, base + " (faith 0.95 version)", "picks the highest-faith match for THIS pose");
  });

  it("returns '' when no prior run matches the target pose (first run)", () => {
    writeFileSync(file, JSON.stringify({ prompt: "other pose", winningPrompt: "x", verdict: { meanFaith: 1 } }) + "\n", "utf8");
    assert.equal(loadFewShot(file, "a new pose"), "");
  });

  it("returns '' when the exemplars file does not exist yet", () => {
    assert.equal(loadFewShot(path.join(dir, "nope.jsonl"), "any"), "");
  });
});
