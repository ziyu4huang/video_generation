/**
 * SDK-contract guard — setExtensionStatus → requestRender (round-2 ticket 07,
 * carried from round-1 t06). The footer-extension-status-notify patch was
 * removed on pinned-SDK evidence that InteractiveMode.setExtensionStatus
 * ITSELF calls ui.requestRender() right after pushing the footer text. If a
 * future pi bump drops that internal call, extension status updates stop
 * re-rendering the footer and NOTHING else goes red — this test is the
 * tripwire.
 *
 * Scope: grep-level source contract against the PINNED dist resolved from
 * THIS package's dependency range (createRequire from import.meta.url — the
 * same resolution the runtime uses, so it follows update-pi.sh bumps). The
 * method body is cut at the next method-level `\n    }` close: tight enough
 * that a requestRender in some OTHER method can't satisfy it, loose enough
 * to survive cosmetic reformatting. A dist style change that breaks the
 * close-brace scan fails LOUDLY (start<end assertion) — a false red that a
 * human re-verifies beats a silent green.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { describe, expect, test } from "bun:test";

const REQUIRE = createRequire(import.meta.url);

/** The pinned pi-coding-agent's compiled interactive-mode source. */
function loadPinnedInteractiveMode(): string {
	const pkgJson = REQUIRE.resolve("@earendil-works/pi-coding-agent/package.json");
	return readFileSync(
		join(dirname(pkgJson), "dist", "modes", "interactive", "interactive-mode.js"),
		"utf8",
	);
}

describe("SDK contract: InteractiveMode.setExtensionStatus triggers a render", () => {
	test("the pinned dist's setExtensionStatus body calls requestRender", () => {
		const dist = loadPinnedInteractiveMode();
		const start = dist.indexOf("setExtensionStatus(");
		expect(
			start,
			"pi-coding-agent dist no longer defines setExtensionStatus — the footer " +
				"status contract changed; re-verify whether the s2-agent footer needs a " +
				"patch again (see round-1 t06 / round-2 ticket 07)",
		).toBeGreaterThanOrEqual(0);

		const end = dist.indexOf("\n    }", start);
		expect(end, "could not locate the method's closing brace — dist style changed; " +
			"re-verify the contract and adjust the scan").toBeGreaterThan(start);

		const body = dist.slice(start, end);
		expect(
			body.includes("requestRender"),
			"setExtensionStatus no longer calls requestRender in the pinned " +
				"pi-coding-agent dist — extension status updates would stop re-rendering " +
				"the footer. Restore the render call upstream or reintroduce the s2-agent " +
				"footer-extension-status-notify patch (removed on the old evidence).",
		).toBe(true);
	});
});
