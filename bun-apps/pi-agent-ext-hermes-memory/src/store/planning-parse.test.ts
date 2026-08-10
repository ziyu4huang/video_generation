import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  splitPlanningFrontmatter,
  extractTitle,
  extractResolutionGist,
  parseBlockedBy,
  extractCitedPaths,
} from "./planning-parse.js";

const TICKET = `---
type: grilling
status: closed
claimed: pi/test
blocked by: 06
---
# 08 — Planning-card model

## Question
Pin the contract. See bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts
and .planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md.

## Resolution (2026-08-09, grilled)
Hermes owns ingest + store; a serializer plugs into hermes.
Cites src/store/card-store.ts.
`;

describe("planning-parse", () => {
  it("splits frontmatter from body (never throws)", () => {
    const s = splitPlanningFrontmatter(TICKET)!;
    assert.equal(s.data.type, "grilling");
    assert.equal(s.data.status, "closed");
    assert.match(s.body, /# 08 — Planning-card model/);
    assert.equal(splitPlanningFrontmatter("# no fence"), null);
  });
  it("extracts the first H1 title", () => {
    assert.equal(extractTitle("# hello\nbody"), "hello");
    assert.equal(extractTitle("body only"), undefined);
  });
  it("extracts a one-line resolution gist (matches '## Resolution (…)')", () => {
    const body = splitPlanningFrontmatter(TICKET)!.body;
    assert.match(extractResolutionGist(body)!, /Hermes owns ingest/);
  });
  it("returns undefined gist when there is no Resolution section", () => {
    assert.equal(extractResolutionGist("# t\n\n## Question\nq"), undefined);
  });
  it("normalises blocked-by string|array → string[]", () => {
    assert.deepEqual(parseBlockedBy("06"), ["06"]);
    assert.deepEqual(parseBlockedBy("06, 07"), ["06", "07"]);
    assert.deepEqual(parseBlockedBy(["01", "02"]), ["01", "02"]);
    assert.deepEqual(parseBlockedBy(undefined), []);
  });
  it("extracts cited repo-relative paths (deduped)", () => {
    const body = splitPlanningFrontmatter(TICKET)!.body;
    const paths = extractCitedPaths(body);
    assert.ok(paths.includes("bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts"));
    assert.ok(paths.includes(".planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md"));
    assert.ok(paths.includes("src/store/card-store.ts"));
  });
});
