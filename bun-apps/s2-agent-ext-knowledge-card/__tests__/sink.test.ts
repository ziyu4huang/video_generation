import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import knowledgeCard from "../extensions/knowledge-card.ts";

/** Permissive fake pi: no-ops for on/registerTool, captures the pi:knowledge
 *  subscriber registered via onKnowledge → pi.events.on. */
function fakePi(capture: { handler?: (d: unknown) => void }) {
	return new Proxy(
		{},
		{
			get: (_t, prop) => {
				if (prop === "events")
					return {
						on: (_c: string, h: (d: unknown) => void) => {
							capture.handler = h;
							return () => {};
						},
						emit: () => {},
					};
				return () => {}; // pi.on("session_start"|"shutdown"), pi.registerTool(...)
			},
		},
	) as never;
}

const FOLDER = "Zettelkasten/knowledge-graph";

describe("pi:knowledge sink subscriber", () => {
	let vault: string;
	let src: string;
	const prevVault = process.env.OB_VAULT_PATH;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kc-sink-vault-"));
		src = mkdtempSync(join(tmpdir(), "kc-sink-src-"));
		process.env.OB_VAULT_PATH = vault;
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
		rmSync(src, { recursive: true, force: true });
		if (prevVault === undefined) delete process.env.OB_VAULT_PATH;
		else process.env.OB_VAULT_PATH = prevVault;
	});

	test("a file2md-shaped dir emission converges into the shared folder", async () => {
		writeFileSync(join(src, "page-1.md"), "# Page One\n\nbody.\n");
		const capture: { handler?: (d: unknown) => void } = {};
		knowledgeCard(fakePi(capture));
		expect(capture.handler).toBeDefined();

		// drive the subscriber with a file2md-shaped payload
		await capture.handler!({ source: "generic", sourceLabel: "file2md:doc", dir: src });

		const folder = join(vault, FOLDER);
		const cards = readdirSync(folder).filter((f) => f.endsWith(".md"));
		expect(cards.length).toBeGreaterThanOrEqual(1);
	});

	test("best-effort: a bad dir never throws from the handler", async () => {
		const capture: { handler?: (d: unknown) => void } = {};
		knowledgeCard(fakePi(capture));
		await expect(
			capture.handler!({ source: "generic", sourceLabel: "file2md:x", dir: "/no/such/dir" }),
		).resolves.toBeUndefined();
	});
});
