import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseShConfig } from "../scripts/lib/config.ts";
import {
	HOST_API,
	HOST_MODULE_IDS,
} from "../../pi-agent/src/sh/host-modules.ts";

const BUN_APPS = join(import.meta.dir, "..", "..");

// Fixtures are REGISTRY-shaped (pi-agent.registry.yaml, parsed by
// run-dir/registry.ts): deploy knobs live under `deploy:`, per-extension
// deploy fields under a `deploy:` block, and every entry that does not ship
// needs an `excludeReason` saying why. parseShConfig is a pure projection on
// top of parseRegistry — schema validation is owned (and tested) there.
const MINIMAL = `
deploy:
  outRoot: ~/proj/dist/pi-agent-sh
hostApi: 2
hostModules: ["typebox"]
extensions:
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
    load: static
    deploy:
      order: 10
`;

describe("parseShConfig", () => {
	test("parses a minimal registry and expands ~", () => {
		const cfg = parseShConfig(MINIMAL, { bunAppsDir: BUN_APPS });
		expect(cfg.outRoot).toBe(join(homedir(), "proj/dist/pi-agent-sh"));
		expect(cfg.hostApi).toBe(2);
		expect(cfg.extensions).toHaveLength(1);
	});

	test("applies defaults", () => {
		const cfg = parseShConfig(MINIMAL, { bunAppsDir: BUN_APPS });
		expect(cfg.freeze).toBe(true);
		expect(cfg.current).toBe(true);
		expect(cfg.version).toEqual({ from: "package.json", gitSha: true });
		expect(cfg.extensions[0]!.order).toBe(10);
		expect(cfg.extensions[0]!.skills).toEqual([]);
		expect(cfg.extensions[0]!.copy).toEqual([]);
		expect(cfg.extensions[0]!.externals).toEqual([]);
		expect(cfg.extensions[0]!.vendor).toEqual([]);
		expect(cfg.extensions[0]!.enabled).toBe(true);
	});

	test("projects the deploy block", () => {
		const cfg = parseShConfig(
			`
deploy:
  outRoot: /tmp/out
hostApi: 2
hostModules: ["typebox"]
extensions:
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
    load: static
    skills: true
    deploy:
      order: 100
      vendor: ["playwright-core"]
      externals: ["chromium-bidi/*"]
`,
			{ bunAppsDir: BUN_APPS },
		);
		expect(cfg.extensions[0]!.vendor).toEqual(["playwright-core"]);
		expect(cfg.extensions[0]!.externals).toEqual(["chromium-bidi/*"]);
		expect(cfg.extensions[0]!.skills).toEqual(["skills"]);
	});

	test("drops entries without a deploy block (excludeReason keeps them local)", () => {
		const cfg = parseShConfig(
			`${MINIMAL}
  - name: file2md
    package: pi-agent-ext-file2md
    entry: extensions/file2md.ts
    load: static
    excludeReason: mupdf native/wasm + LM Studio dependency — not portable
`,
			{ bunAppsDir: BUN_APPS },
		);
		expect(cfg.extensions.map((e) => e.name)).toEqual(["power-tool"]);
	});

	test("drops entries with deploy.enabled: false", () => {
		const cfg = parseShConfig(`${MINIMAL}      enabled: false\n`, {
			bunAppsDir: BUN_APPS,
		});
		expect(cfg.extensions).toEqual([]);
	});

	test("sorts the shipped set by deploy order", () => {
		const cfg = parseShConfig(
			`
deploy:
  outRoot: /tmp/out
hostApi: 2
hostModules: ["typebox"]
extensions:
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
    load: static
    deploy:
      order: 100
  - name: task
    package: pi-agent-ext-task
    entry: extensions/task.ts
    load: static
    deploy:
      order: 10
`,
			{ bunAppsDir: BUN_APPS },
		);
		expect(cfg.extensions.map((e) => e.name)).toEqual(["task", "power-tool"]);
	});

	test("rejects a non-array externals (validation lives in parseRegistry)", () => {
		expect(() =>
			parseShConfig(`${MINIMAL}      externals: nope\n`, {
				bunAppsDir: BUN_APPS,
			}),
		).toThrow(/externals must be an array/);
	});

	test("the real repo registry parses and matches the core's host contract", () => {
		const text = readFileSync(
			join(BUN_APPS, "pi-agent", "pi-agent.registry.yaml"),
			"utf8",
		);
		const cfg = parseShConfig(text, { bunAppsDir: BUN_APPS });
		expect(cfg.hostApi).toBe(HOST_API);
		expect([...cfg.hostModules].sort()).toEqual([...HOST_MODULE_IDS].sort());
		expect(cfg.extensions.map((e) => e.name).sort()).toEqual([
			"btw",
			"hermes-memory",
			"hyperframes",
			"knowledge-card",
			"obsidian",
			"power-tool",
			"prompt-history",
			"subagent",
			"superpowers",
			"task",
			"wayfind",
			"web-access",
			"webui",
			"workflow",
		]);
		// subagent must load before workflow (registry population order).
		const order = (name: string) =>
			cfg.extensions.find((e) => e.name === name)!.order;
		expect(order("subagent")).toBeLessThan(order("workflow"));
	});
});

describe("copy", () => {
	const base = (extra: string) => `
deploy:
  outRoot: /tmp/out
hostApi: 2
hostModules: ["@earendil-works/pi-coding-agent"]
extensions:
  - name: wayfind
    package: pi-agent-ext-wayfind
    entry: extensions/wayfind.ts
    load: static
    deploy:
      order: 40
${extra}
`;

	test("defaults to an empty list", () => {
		const cfg = parseShConfig(base(""), { bunAppsDir: BUN_APPS });
		expect(cfg.extensions[0]!.copy).toEqual([]);
	});

	test("parses a declared list", () => {
		const cfg = parseShConfig(base(`      copy: [procedures]`), {
			bunAppsDir: BUN_APPS,
		});
		expect(cfg.extensions[0]!.copy).toEqual(["procedures"]);
	});

	test("rejects a non-array copy", () => {
		expect(() =>
			parseShConfig(base(`      copy: procedures`), { bunAppsDir: BUN_APPS }),
		).toThrow(/copy must be an array/);
	});
});

describe("vendor", () => {
	const base = (extra: string) => `
deploy:
  outRoot: /tmp/out
hostApi: 2
hostModules: ["@earendil-works/pi-coding-agent"]
extensions:
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
    load: static
    deploy:
      order: 100
${extra}
`;

	test("defaults to an empty list", () => {
		const cfg = parseShConfig(base(""), { bunAppsDir: BUN_APPS });
		expect(cfg.extensions[0]!.vendor).toEqual([]);
	});

	test("parses a declared list", () => {
		const cfg = parseShConfig(base(`      vendor: ["playwright-core"]`), {
			bunAppsDir: BUN_APPS,
		});
		expect(cfg.extensions[0]!.vendor).toEqual(["playwright-core"]);
	});

	test("rejects a non-array vendor", () => {
		expect(() =>
			parseShConfig(base(`      vendor: "playwright-core"`), {
				bunAppsDir: BUN_APPS,
			}),
		).toThrow(/vendor must be an array/);
	});
});
