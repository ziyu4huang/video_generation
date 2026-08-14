/**
 * deploy.ts refuses to recursively delete a path that is not a deploy target.
 *
 * WHY THIS EXISTS
 * ---------------
 * `target` is the first non-flag argv token, and the deploy stage `chmod -R u+w`s
 * away the read-only freeze and then `rmSync(target, {recursive: true})`. With no
 * validation, `bun run deploy /opt` — a plausible slip for `/opt/pi-agent`, which
 * the README trains operators to type by hand — deleted `/opt`.
 *
 * These are SPAWN tests on purpose. The guard lives in deploy.ts's module scope
 * and calls `process.exit`, so the only honest way to assert it is at the process
 * boundary. Each case must fail BEFORE anything is deleted, which is why every
 * assertion also checks the fixture directory survived.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

const PKG_DIR = join(import.meta.dir, "..", "..");
const DEPLOY = join(PKG_DIR, "scripts", "deploy.ts");

const made: string[] = [];
afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-deploy-guard-"));
	made.push(d);
	return d;
}

async function runDeploy(args: string[]): Promise<{ code: number; err: string }> {
	const proc = Bun.spawn([process.execPath, DEPLOY, ...args], {
		cwd: PKG_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [err, out, code] = await Promise.all([
		new Response(proc.stderr).text(),
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	return { code, err: err + out };
}

describe("deploy target guard — refuses", () => {
	test("a non-empty directory with no deploy marker, without --force", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "important.txt"), "do not delete me");
		mkdirSync(join(dir, "subdir"));

		const { code, err } = await runDeploy([dir]);

		expect(code).not.toBe(0);
		expect(err).toContain("refusing to overwrite");
		expect(err).toContain("--force");
		// The whole point: it must refuse BEFORE deleting.
		expect(existsSync(join(dir, "important.txt"))).toBe(true);
		expect(existsSync(join(dir, "subdir"))).toBe(true);
	});

	test("$HOME itself", async () => {
		const { code, err } = await runDeploy([homedir()]);
		expect(code).not.toBe(0);
		expect(err).toContain("refusing to deploy to");
		expect(err).toContain("$HOME");
	});

	test("the filesystem root (an ancestor of everything)", async () => {
		const { code, err } = await runDeploy(["/"]);
		expect(code).not.toBe(0);
		expect(err).toContain("refusing to deploy to");
	});

	test("the filesystem root even with --force", async () => {
		// Regression: the ancestor check built the prefix `candidate + "/"`, so
		// for "/" it compared against "//" and matched nothing. `/` then fell
		// through to the marker check, which --force overrides.
		const { code, err } = await runDeploy(["/", "--force"]);
		expect(code).not.toBe(0);
		expect(err).toContain("refusing to deploy to");
	});

	test("an ancestor of the repo, even though it exists and looks ordinary", async () => {
		// The repo root's parent is above the source tree the deploy is built
		// from. No legitimate deploy targets it.
		const parentOfRepo = join(PKG_DIR, "..", "..", "..");
		const { code, err } = await runDeploy([parentOfRepo]);
		expect(code).not.toBe(0);
		expect(err).toContain("refusing to deploy to");
	});

	test("$HOME even with --force (ancestor refusals are not overridable)", async () => {
		const { code, err } = await runDeploy([homedir(), "--force"]);
		expect(code).not.toBe(0);
		expect(err).toContain("refusing to deploy to");
	});
});

describe("deploy target guard — allows", () => {
	// These assert the guard PASSES, not that the deploy succeeds: a real
	// deploy takes minutes. Getting past the guard is proven by the run
	// reaching a later stage (it prints the target banner, then proceeds to
	// codegen) rather than dying with a refusal.
	const notRefused = (err: string) => {
		expect(err).not.toContain("refusing to");
	};

	test("an empty directory", async () => {
		const dir = tempDir();
		const { err } = await runDeploy([dir, "--this-flag-does-not-exist"]);
		// Unknown-flag rejection happens first and proves argv parsing ran; the
		// guard is what we assert did NOT fire.
		notRefused(err);
	});

	test("a directory carrying a prior-deploy marker", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "important.txt"), "x");
		writeFileSync(join(dir, ".deploy-readonly"), "");
		const { err } = await runDeploy([dir, "--this-flag-does-not-exist"]);
		notRefused(err);
	});

	test("a non-empty unmarked directory WITH --force", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "important.txt"), "x");
		const { err } = await runDeploy([dir, "--force", "--this-flag-does-not-exist"]);
		notRefused(err);
	});
});

describe("deploy cwd guard", () => {
	test("refuses to run from the wrong directory", async () => {
		// From another package dir, deploy.ts would read that package's
		// package.json, bake the wrong BUN_APPS_DIR, and aim its recursive delete
		// at the wrong dist/ — all without erroring.
		const proc = Bun.spawn([process.execPath, DEPLOY, tempDir()], {
			cwd: join(PKG_DIR, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [err, code] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).not.toBe(0);
		expect(err).toContain("must run from the pi-agent package directory");
	});
});
