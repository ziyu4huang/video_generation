import { describe, expect, it } from "bun:test";
import { composePlaybookTask } from "../scripts/arc-plan.js";

/** D4 locks (selfimprove-playbook t03): the playbook composition is pure and
 *  content-addressed — the receipt's sha256 names the exact bytes the
 *  planner saw, and the playbook lands BEFORE the task. */
describe("arc-plan --include-playbook composition", () => {
  it("prepends the playbook before the task and content-hashes it", () => {
    const { task, sha256 } = composePlaybookTask("Plan the arc now.", "### PB-01 — strategy one");
    expect(task.indexOf("### PB-01")).toBeLessThan(task.indexOf("Plan the arc now."));
    expect(task).toContain("PB-nn");
    // stable content hash (sha256 of the exact playbook bytes)
    expect(sha256).toHaveLength(64);
    const again = composePlaybookTask("different task", "### PB-01 — strategy one");
    expect(again.sha256).toBe(sha256); // hash covers the playbook, not the task
  });

  it("different playbook bytes → different hash", () => {
    const a = composePlaybookTask("t", "playbook A");
    const b = composePlaybookTask("t", "playbook B");
    expect(a.sha256).not.toBe(b.sha256);
  });
});
