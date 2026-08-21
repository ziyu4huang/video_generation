import { describe, expect, test } from "bun:test";
import { extractFileOps, verifiedFilesBlock, allFiles } from "./file-ops.ts";

const msg = (calls: Array<{ name: string; arguments: Record<string, unknown> }>) =>
  ({
    role: "assistant" as const,
    content: calls.map((c, i) => ({ type: "toolCall" as const, id: `t${i}`, ...c })),
  }) as unknown as import("@earendil-works/pi-ai").Message;

describe("extractFileOps", () => {
  test("buckets by tool name, dedupes and sorts", () => {
    const ops = extractFileOps([
      msg([
        { name: "read", arguments: { path: "b.ts" } },
        { name: "read", arguments: { path: "a.ts" } },
      ]),
      msg([{ name: "edit", arguments: { file_path: "c.ts" } }]),
      msg([{ name: "write", arguments: { path: "d.ts" } }]),
      msg([{ name: "multi_edit", arguments: { edits: [{ path: "e.ts" }, { path: "c.ts" }] } }]),
    ]);
    expect(ops).toEqual({ read: ["a.ts", "b.ts"], edited: ["c.ts", "e.ts"], written: ["d.ts"] });
  });

  test("unknown tool names ignored; user messages ignored", () => {
    const ops = extractFileOps([
      { role: "user", content: [{ type: "text", text: "edit foo" }] } as never,
      msg([{ name: "bash", arguments: { command: "rm -rf" } }]),
    ]);
    expect(allFiles(ops)).toEqual([]);
  });

  test("merges host fileOps sets", () => {
    const ops = extractFileOps(
      [msg([{ name: "read", arguments: { path: "x.ts" } }])],
      {
        read: new Set(["host.ts"]),
        written: new Set(),
        edited: new Set(),
      },
    );
    expect(ops.read).toEqual(["host.ts", "x.ts"]);
  });
});

describe("verifiedFilesBlock", () => {
  test("renders sections with (none) placeholders", () => {
    expect(verifiedFilesBlock({ read: [], written: [], edited: ["a.ts"] })).toBe(
      "<verified-files>\nEdited: a.ts\nRead: (none)\nWritten: (none)\n</verified-files>",
    );
  });
});
