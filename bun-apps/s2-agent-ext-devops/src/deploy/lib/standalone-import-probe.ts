/**
 * standalone-import-probe.ts — deploy-e2e probe `standalone-import`
 * (ext-standalone-import t04).
 *
 * Proves the dist's standalone consumption surface the way a REAL consumer
 * uses it — no repo, no workspace, no network:
 *
 *   1. Writes the AGENTS.md quickstart (STANDALONE_QUICKSTART, verbatim —
 *      doc and proof share one source) into a scratch dir OUTSIDE the repo
 *      and dist trees.
 *   2. Builds a throwaway fixture git repo with a LOCAL bare origin (fully
 *      offline) and runs the quickstart there with the DEPLOYED bin/bun —
 *      proving the consumer needs no host bun either.
 *   3. In-process cross-check: file2md's OCR tool driven THROUGH the shim
 *      (loadExt → tool → execute) against the standard OCR fixture — the
 *      `#pi/ext-dir` + deployed-asset semantics must survive the shim's
 *      require chain, not just the repo-side executeExtTool path.
 *   4. Re-runs the shim's own text gates (s1b/s4) at probe time — a tree
 *      tampered with after deploy fails here.
 *
 * Verdict semantics follow the probe family: any step failing → fail; a tree
 * without the shim (pre-t02 deploy) → skip, not fail.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STANDALONE_QUICKSTART } from "./agents-md.ts";
import { gateStandaloneShim } from "./standalone-shim.ts";
import { F2MD_E2E_OCR_B64 } from "../f2md-e2e-fixture.js";

/** Mirrors DeployE2eProbe's shape (kept structural to avoid an import cycle). */
export interface StandaloneImportProbeResult {
	id: "standalone-import";
	verdict: "pass" | "skip" | "fail";
	ms: number;
	note: string;
	detail?: string;
}

/** Wall-clock cap for the quickstart subprocess (ms). */
const QUICKSTART_CAP_MS = 60_000;

/** git fixture repo + local bare origin, fully offline. Returns the repo dir. */
function makeFixtureRepo(parent: string): string {
	const repo = join(parent, "fixture-repo");
	const origin = join(parent, "fixture-origin.git");
	const git = (args: string[], cwd?: string) => {
		const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) {
			throw new Error(`git ${args[0]} failed in fixture: ${(r.stderr || r.stdout).toString().trim().slice(0, 200)}`);
		}
	};
	mkdirSync(repo, { recursive: true });
	git(["init", "-q", "-b", "main"], repo);
	git(["config", "user.email", "e2e@example.invalid"], repo);
	git(["config", "user.name", "standalone-import probe"], repo);
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "fixture init"], repo);
	// A local bare origin so sync's fetch + default-branch detection are real
	// git operations against a real remote — just never a network one.
	mkdirSync(origin, { recursive: true });
	git(["init", "-q", "--bare", "-b", "main"], origin);
	git(["remote", "add", "origin", origin], repo);
	git(["push", "-q", "origin", "main"], repo);
	return repo;
}

/**
 * Run the probe against a deployed version dir. `shippedBun` lets the caller
 * name the runtime binary (the deploy's own bin/bun); the default discovers
 * it in <versionDir>/bin — a tree without one (broken deploy) fails loudly.
 */
export async function standaloneImportProbe(
	versionDir: string,
	opts: { shippedBun?: string } = {},
): Promise<StandaloneImportProbeResult> {
	const t0 = performance.now();
	const shimPath = join(versionDir, "ext", "ext-standalone.mjs");
	const fail = (note: string, detail?: string): StandaloneImportProbeResult => ({
		id: "standalone-import",
		verdict: "fail",
		ms: performance.now() - t0,
		note,
		detail,
	});
	if (!existsSync(shimPath)) {
		return {
			id: "standalone-import",
			verdict: "skip",
			ms: 0,
			note: "ext/ext-standalone.mjs not in this tree (pre-t02 deploy)",
		};
	}

	const scratch = mkdtempSync(join(tmpdir(), "standalone-import-"));
	const details: string[] = [];
	try {
		// ── 1. the AGENTS.md quickstart, verbatim, from a scratch dir ─────────
		const script = join(scratch, "standalone-quickstart.js");
		writeFileSync(script, STANDALONE_QUICKSTART);
		const repo = makeFixtureRepo(scratch);

		const binDir = join(versionDir, "bin");
		const shippedBun =
			opts.shippedBun ?? (existsSync(binDir) ? join(binDir, readdirSync(binDir).find((n) => n.startsWith("bun")) ?? "") : "");
		if (!shippedBun || !existsSync(shippedBun)) {
			return fail("no shipped runtime under <versionDir>/bin to run the consumer with", `looked in ${binDir}`);
		}

		const child = Bun.spawn([shippedBun, script, shimPath], {
			cwd: repo, // sync_default_branch resolves the repo from the consumer's cwd
			stdout: "pipe",
			stderr: "pipe",
		});
		const killer = setTimeout(() => child.kill(), QUICKSTART_CAP_MS);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		clearTimeout(killer);
		if (code !== 0) {
			return fail(`quickstart subprocess exited ${code}`, `${stdout.slice(-500)}\n${stderr.slice(-500)}`);
		}
		// The quickstart prints one JSON object; find it tolerantly (warnings
		// may precede it on stdout).
		const jsonStart = stdout.indexOf("{");
		const parsed = JSON.parse(stdout.slice(jsonStart)) as {
			exts?: string;
			devopsTools?: string;
			sync?: { ok?: boolean; mode?: string; commands?: number };
		};
		if (!parsed.exts || !parsed.devopsTools?.includes("sync_default_branch") || parsed.sync?.ok !== true) {
			return fail("quickstart output missing expected shape", stdout.slice(-800));
		}
		details.push(`quickstart: exts=${parsed.exts.split(",").length}, sync commands=${parsed.sync.commands}`);

		// ── 2. file2md through the SHIM (in-process cross-check) ─────────────
		if (existsSync(join(versionDir, "ext", "file2md", "ext.cjs"))) {
			const { loadExt } = (await import(shimPath)) as { loadExt: (name: string) => { tool: (n: string) => { execute: (...a: unknown[]) => Promise<unknown> } } };
			const fixturePath = join(scratch, "f2md-e2e.png");
			writeFileSync(fixturePath, Buffer.from(F2MD_E2E_OCR_B64, "base64"));
			const outDir = join(scratch, "f2md-out");
			const ext = loadExt("file2md");
			const r = (await ext.tool("file2md").execute("standalone-probe", {
				input: fixturePath,
				out: outDir,
				mode: "ocr",
				lang: "en",
			})) as { details?: { provenance?: string } };
			const pageMd = readFileSync(join(outDir, "f2md-e2e", "pages", "page-001.md"), "utf8");
			if (!pageMd.includes("FILE2MD E2E OCR") || !pageMd.includes("provenance: ocr")) {
				return fail("file2md through the shim lost the fixture text or provenance", pageMd.slice(0, 400));
			}
			details.push("file2md via shim: OCR fixture + provenance ok");
		} else {
			details.push("file2md not in deploy set — cross-check skipped");
		}

		// ── 3. the shim's text gates, re-run at probe time ───────────────────
		gateStandaloneShim(shimPath, versionDir);
		details.push("gate re-check (s1b/s4) clean");

		return {
			id: "standalone-import",
			verdict: "pass",
			ms: performance.now() - t0,
			note: `standalone import proven from scratch dir (${details.join("; ")})`,
		};
	} catch (e) {
		return fail(`execution failed: ${e instanceof Error ? e.message : String(e)}`, details.join("\n"));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
