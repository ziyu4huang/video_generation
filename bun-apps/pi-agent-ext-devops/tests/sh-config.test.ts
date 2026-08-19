import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseShConfig } from "../scripts/lib/sh-config.ts";
import { HOST_API, HOST_MODULE_IDS } from "../../pi-agent/src/sh/host-modules.ts";

const BUN_APPS = join(import.meta.dir, "..", "..");

const MINIMAL = `
outRoot: ~/proj/dist/pi-agent-sh
hostApi: 1
hostModules: ["typebox"]
extensions:
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
`;

describe("parseShConfig", () => {
	test("parses a minimal config and expands ~", () => {
		const cfg = parseShConfig(MINIMAL, { bunAppsDir: BUN_APPS });
		expect(cfg.outRoot).toBe(join(homedir(), "proj/dist/pi-agent-sh"));
		expect(cfg.hostApi).toBe(1);
		expect(cfg.extensions).toHaveLength(1);
	});

	test("applies defaults", () => {
		const cfg = parseShConfig(MINIMAL, { bunAppsDir: BUN_APPS });
		expect(cfg.freeze).toBe(true);
		expect(cfg.current).toBe(true);
		expect(cfg.version).toEqual({ from: "package.json", gitSha: true });
		expect(cfg.extensions[0]!.order).toBe(100);
		expect(cfg.extensions[0]!.skills).toEqual([]);
		expect(cfg.extensions[0]!.externals).toEqual([]);
	});

	test("parses declared runtime externals", () => {
		const cfg = parseShConfig(`${MINIMAL}    externals: ["playwright-core"]\n`, { bunAppsDir: BUN_APPS });
		expect(cfg.extensions[0]!.externals).toEqual(["playwright-core"]);
	});

	test("rejects a non-array externals", () => {
		expect(() => parseShConfig(`${MINIMAL}    externals: nope\n`, { bunAppsDir: BUN_APPS })).toThrow(
			/externals must be an array/,
		);
	});

	test("rejects an unknown top-level key", () => {
		expect(() => parseShConfig(`${MINIMAL}\nfreze: true\n`, { bunAppsDir: BUN_APPS })).toThrow(
			/unknown config key "freze"/,
		);
	});

	test("rejects an unknown extension key", () => {
		const bad = MINIMAL.replace(
			"entry: extensions/power-tool.ts",
			"entry: extensions/power-tool.ts\n    skils: [skills]",
		);
		expect(() => parseShConfig(bad, { bunAppsDir: BUN_APPS })).toThrow(/unknown extension key "skils"/);
	});

	test("rejects a package that does not exist under bun-apps", () => {
		const bad = MINIMAL.replace("pi-agent-ext-power-tool", "pi-agent-ext-nope");
		expect(() => parseShConfig(bad, { bunAppsDir: BUN_APPS })).toThrow(/pi-agent-ext-nope/);
	});

	test("rejects an entry file that does not exist", () => {
		const bad = MINIMAL.replace("extensions/power-tool.ts", "extensions/ghost.ts");
		expect(() => parseShConfig(bad, { bunAppsDir: BUN_APPS })).toThrow(/ghost\.ts/);
	});

	test("rejects duplicate extension names", () => {
		const dup = `${MINIMAL}
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
`;
		expect(() => parseShConfig(dup, { bunAppsDir: BUN_APPS })).toThrow(/duplicate extension name/);
	});

	test("rejects an empty extensions list", () => {
		expect(() =>
			parseShConfig(`outRoot: /tmp/x\nhostApi: 1\nhostModules: ["typebox"]\nextensions: []\n`, {
				bunAppsDir: BUN_APPS,
			}),
		).toThrow(/at least one extension/);
	});

	test("the real repo config parses and matches the core's host contract", () => {
		const text = readFileSync(join(BUN_APPS, "pi-agent", "deploy-config.yaml"), "utf8");
		const cfg = parseShConfig(text, { bunAppsDir: BUN_APPS });
		expect(cfg.hostApi).toBe(HOST_API);
		expect([...cfg.hostModules].sort()).toEqual([...HOST_MODULE_IDS].sort());
		expect(cfg.extensions.map((e) => e.name).sort()).toEqual([
			"hyperframes",
			"power-tool",
			"task",
		]);
	});
});
