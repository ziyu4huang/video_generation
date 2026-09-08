/**
 * e2e-preflight unit tests — the MC-1 credential gate's pure resolvers.
 *
 * Hermetic by construction: env and the rc reader are injected fakes — no test
 * reads the operator's real ~/.zshrc or ambient environment (#2186 discipline).
 * The bash-gate parity contract (ambient wins; LAST `export VAR=` across the rc
 * files wins; quotes stripped) is what makes a true-negative preflight safe.
 */
import { describe, expect, test } from "bun:test";
import {
	E2E_RC_FILES,
	preflightE2eLane,
	resolveRcApiKey,
} from "../src/e2e-preflight.ts";

/** rc reader from an in-memory map of file → lines (undefined = unreadable). */
const rcReaderFrom =
	(files: Record<string, string[] | undefined>): ((f: string) => string[] | undefined) =>
	(f) =>
		files[f];

const HOME_FILES = (map: Record<string, string>): Record<string, string[] | undefined> => {
	const out: Record<string, string[] | undefined> = {};
	for (const [name, text] of Object.entries(map)) out[`.${name}`] = text.split("\n");
	return out;
};

describe("resolveRcApiKey — bash resolve_gate_api_key parity", () => {
	test("ambient env wins over rc files", () => {
		const read = rcReaderFrom(HOME_FILES({ zshrc: 'export DEEPSEEK_API_KEY="from-rc"' }));
		expect(resolveRcApiKey({ DEEPSEEK_API_KEY: "from-env" }, read, "DEEPSEEK_API_KEY")).toBe(
			"from-env",
		);
	});

	test("last export across rc files wins; earlier files lose", () => {
		const read = rcReaderFrom(
			HOME_FILES({
				zshrc: 'export DEEPSEEK_API_KEY="old"\nexport EDITOR=vim',
				bashrc: "# no key here",
				bash_profile: "export DEEPSEEK_API_KEY='newer'",
			}),
		);
		expect(resolveRcApiKey({}, read, "DEEPSEEK_API_KEY")).toBe("newer");
	});

	test("quotes stripped, indented exports matched, non-export lines ignored", () => {
		const read = rcReaderFrom(
			HOME_FILES({
				zshrc: [
					'DEEPSEEK_API_KEY="not-an-export"',
					'  export  DEEPSEEK_API_KEY="indented"', // multiple spaces before export
					'exportother="decoy"',
				].join("\n"),
			}),
		);
		expect(resolveRcApiKey({}, read, "DEEPSEEK_API_KEY")).toBe("indented");
	});

	test("unreadable/absent rc files are skipped, not fatal", () => {
		const read = rcReaderFrom({ ".bashrc": undefined });
		expect(resolveRcApiKey({}, read, "DEEPSEEK_API_KEY", [".zshrc", ".bashrc"])).toBeUndefined();
	});
});

describe("preflightE2eLane — the four scenarios", () => {
	test("no key anywhere → fail with the copy-pasteable fix", () => {
		const result = preflightE2eLane({}, rcReaderFrom({}));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("DEEPSEEK_API_KEY");
			expect(result.message).toContain("ZAI_API_KEY");
			expect(result.message).toContain("export DEEPSEEK_API_KEY=<key>");
			expect(result.message).toContain("--assume-ci-green <sha>");
			for (const f of E2E_RC_FILES) expect(result.message).toContain(f);
		}
	});

	test("key present (env) → ok, with the unset-pin advisory", () => {
		const result = preflightE2eLane(
			{ DEEPSEEK_API_KEY: "sk-123" },
			rcReaderFrom({}),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.notes.some((n) => n.includes("VERIFY_E2E_MODEL is unset"))).toBe(true);
		}
	});

	test("key present only in an rc file → ok (the historical operator shape)", () => {
		const result = preflightE2eLane(
			{},
			rcReaderFrom(HOME_FILES({ zshrc: "export ZAI_API_KEY=zai-key" })),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.notes.some((n) => n.includes("ZAI_API_KEY"))).toBe(true);
	});

	test("malformed VERIFY_E2E_MODEL pin → fail, naming the provider/model-id form", () => {
		const result = preflightE2eLane(
			{ DEEPSEEK_API_KEY: "sk", VERIFY_E2E_MODEL: "just-a-model-id" },
			rcReaderFrom({}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("not provider/model-id");
			expect(result.message).toContain("VERIFY_E2E_MODEL=deepseek/deepseek-v4-flash-vision-exp");
		}
	});

	test("well-formed pin → ok with the pin-honored note; override vars acknowledged", () => {
		const result = preflightE2eLane(
			{
				DEEPSEEK_API_KEY: "sk",
				VERIFY_E2E_MODEL: "deepseek/deepseek-v4-flash-vision-exp",
				PI_AGENT_E2E_PROVIDER: "deepseek",
			},
			rcReaderFrom({}),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.notes.some((n) => n.includes("pin honored"))).toBe(true);
			expect(result.notes.some((n) => n.includes("PI_AGENT_E2E_PROVIDER"))).toBe(true);
		}
	});
});
