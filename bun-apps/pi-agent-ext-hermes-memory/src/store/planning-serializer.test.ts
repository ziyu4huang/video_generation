import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PlanningEffortSerializer, PlanningTicketSerializer } from "./planning-serializer.js";

const here = dirname(fileURLToPath(import.meta.url));
const effortDir = join(here, "__fixtures__/planning/2026-08-08-fixture-effort");
const mapBytes = readFileSync(join(effortDir, "map.md"), "utf8");
const t08Bytes = readFileSync(join(effortDir, "tickets/08-planning-card-model.md"), "utf8");
const EFFORT = "2026-08-08-fixture-effort";

describe("PlanningEffortSerializer", () => {
  const ser = new PlanningEffortSerializer();
  it("kind === planning-effort", () => assert.equal(ser.kind, "planning-effort"));
  it("deserialize map.md -> 1 planning-effort card", () => {
    const cards = ser.deserialize(mapBytes, { filePath: `.planning/${EFFORT}/map.md` });
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "planning-effort");
    assert.equal(c.id, `planning-effort:${EFFORT}`);
    assert.equal(c.frontmatter.status, "active");
    assert.equal(c.frontmatter.title, "Fixture effort — planning-card serializer");
    assert.match(c.content, /## Destination/);
  });
  it("graph.links = ticket numbers cited in the map", () => {
    const [c] = ser.deserialize(mapBytes, { filePath: `.planning/${EFFORT}/map.md` });
    assert.deepEqual([...(c!.graph?.links ?? [])].sort(), ["01", "08"]);
  });
  it("returns [] without filePath", () => assert.deepEqual(ser.deserialize(mapBytes), []));
});

describe("PlanningTicketSerializer", () => {
  const ser = new PlanningTicketSerializer();
  it("kind === planning-ticket", () => assert.equal(ser.kind, "planning-ticket"));
  it("deserialize tickets/08 -> planning-ticket card with gist + deps", () => {
    const cards = ser.deserialize(t08Bytes, {
      filePath: `.planning/${EFFORT}/tickets/08-planning-card-model.md`,
    });
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "planning-ticket");
    assert.equal(c.id, `planning-ticket:${EFFORT}:08`);
    assert.equal(c.frontmatter.id, "08");
    assert.equal(c.frontmatter.slug, "planning-card-model");
    assert.equal(c.frontmatter.type, "grilling");
    assert.equal(c.frontmatter.status, "closed");
    assert.equal(c.frontmatter.claimed, "pi/test");
    assert.deepEqual(c.frontmatter.blockedBy, ["01"]);
    // ADAPTATION (08-impl T3): Card.frontmatter is `Record<string, unknown>`,
    // so `.resolutionGist` is `unknown`; assert.match requires `string`. Cast is
    // type-only — runtime + assertion intent are byte-identical to the plan.
    assert.match(c.frontmatter.resolutionGist as string, /Hermes owns ingest/);
    assert.match(c.content, /## Resolution/);
  });
  it("graph.relations = blocked-by + cited paths", () => {
    const [c] = ser.deserialize(t08Bytes, {
      filePath: `.planning/${EFFORT}/tickets/08-planning-card-model.md`,
    });
    const rels = c!.graph?.relations ?? [];
    assert.ok(
      rels.some((r) => r.rel === "blocked-by" && r.o === `planning-ticket:${EFFORT}:01`),
    );
    assert.ok(
      rels.some(
        (r) => r.rel === "cites" && r.o === "bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts",
      ),
    );
    assert.ok(
      rels.some(
        (r) =>
          r.rel === "cites" &&
          r.o === ".planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md",
      ),
    );
  });
});

describe("PlanningTicketSerializer — depends_on edge (10-impl T1)", () => {
  const ser = new PlanningTicketSerializer();
  const EFF = "dep-edge-eff";
  const md = `---\ntype: task\nstatus: closed\nblocked by: 01\ndepends_on:\n  - bun-apps/hermes/src/store/card.ts\n  - docs/spec.md\n---\n# 02 — x\n\n## Resolution\nCites src/real/file.ts in body.\n`;
  it("emits depends_on paths as graph.relations (rel='depends_on')", () => {
    const [c] = ser.deserialize(md, { filePath: `.planning/${EFF}/tickets/02-x.md` });
    const rels = c!.graph?.relations ?? [];
    assert.ok(rels.some((r) => r.rel === "depends_on" && r.o === "bun-apps/hermes/src/store/card.ts"));
    assert.ok(rels.some((r) => r.rel === "depends_on" && r.o === "docs/spec.md"));
  });
  it("emits frontmatter.dependsOn (the parsed list)", () => {
    const [c] = ser.deserialize(md, { filePath: `.planning/${EFF}/tickets/02-x.md` });
    assert.deepEqual(c!.frontmatter.dependsOn, ["bun-apps/hermes/src/store/card.ts", "docs/spec.md"]);
  });
  it("blocked-by + cites are UNCHANGED alongside depends_on", () => {
    const [c] = ser.deserialize(md, { filePath: `.planning/${EFF}/tickets/02-x.md` });
    const rels = c!.graph?.relations ?? [];
    assert.ok(rels.some((r) => r.rel === "blocked-by" && r.o === `planning-ticket:${EFF}:01`));
    assert.ok(rels.some((r) => r.rel === "cites" && r.o === "src/real/file.ts"));
    assert.deepEqual(c!.frontmatter.blockedBy, ["01"]);
  });
  it("absent depends_on -> no depends_on relation + no frontmatter.dependsOn", () => {
    const noDeps = `---\ntype: task\nstatus: closed\n---\n# 03 — y\n\n## Resolution\nPlain.\n`;
    const [c] = ser.deserialize(noDeps, { filePath: `.planning/${EFF}/tickets/03-y.md` });
    const rels = c!.graph?.relations ?? [];
    assert.equal(rels.some((r) => r.rel === "depends_on"), false);
    assert.equal(c!.frontmatter.dependsOn, undefined);
  });
});

describe("golden round-trip: serialize → deserialize → serialize byte-identity (C1 close-out)", () => {
  // The planning fence split now delegates to splitFencedYaml (C1 #1196 leaf);
  // these goldens pin that the rewired path keeps serialize a fixed point on
  // representative planning fixtures: s1 = serialize(deserialize(md)),
  // s2 = serialize(deserialize(s1)) ⇒ s1 === s2, byte-for-byte.
  const effortSer = new PlanningEffortSerializer();
  const ticketSer = new PlanningTicketSerializer();

  function roundTrip(
    ser: PlanningEffortSerializer | PlanningTicketSerializer,
    md: string,
    filePath: string,
  ): string {
    const s1 = ser.serialize(ser.deserialize(md, { filePath })[0]!);
    const s2 = ser.serialize(ser.deserialize(s1, { filePath })[0]!);
    assert.equal(s2, s1);
    return s1;
  }

  it("planning-effort (map.md fixture) round-trips byte-identically", () => {
    const s1 = roundTrip(effortSer, mapBytes, `.planning/${EFFORT}/map.md`);
    // Sanity: the fixed point still carries status + H1 + body sections.
    assert.match(s1, /^---\nstatus: active\n---\n\n# Fixture effort/);
    assert.match(s1, /## Notes/);
  });

  it("planning-ticket (fixture 08, blocked-by + gist) round-trips byte-identically", () => {
    const s1 = roundTrip(
      ticketSer,
      t08Bytes,
      `.planning/${EFFORT}/tickets/08-planning-card-model.md`,
    );
    assert.match(s1, /^---\ntype: grilling\nstatus: closed\nclaimed: pi\/test\nblocked by: 01\n---\n/);
    assert.match(s1, /## Resolution \(2026-08-09, grilled\)/);
  });

  it("planning-ticket (depends_on + cites edge) round-trips byte-identically", () => {
    const md = `---\ntype: task\nstatus: closed\nblocked by: 01\ndepends_on:\n  - bun-apps/hermes/src/store/card.ts\n  - docs/spec.md\n---\n# 02 — x\n\n## Resolution\nCites src/real/file.ts in body.\n`;
    const s1 = roundTrip(ticketSer, md, `.planning/rt-eff/tickets/02-x.md`);
    // depends_on is deserialize-only (graph relations); the fixed point drops
    // it — pinned here so any change to that asymmetry is a conscious edit.
    assert.doesNotMatch(s1, /depends_on/);
    assert.match(s1, /blocked by: 01/);
    assert.match(s1, /## Resolution/);
  });
});
