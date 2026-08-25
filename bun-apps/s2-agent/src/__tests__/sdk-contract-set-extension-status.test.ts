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
 * THIS package's dependency range. The `./package.json` subpath resolve is
 * Bun-lax (the package's exports map does not list it; Node-strict would
 * throw) — deliberate: this repo is Bun-only, and any resolution change
 * fails LOUDLY, never silently green. The method body is cut at the next
 * method-level `\n    }` close AND asserted to contain no other method
 * signature, so a requestRender in some OTHER method can't satisfy it; the
 * call itself is matched as `requestRender\s*\(` — a CALL SHAPE, not a
 * substring, so an upstream rename that merely extends the symbol
 * (requestRenderSync, requestRender2, …) goes red, which is the renaming
 * case the ticket promises to catch. A dist style change that breaks the
 * close-brace scan fails LOUDLY — a false red that a human re-verifies
 * beats a silent green.
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
	test("the pinned dist's setExtensionStatus body calls requestRender(...)", () => {
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
		// The cut must cover exactly this method — no other method signature inside.
		expect(
			/\n {4}\w+\(/.test(body) === false,
			"the scanned window swallowed a following method — dist style changed; " +
				"re-verify the contract and adjust the scan",
		).toBe(true);

		expect(
			/requestRender\s*\(/.test(body),
			"setExtensionStatus no longer CALLS requestRender(...) in the pinned " +
				"pi-coding-agent dist — extension status updates would stop re-rendering " +
				"the footer. Restore the render call upstream or reintroduce the s2-agent " +
				"footer-extension-status-notify patch (removed on the old evidence). " +
				"(Matched as a call shape, so a renamed/extended symbol fails here too.)",
		).toBe(true);
	});
});
