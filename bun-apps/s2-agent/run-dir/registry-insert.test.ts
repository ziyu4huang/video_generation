/**
 * appendRegistryExtension — the textual insert behind `ext new --register`.
 * TEXT SURGERY, not YAML re-serialisation: the registry's comments carry the
 * exclusion rationale (why each local extension stays local), and round-tripping
 * the file through a parser would destroy them. These tests pin the two
 * properties that make the surgery safe: the entry lands after the LAST
 * extension entry, and everything before the insertion point survives
 * byte-for-byte.
 */
import { describe, expect, test } from "bun:test";
import { appendRegistryExtension } from "./registry-insert.ts";

const FIXTURE = `# leading comment
deploy:
  outRoot: ~/proj/dist/x
hostApi: 2
hostModules: ["@earendil-works/pi-coding-agent"]
extensions:
  # comment above task, must survive byte-for-byte
  - name: task
    package: s2-agent-ext-task
    entry: extensions/task.ts
    load: static
    deploy:
      order: 10
  - name: movie-director
    package: s2-agent-ext-movie-director
    entry: extensions/movie-director.ts
    load: dynamic
    version: "0.1.0"
    # why it stays local
    excludeReason: bound to this machine's swift CLIs and services
lazyExtensions: {}
`;

const NEW_ENTRY = `  - name: probe
    package: s2-agent-ext-probe
    entry: extensions/probe.ts
    load: dynamic
    excludeReason: not yet curated for the portable set`;

describe("appendRegistryExtension", () => {
	test("inserts after the LAST extension entry, before lazyExtensions", () => {
		const out = appendRegistryExtension(FIXTURE, NEW_ENTRY);
		const lines = out.split("\n");
		const probeIdx = lines.findIndex((l) => l === "  - name: probe");
		const lazyIdx = lines.findIndex((l) => l.startsWith("lazyExtensions:"));
		const lastEntryTail = lines.findIndex((l) => l.includes("excludeReason: bound to this machine"));
		expect(probeIdx).toBeGreaterThan(-1);
		expect(lazyIdx).toBeGreaterThan(probeIdx);
		expect(probeIdx).toBe(lastEntryTail + 1);
		// the inserted entry is complete and in order
		expect(lines[probeIdx + 1]).toBe("    package: s2-agent-ext-probe");
	});

	test("everything before the insertion point survives byte-for-byte", () => {
		const out = appendRegistryExtension(FIXTURE, NEW_ENTRY);
		const upTo = out.split("\n").indexOf("  - name: probe");
		expect(out.split("\n").slice(0, upTo).join("\n")).toBe(
			FIXTURE.split("\n").slice(0, upTo).join("\n"),
		);
		// the fixture's comments specifically
		expect(out).toContain("# comment above task, must survive byte-for-byte");
		expect(out).toContain("# why it stays local");
	});

	test("a second append lands after the first appended entry", () => {
		const once = appendRegistryExtension(FIXTURE, NEW_ENTRY);
		const second = `  - name: probe2
    package: s2-agent-ext-probe2
    entry: extensions/probe2.ts
    load: static
    excludeReason: not yet curated for the portable set`;
		const twice = appendRegistryExtension(once, second);
		const lines = twice.split("\n");
		const probe2 = lines.findIndex((l) => l === "  - name: probe2");
		const probe1 = lines.findIndex((l) => l === "  - name: probe");
		const lazy = lines.findIndex((l) => l.startsWith("lazyExtensions:"));
		expect(probe2).toBeGreaterThan(probe1);
		expect(lazy).toBeGreaterThan(probe2);
	});

	test("no lazyExtensions key — appends after the last entry at EOF", () => {
		const noLazy = FIXTURE.replace("lazyExtensions: {}\n", "");
		const out = appendRegistryExtension(noLazy, NEW_ENTRY);
		const lines = out.split("\n");
		const probeIdx = lines.findIndex((l) => l === "  - name: probe");
		expect(probeIdx).toBeGreaterThan(-1);
		// nothing but the new entry (and its trailing newline) after it
		expect(lines.slice(probeIdx).join("\n")).toBe(`${NEW_ENTRY}\n`);
	});

	test("no extensions block — throws (ext new must never invent one)", () => {
		expect(() => appendRegistryExtension("deploy:\n  outRoot: ~/x\n", NEW_ENTRY)).toThrow(
			/extensions/,
		);
	});
});
