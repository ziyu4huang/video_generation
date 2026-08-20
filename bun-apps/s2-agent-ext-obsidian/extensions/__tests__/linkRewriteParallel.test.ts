/**
 * Characterization test for the inbound-link rewrite path in moveNote/deleteNote.
 *
 * Purpose: lock the "every inbound [[link]] is rewritten across N source notes"
 * contract BEFORE the per-source loop is parallelized (Task 17 / Phase 2). The
 * current sequential implementation already satisfies these assertions; this
 * test exists so a `Promise.all` refactor can't regress the fan-out semantics
 * (all sources rewritten, failedSources populated only on a genuine throw).
 *
 * Fixture note: the plan referenced `getVault`/`cleanupVault` (./_vault-fixture.ts)
 * and a `create` helper (./_fakes.ts). Neither exists in this repo —
 * `_vault-fixture.ts` only exposes submodule-availability gates. So we inline a
 * minimal REAL temp-vault (mkdtemp + Bun.write), mirroring the filesystem-backed
 * pattern other tests use.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveNote, deleteNote } from "../../src/obsidian-lib.ts";

const tmpRoots: string[] = [];

async function newVault(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `obs-link-${prefix}-`));
	tmpRoots.push(root);
	return root;
}

async function write(vault: string, rel: string, body: string): Promise<void> {
	await Bun.write(join(vault, rel), body);
}

afterEach(async () => {
	await Promise.all(
		tmpRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
	);
});

describe("parallel link rewrite", () => {
	test("moveNote rewrites ALL inbound [[links]] across many source notes", async () => {
		const v = await newVault("move");
		// Seed: a target note + 6 source notes, each linking [[target]] (bare
		// AND alias forms) so we exercise both rewrite paths.
		await write(v, "target.md", "# Target\n");
		for (let i = 0; i < 6; i++) {
			await write(v, `src${i}.md`, `# Src ${i}\nSee [[target]] and [[target|alias]].\n`);
		}

		const res = await moveNote(v, "target.md", "renamed.md");

		// Every source was rewritten; none threw.
		expect(res.failedSources).toEqual([]);
		expect(res.linksRewritten).toHaveLength(6);
		expect(res.moved).toBe(true);
		expect(res.from).toBe("target.md");
		expect(res.to).toBe("renamed.md");

		// The file physically moved.
		expect(await Bun.file(join(v, "renamed.md")).text()).toContain("# Target");
		expect(await Bun.file(join(v, "target.md")).exists()).toBe(false);

		// Every source now links [[renamed]] (bare + alias) and retains NO
		// [[target reference at all.
		for (let i = 0; i < 6; i++) {
			const body = await Bun.file(join(v, `src${i}.md`)).text();
			expect(body).toContain("[[renamed]]");
			expect(body).toContain("[[renamed|alias]]");
			expect(body).not.toContain("[[target");
		}
	});

	test("deleteNote strips inbound [[links]] from all source notes", async () => {
		const v = await newVault("del");
		await write(v, "victim.md", "# Victim\nbody\n");
		for (let i = 0; i < 6; i++) {
			await write(v, `d${i}.md`, `# D ${i}\nbefore [[victim]] after\n`);
		}

		const res = await deleteNote(v, "victim.md", { cleanupLinks: true });

		// File gone; every source cleaned; return shape intact.
		expect(await Bun.file(join(v, "victim.md")).exists()).toBe(false);
		expect(res.deleted).toBe(true);
		expect(res.note).toBe("victim.md");
		expect(res.linksCleaned).toHaveLength(6);
		for (let i = 0; i < 6; i++) {
			const body = await Bun.file(join(v, `d${i}.md`)).text();
			expect(body).not.toContain("[[victim]]");
		}
	});
});
