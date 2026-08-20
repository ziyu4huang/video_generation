import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildPromptContext } from "../../src/prompt-context.js";
import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "../../src/constants.js";

describe("buildPromptContext", () => {
  const store = {
    formatForSystemPrompt: () => "<memory-context>MEMORY</memory-context>",
  } as any;

  const projectStore = {
    formatProjectBlock: (projectName: string) => `<memory-context>PROJECT ${projectName}</memory-context>`,
  } as any;

  it("returns policy only in policy-only mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
    assert.match(result, /search \(mode=memory\)/);
    assert.match(result, /Accepted memory categories/);
    assert.match(result, /category filters categorized failure\/lesson memories only/);
    assert.match(result, /Use category only for categorized failure\/lesson searches/);
    assert.match(result, /search: search durable user, global, project-scoped, and failure memories \(mode=memory\), or indexed past conversation messages \(mode=session\)\./);
    assert.match(result, /skill_manage: list, view, create, patch, update, and delete procedural skills/);
    assert.match(result, /Always pass scope explicitly on create/);
    assert.match(result, /Do not create skills for one-off task state/);
    assert.doesNotMatch(result, /category="preference"/);
    assert.doesNotMatch(result, /inspect, and update procedural skills/);
    assert.doesNotMatch(result, /\b(memory|session)[-_]search\b/);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/);
    assert.doesNotMatch(result, /PROJECT demo/);
    assert.doesNotMatch(result, /SKILLS/);
  });

  it("returns the full policy prompt when policy style is full", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "full" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
  });

  it("returns the compact policy prompt when policy style is compact", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "compact" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT_COMPACT);
    assert.match(result, /category filters categorized failure\/lesson memories only/);
    assert.match(result, /scope is required: global for transferable workflows, project for repo-specific ones/);
    assert.match(result, /Do not use search for generic questions/);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/);
    assert.doesNotMatch(result, /PROJECT demo/);
    assert.doesNotMatch(result, /SKILLS/);
  });

  it("includes skill-candidate capture guidance (learning→skill bridge) in both policy styles", async () => {
    // full policy
    const full = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "full" },
      store,
      projectStore,
      "demo",
    );
    assert.match(full, /Skill candidates/);
    assert.match(full, /\.planning\/knowledge\//);
    assert.match(full, /HOW, not a fact/);

    // compact policy
    const compact = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "compact" },
      store,
      projectStore,
      "demo",
    );
    assert.match(compact, /\.planning\/knowledge\//);
    assert.match(compact, /candidate/);
  });

  it("returns custom policy text when policy style is custom", async () => {
    const customText = "<memory-policy>Use local custom policy.</memory-policy>";
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "custom", memoryPolicyCustomText: customText },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, customText);
  });

  it("falls back to compact policy when custom policy text is blank", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "custom", memoryPolicyCustomText: "  \n\t  " },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT_COMPACT);
  });

  it("returns empty context when policy style is none", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "none" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, "");
  });

  it("returns legacy memory blocks in legacy-inject mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject", memoryPolicyStyle: "compact" },
      store,
      projectStore,
      "demo",
    );

    assert.match(result, /MEMORY/);
    assert.match(result, /PROJECT demo/);
    assert.doesNotMatch(result, /<memory-policy>/);
  });

  it("policy prompts state the validated-edit integrity rule (no raw-source mutation)", async () => {
    // UPSP §7 / DO ticket 04 Gap B: the agent edits memory ONLY through the
    // memory tools — never by mutating the .md source directly.
    assert.match(MEMORY_POLICY_PROMPT, /Memory integrity/);
    assert.match(MEMORY_POLICY_PROMPT, /never mutate the underlying .md source files directly/i);
    assert.match(MEMORY_POLICY_PROMPT, /skill_manage/);
    assert.match(MEMORY_POLICY_PROMPT_COMPACT, /Memory integrity/);
    assert.match(MEMORY_POLICY_PROMPT_COMPACT, /never mutate the .md source directly/i);
  });
});
