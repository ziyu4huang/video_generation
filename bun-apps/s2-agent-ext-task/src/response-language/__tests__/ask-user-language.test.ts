/**
 * Smoke test for the ask-user-language registrar: it registers exactly one
 * command named "ask-user-language". Mirrors entry.test.ts (the registration
 * shape is covered here; the decision logic is covered by command.test.ts and
 * the merge/validation by settings.test.ts). A dispatch smoke test asserts the
 * wiring (decideCommand → writeLanguageKey) writes the askUserLanguage key and
 * notifies the user, mirroring how /response-language behaves end-to-end.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserLanguage } from "../ask-user-language.js";

interface CapturedCommand {
	name: string;
	description: string;
	handler: (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => Promise<void>;
}

function fakePi() {
	const commands: CapturedCommand[] = [];
	const pi = {
		registerCommand: (name: string, options: Omit<CapturedCommand, "name">) =>
			commands.push({ name, ...options }),
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

describe("registerAskUserLanguage", () => {
	test("registers exactly the ask-user-language command", () => {
		const { pi, commands } = fakePi();
		registerAskUserLanguage(pi);
		expect(commands.map((c) => c.name)).toEqual(["ask-user-language"]);
	});

	test("the command has a non-empty description", () => {
		const { pi, commands } = fakePi();
		registerAskUserLanguage(pi);
		expect(commands[0]!.description.length).toBeGreaterThan(0);
	});

	describe("handler dispatch (decideCommand → writeLanguageKey)", () => {
		let tmp: string;
		let prevDir: string | undefined;

		beforeEach(() => {
			tmp = mkdtempSync(join(tmpdir(), "pi-ask-user-lang-"));
			prevDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = tmp;
		});

		afterEach(() => {
			if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevDir;
			rmSync(tmp, { recursive: true, force: true });
		});

		test("dispatching a valid tag writes askUserLanguage to settings + notifies", async () => {
			const { pi, commands } = fakePi();
			registerAskUserLanguage(pi);
			const notifies: Array<{ msg: string; level: string }> = [];
			const ctx = { ui: { notify: (msg: string, level: string) => notifies.push({ msg, level }) } };

			await commands[0]!.handler("zh-TW", ctx);

			const written = JSON.parse(readFileSync(join(tmp, "settings.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(written.askUserLanguage).toBe("zh-TW");
			expect(notifies.some((n) => n.msg.includes("zh-TW"))).toBe(true);
		});

		test("dispatching an invalid tag does NOT write + warns", async () => {
			const { pi, commands } = fakePi();
			registerAskUserLanguage(pi);
			const notifies: Array<{ msg: string; level: string }> = [];
			const ctx = { ui: { notify: (msg: string, level: string) => notifies.push({ msg, level }) } };

			await commands[0]!.handler("bad tag", ctx);

			let exists = false;
			try {
				readFileSync(join(tmp, "settings.json"), "utf8");
				exists = true;
			} catch {
				exists = false;
			}
			expect(exists).toBe(false);
			expect(notifies.some((n) => n.level === "warning")).toBe(true);
		});

		test("dispatching with no arg shows the current (unset) value, no write", async () => {
			const { pi, commands } = fakePi();
			registerAskUserLanguage(pi);
			const notifies: Array<{ msg: string; level: string }> = [];
			const ctx = { ui: { notify: (msg: string, level: string) => notifies.push({ msg, level }) } };

			await commands[0]!.handler("", ctx);

			let exists = false;
			try {
				readFileSync(join(tmp, "settings.json"), "utf8");
				exists = true;
			} catch {
				exists = false;
			}
			expect(exists).toBe(false);
			expect(notifies.some((n) => /not set/i.test(n.msg))).toBe(true);
		});
	});
});
