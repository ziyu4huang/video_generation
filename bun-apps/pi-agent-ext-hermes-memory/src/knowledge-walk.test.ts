import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkKnowledgeSources } from "./knowledge-walk.js";

/** Builds the plan's Task-3 fixture tree in a temp dir. Returns absolute paths
 *  for the entries the assertions reference. */
function buildFixture(): { root: string; runA: string; deep: string; readme: string; symlink: string; blob: string; pic: string; gitDir: string; nmDir: string; archiveDir: string; planningSddDir: string; agentsMemoryCard: string } {
  const root = mkdtempSync(join(tmpdir(), "kwalk-"));
  const workflows = join(root, "workflows");
  const notes = join(root, "notes");
  const gitDir = join(root, ".git");
  // node_modules is pruned at its ROOT by the skip policy; expose the root here.
  const nmDir = join(root, "node_modules");
  const nmPkg = join(nmDir, "pkg");
  const archiveDir = join(root, "_archive");
  const planningDir = join(root, ".planning");
  const planningSddDir = join(planningDir, "sdd");
  const deepDirs = join(root, "a", "b", "c");
  const agentsMemory = join(root, ".agents", "memory");
  for (const d of [workflows, notes, gitDir, nmPkg, archiveDir, planningSddDir, deepDirs, agentsMemory]) {
    mkdirSync(d, { recursive: true });
  }
  const runA = join(workflows, "run-a.knowledge.jsonl");
  const deep = join(deepDirs, "deep.knowledge.jsonl");
  const readme = join(notes, "readme.md");
  const gitConfig = join(gitDir, "config");
  const nmIndex = join(nmDir, "index.js");
  const oldJsonl = join(archiveDir, "old.knowledge.jsonl");
  const sddX = join(planningSddDir, "x.md");
  const symlink = join(root, "link.knowledge.jsonl");
  const blob = join(root, "blob.zip");
  const pic = join(root, "pic.png");
  const agentsMemoryCard = join(agentsMemory, "card.md");
  writeFileSync(runA, '{"id":"a1","type":"lever","title":"A","detail":"","tags":[],"dimension":null,"confidence":1,"status":"active","superseded_by":null}\n');
  writeFileSync(deep, '{"id":"d1","type":"gotcha","title":"Deep","detail":"","tags":[],"dimension":null,"confidence":1,"status":"active","superseded_by":null}\n');
  writeFileSync(readme, "# readme\n");
  writeFileSync(gitConfig, "[core]\n");
  writeFileSync(nmIndex, "module.exports = {};\n");
  writeFileSync(oldJsonl, '{"id":"old","type":"lever","title":"Old","detail":"","tags":[],"dimension":null,"confidence":1,"status":"active","superseded_by":null}\n');
  writeFileSync(sddX, "# sdd\n");
  writeFileSync(blob, "PK\x03\x04");
  writeFileSync(pic, "\x89PNG\r\n\x1a\n");
  writeFileSync(agentsMemoryCard, "---\nid: mem-1\n---\n# memory card\n");
  // Symlink at root pointing at the real workflow file — must be skipped.
  symlinkSync(runA, symlink);
  return { root, runA, deep, readme, symlink, blob, pic, gitDir, nmDir, archiveDir, planningSddDir, agentsMemoryCard };
}

describe("walkKnowledgeSources (policy walk + source-family detection)", () => {
  let fx: ReturnType<typeof buildFixture>;

  beforeEach(() => { fx = buildFixture(); });
  afterEach(() => { rmSync(fx.root, { recursive: true, force: true }); });

  it("collects workflow-jsonl files (unlimited depth) and excludes symlinks", () => {
    const r = walkKnowledgeSources(fx.root);
    assert.deepEqual(r.files["workflow-jsonl"].sort(), [fx.deep, fx.runA].sort());
  });

  it("collects exactly the one generic .md (excludes junk-dir + deferred md)", () => {
    const r = walkKnowledgeSources(fx.root);
    assert.deepEqual(r.files.generic, [fx.readme]);
  });

  it("skips junk dirs (.git / node_modules / _archive / .planning/sdd)", () => {
    const r = walkKnowledgeSources(fx.root);
    const dirs = r.skipped.dirs;
    assert.ok(dirs.includes(fx.gitDir), ".git skipped");
    assert.ok(dirs.includes(fx.nmDir), "node_modules skipped");
    assert.ok(dirs.includes(fx.archiveDir), "_archive skipped");
    assert.ok(dirs.includes(fx.planningSddDir), ".planning/sdd skipped");
  });

  it("skips symlinks (never follows)", () => {
    const r = walkKnowledgeSources(fx.root);
    assert.ok(r.skipped.symlinks.includes(fx.symlink), "symlink in skipped.symlinks");
    // And the symlink target is NOT double-counted in workflow-jsonl.
    assert.ok(!r.files["workflow-jsonl"].includes(fx.symlink));
  });

  it("skips binaries by denylist extension", () => {
    const r = walkKnowledgeSources(fx.root);
    assert.ok(r.skipped.binaries.includes(fx.blob), "blob.zip in skipped.binaries");
  });

  it("skips images by default (opt-in OFF)", () => {
    const r = walkKnowledgeSources(fx.root);
    assert.ok(r.skipped.binaries.includes(fx.pic), "pic.png skipped by default");
  });

  it("does NOT skip images when includeImages is true", () => {
    const r = walkKnowledgeSources(fx.root, { includeImages: true });
    assert.ok(!r.skipped.binaries.includes(fx.pic), "pic.png not skipped when opted in");
  });

  it("defers .agents/memory family (memory cards, out of scope)", () => {
    const r = walkKnowledgeSources(fx.root);
    assert.ok(
      r.skipped.deferredFamily.includes(fx.agentsMemoryCard),
      ".agents/memory card in skipped.deferredFamily",
    );
    assert.ok(!r.files.generic.includes(fx.agentsMemoryCard), "deferred card not in generic");
  });

  it("accepts a single file as input", () => {
    const r = walkKnowledgeSources(fx.runA);
    assert.deepEqual(r.files["workflow-jsonl"], [fx.runA]);
  });
});
