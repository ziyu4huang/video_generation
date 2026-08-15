/**
 * cli-argv.test.ts — pure argv-classification helpers for cli.ts's pre-patch
 * intercepts (src/cli-argv.ts). Covers the v2 webui optionality flags
 * (architecture v2 §3.1) plus the pre-existing suppression/override helpers.
 */
import { describe, expect, it } from "bun:test";
import {
	overriddenStaticExtensions,
	userExtensionPaths,
	userSuppressFlags,
	webuiFlags,
} from "../cli-argv.ts";

describe("webuiFlags", () => {
	it("default: enabled, no port, argv unchanged", () => {
		expect(webuiFlags([])).toEqual({ disabled: false, port: null, rest: [] });
		expect(webuiFlags(["-p", "hi"]).rest).toEqual(["-p", "hi"]);
	});

	it("--no-webui disables and is stripped from rest", () => {
		const f = webuiFlags(["--no-webui", "-p", "hi"]);
		expect(f.disabled).toBe(true);
		expect(f.port).toBeNull();
		expect(f.rest).toEqual(["-p", "hi"]);
	});

	it("--webui-port <n> pins the port and strips BOTH tokens", () => {
		const f = webuiFlags(["--webui-port", "8787", "-p", "hi"]);
		expect(f.disabled).toBe(false);
		expect(f.port).toBe("8787");
		expect(f.rest).toEqual(["-p", "hi"]); // the value token is consumed, not leaked to pi
	});

	it("--webui-port=<n> form works", () => {
		const f = webuiFlags(["--webui-port=8787"]);
		expect(f.port).toBe("8787");
		expect(f.rest).toEqual([]);
	});

	it("--webui-port with a following flag (no value) -> port stays null, flag stripped", () => {
		const f = webuiFlags(["--webui-port", "--no-webui"]);
		expect(f.port).toBeNull();
		expect(f.disabled).toBe(true);
		expect(f.rest).toEqual([]);
	});

	it("--webui-port with an empty value -> null (resolver falls back)", () => {
		const f = webuiFlags(["--webui-port="]);
		expect(f.port).toBeNull();
	});

	it("combination: --no-webui --webui-port 0 strips both and keeps unrelated tokens", () => {
		const f = webuiFlags(["-e", "x.ts", "--no-webui", "--webui-port", "0", "--offline"]);
		expect(f.disabled).toBe(true);
		expect(f.port).toBe("0");
		expect(f.rest).toEqual(["-e", "x.ts", "--offline"]);
	});
});

describe("userSuppressFlags + userExtensionPaths + overriddenStaticExtensions", () => {
	it("detects -ne / --no-extensions and -ns / --no-skills", () => {
		expect(userSuppressFlags([])).toEqual({ noExtensions: false, noSkills: false });
		expect(userSuppressFlags(["-ne"])).toEqual({ noExtensions: true, noSkills: false });
		expect(userSuppressFlags(["--no-extensions", "--no-skills"])).toEqual({
			noExtensions: true,
			noSkills: true,
		});
	});

	it("collects -e / --extension path pairs", () => {
		expect(userExtensionPaths(["-e", "a.ts", "--extension", "b.ts", "x"])).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	it("overriddenStaticExtensions matches whole path segments", () => {
		const names = ["pi-agent-ext-hermes-memory", "pi-agent-ext-webui"];
		expect(
			overriddenStaticExtensions(["-e", "~/dev/pi-agent-ext-hermes-memory/extensions/hermes-memory.ts"], names),
		).toEqual(new Set(["pi-agent-ext-hermes-memory"]));
		// substring must NOT match (-v2 suffix)
		expect(
			overriddenStaticExtensions(["-e", "~/dev/pi-agent-ext-hermes-memory-v2/x.ts"], names),
		).toEqual(new Set());
	});
});
