import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "../store/repository.js";
import {
  findDanglingLineageReferences,
  formatDanglingWarning,
} from "./integrity-sweep.js";

/** Build a minimal MemoryEntry with sensible defaults + per-test overrides. */
function mk(over: Partial<MemoryEntry> & { id: number }): MemoryEntry {
  return {
    project: null,
    target: "memory",
    category: null,
    content: "",
    failureReason: null,
    toolState: null,
    correctedTo: null,
    created: "2026-08-02",
    lastReferenced: "2026-08-02",
    ...over,
  };
}

describe("findDanglingLineageReferences", () => {
  test("flags supersedes / supersededBy / parentIds pointing at absent ids", () => {
    // id 2 points at three absent ids (999 via supersedes, 888 via supersededBy,
    // and 999 + 777 via parentIds). id 3's parentIds=[2] is PRESENT → not flagged.
    const entries = [
      mk({ id: 2, supersedes: 999, supersededBy: 888, parentIds: [999, 777] }),
      mk({ id: 3, parentIds: [2] }),
    ];
    expect(findDanglingLineageReferences(entries)).toEqual([
      { entryId: 2, target: "memory", field: "supersedes", missingId: 999 },
      { entryId: 2, target: "memory", field: "supersededBy", missingId: 888 },
      { entryId: 2, target: "memory", field: "parentIds", missingId: 777 },
      { entryId: 2, target: "memory", field: "parentIds", missingId: 999 },
    ]);
  });

  test("does NOT flag a pointer to a present-but-superseded row (normal lineage)", () => {
    // id 1 is superseded but its row still EXISTS — id 2's pointers to it are
    // legitimate supersession lineage, not rot. Flagging would flood.
    const entries = [
      mk({ id: 1, status: "superseded", supersededBy: 2 }),
      mk({ id: 2, supersedes: 1, parentIds: [1] }),
    ];
    expect(findDanglingLineageReferences(entries)).toEqual([]);
  });

  test("ignores null / undefined / empty / malformed lineage fields", () => {
    const entries = [
      mk({ id: 1, supersedes: null, supersededBy: undefined, parentIds: [] }),
      mk({ id: 2, parentIds: undefined }),
      mk({ id: 3 }), // no lineage at all
    ];
    expect(findDanglingLineageReferences(entries)).toEqual([]);
  });

  test("de-dupes a repeated missing parentId", () => {
    // A malformed [4242, 4242] must flag id 4242 once, not twice.
    const entries = [mk({ id: 1, parentIds: [4242, 4242] })];
    expect(findDanglingLineageReferences(entries)).toEqual([
      { entryId: 1, target: "memory", field: "parentIds", missingId: 4242 },
    ]);
  });

  test("freshIds entries are skipped (fresh-successor exclusion)", () => {
    // id 5 is fresh (created this round) and points at an absent id → excluded.
    // id 6 points at the same absent id but is not fresh → flagged.
    const entries = [
      mk({ id: 5, supersedes: 4242 }),
      mk({ id: 6, supersedes: 4242 }),
    ];
    expect(findDanglingLineageReferences(entries, new Set([5]))).toEqual([
      { entryId: 6, target: "memory", field: "supersedes", missingId: 4242 },
    ]);
  });

  test("output is deterministically sorted across entries + fields", () => {
    const entries = [
      mk({ id: 5, supersedes: 50 }), // later id, earlier field
      mk({ id: 4, supersededBy: 40, parentIds: [41] }), // earlier id
    ];
    expect(findDanglingLineageReferences(entries)).toEqual([
      { entryId: 4, target: "memory", field: "supersededBy", missingId: 40 },
      { entryId: 4, target: "memory", field: "parentIds", missingId: 41 },
      { entryId: 5, target: "memory", field: "supersedes", missingId: 50 },
    ]);
  });

  test("empty store → no dangling", () => {
    expect(findDanglingLineageReferences([])).toEqual([]);
  });

  test("formatDanglingWarning renders a stable line", () => {
    expect(
      formatDanglingWarning({ entryId: 7, target: "failure", field: "supersedes", missingId: 99 }),
    ).toBe("dangling supersedes: failure#7 → missing id 99");
  });
});
