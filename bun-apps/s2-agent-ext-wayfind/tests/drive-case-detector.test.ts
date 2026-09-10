import { describe, expect, it } from "bun:test";
import { bashIsMutating, detectFromLines, posBefore } from "../scripts/drive-case.js";

/**
 * Detector regression locks for the live-drive harness (spwf-drive-ab t07,
 * promoting the scratch output/spwf-drive/drive-case.ts). These fixtures are
 * the t02 validation set in committed form:
 *   - read turn strictly before write turn → C2 COMPLIANT (the leg-2 bytes
 *     the A/B arc mislabeled PARTIAL — the detector was wrong, not the model)
 *   - read + write batched in ONE assistant message → NON-COMPLIANT
 *   - bash recon (ls/cat) is NOT a mutation; write operators are
 *   - C3: test-write before impl-write compares (msgLine, callOrdinal)
 */

const MODEL = { type: "model_change", provider: "zai", modelId: "glm-5.3" };
const USER = (t: string) =>
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } });
const assistant = (calls: { name: string; args: Record<string, unknown> }[], model = "glm-5.3") =>
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      model,
      content: calls.map((c, i) => ({ type: "toolCall", id: `c${i}`, name: c.name, arguments: c.args })),
    },
  });

const line = (j: unknown) => (typeof j === "string" ? j : JSON.stringify(j));

describe("drive-case detector (spwf-ab-closing t07)", () => {
  it("C2: read turn strictly before write turn → COMPLIANT (the leg-2 bytes)", () => {
    const lines = [
      line({ type: "session", version: 3, id: "s" }),
      line(MODEL),
      line(USER("task [case-id: n1]")),
      // turn 5: skill read + read-only bash recon (NOT a mutation)
      assistant([
        { name: "read", args: { path: "/x/superpowers/skills/brainstorming/SKILL.md" } },
        {
          name: "bash",
          args: { command: "ls -la output/spwf-ab/scratch && cat output/spwf-ab/scratch/hello.ts || echo NO_FILE" },
        },
      ]),
      // turn 8: the actual write
      assistant([{ name: "write", args: { path: "output/spwf-ab/scratch/hello.ts", content: "x" } }]),
    ];
    const d = detectFromLines(lines);
    expect(d.reads).toContain("brainstorming");
    expect(d.firstRead).not.toBeNull();
    expect(d.firstMutate).not.toBeNull();
    const readPos = d.firstRead as { msgLine: number; callOrdinal: number };
    const mutatePos = d.firstMutate as { msgLine: number; callOrdinal: number };
    expect(readPos.msgLine).toBeLessThan(mutatePos.msgLine);
    // the recon bash is recorded but NOT classified mutating:
    expect(d.bashCalls.some((b) => b.mutating)).toBe(false);
  });

  it("C2: read + write batched in ONE assistant message → NON-COMPLIANT", () => {
    const lines = [
      line({ type: "session", version: 3, id: "s" }),
      line(MODEL),
      line(USER("task [case-id: n2]")),
      assistant([
        { name: "read", args: { path: "/x/superpowers/skills/brainstorming/SKILL.md" } },
        { name: "write", args: { path: "output/spwf-ab/scratch/hello.ts", content: "x" } },
      ]),
    ];
    const d = detectFromLines(lines);
    // same msgLine → posBefore is false at line granularity; the C2 check
    // uses strict msgLine comparison (same-turn batch = non-compliant):
    const batchedRead = d.firstRead as { msgLine: number };
    const batchedWrite = d.firstMutate as { msgLine: number };
    expect(batchedRead.msgLine).toBe(batchedWrite.msgLine);
    expect(batchedRead.msgLine < batchedWrite.msgLine).toBe(false);
  });

  it("bash: recon commands are non-mutating; write operators are mutating", () => {
    expect(bashIsMutating("ls -la output/spwf-ab/scratch && cat file || echo NO_FILE")).toBe(false);
    expect(bashIsMutating("cat output/spwf-ab/scratch/hello.ts")).toBe(false);
    expect(bashIsMutating("echo hello > output/spwf-ab/scratch/x.txt")).toBe(true);
    expect(bashIsMutating("rm -rf output/spwf-ab/scratch")).toBe(true);
    expect(bashIsMutating("mkdir -p output/spwf-ab/scratch")).toBe(true);
    expect(bashIsMutating("git commit -m x")).toBe(true);
  });

  it("C3: test-write before impl-write compares (msgLine, callOrdinal)", () => {
    const lines = [
      line({ type: "session", version: 3, id: "s" }),
      line(MODEL),
      line(USER("task [case-id: n3]")),
      assistant([{ name: "read", args: { path: "/x/superpowers/skills/test-driven-development/SKILL.md" } }]),
      // same turn, two writes: test FIRST (ordinal 0) then impl (ordinal 1)
      assistant([
        { name: "write", args: { path: "output/spwf-ab/scratch/is_leap.test.ts", content: "t" } },
        { name: "write", args: { path: "output/spwf-ab/scratch/is_leap.ts", content: "i" } },
      ]),
    ];
    const d = detectFromLines(lines);
    const firstTest = d.mutatingPaths.find((w) => w.kind === "test");
    const firstImpl = d.mutatingPaths.find((w) => w.kind === "impl");
    expect(firstTest).toBeDefined();
    expect(firstImpl).toBeDefined();
    // same msgLine, test has the lower callOrdinal → lexicographic order holds
    expect(
      posBefore(
        (firstTest as { pos: { msgLine: number; callOrdinal: number } }).pos,
        (firstImpl as { pos: { msgLine: number; callOrdinal: number } }).pos,
      ),
    ).toBe(true);
  });
});
