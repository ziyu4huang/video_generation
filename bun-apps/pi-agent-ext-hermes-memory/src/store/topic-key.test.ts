import { test, expect } from "bun:test";
import { topicKey, deriveCategory, findTopicRecurrence, formatTopicRecurrenceWarning } from "./topic-key.js";

test("tool-quirk topic-key = subject tool name (backtick span)", () => {
  expect(topicKey("[tool-quirk] `await_pr_merge` blocks when CI green — pre #1030")).toBe("await_pr_merge");
});

test("tool-quirk topic-key falls back to first identifier without backticks", () => {
  expect(topicKey("[tool-quirk] gh pr checks 1042 hangs on pending")).toBe("gh_pr");
});

test("non-tool-quirk topic-key = first 3 distinctive tokens", () => {
  expect(topicKey("[insight] SurrealDB snowball tokenizer ignores short terms"))
    .toBe("surrealdb_snowball_tokenizer");
});

test("evolving family: same subject, different wording → same key", () => {
  const a = "[tool-quirk] `await_pr_merge` kept blocking after #1028 cross-worktree merge";
  const b = "[tool-quirk] `await_pr_merge` now merges directly once CI green (post #1030)";
  expect(topicKey(a)).toBe(topicKey(b));
  expect(topicKey(a)).toBe("await_pr_merge");
});

test("findTopicRecurrence returns the first existing match", () => {
  const existing = [
    "[insight] some unrelated lesson about bun install caching",
    "[tool-quirk] `await_pr_merge` historical hazard pre-#1030",
  ];
  const hit = findTopicRecurrence("[tool-quirk] `await_pr_merge` new incident", existing);
  expect(hit).not.toBeNull();
  expect(hit!.index).toBe(1);
  expect(hit!.topicKey).toBe("await_pr_merge");
});

test("findTopicRecurrence null when no shared key", () => {
  expect(findTopicRecurrence("[tool-quirk] `git_rebase` quirk", ["[tool-quirk] `await_pr_merge` quirk"])).toBeNull();
});

test("deriveCategory reads the [category] prefix", () => {
  expect(deriveCategory("[tool-quirk] x")).toBe("tool-quirk");
  expect(deriveCategory("[failure] y")).toBe("failure");
  expect(deriveCategory("no prefix")).toBeNull();
});

test("formatTopicRecurrenceWarning names the key and previews the match", () => {
  const hit = findTopicRecurrence("[tool-quirk] `await_pr_merge` new", ["[tool-quirk] `await_pr_merge` old hazard"]);
  expect(hit).not.toBeNull();
  const msg = formatTopicRecurrenceWarning(hit!);
  expect(msg).toContain("await_pr_merge");
  expect(msg).toContain("skill");
});
