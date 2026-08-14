import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healInterruptedSwap } from "./deploy-swap.ts";

describe("healInterruptedSwap", () => {
	test("restores FINAL_OUTDIR from .prev when a prior swap was interrupted", () => {
		const root = mkdtempSync(join(tmpdir(), "deploy-swap-test-"));
		try {
			const finalOutdir = join(root, "pi-agent-bundle");
			const prev = `${finalOutdir}.prev`;
			mkdirSync(prev, { recursive: true });
			writeFileSync(join(prev, "marker.txt"), "last-good-deploy");

			const healed = healInterruptedSwap(finalOutdir);

			expect(healed).toBe(true);
			expect(existsSync(finalOutdir)).toBe(true);
			expect(existsSync(join(finalOutdir, "marker.txt"))).toBe(true);
			expect(existsSync(prev)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("cleans up a stale .prev left over from an interrupted cleanup step, when FINAL_OUTDIR already exists", () => {
		const root = mkdtempSync(join(tmpdir(), "deploy-swap-test-"));
		try {
			const finalOutdir = join(root, "pi-agent-bundle");
			const prev = `${finalOutdir}.prev`;
			mkdirSync(finalOutdir, { recursive: true });
			writeFileSync(join(finalOutdir, "marker.txt"), "current-deploy");
			mkdirSync(prev, { recursive: true });
			writeFileSync(join(prev, "marker.txt"), "stale-prior-deploy");

			const healed = healInterruptedSwap(finalOutdir);

			expect(healed).toBe(true);
			expect(existsSync(finalOutdir)).toBe(true);
			expect(readFileSync(join(finalOutdir, "marker.txt"), "utf8")).toBe("current-deploy");
			expect(existsSync(prev)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("is a no-op when FINAL_OUTDIR already exists", () => {
		const root = mkdtempSync(join(tmpdir(), "deploy-swap-test-"));
		try {
			const finalOutdir = join(root, "pi-agent-bundle");
			mkdirSync(finalOutdir, { recursive: true });
			const healed = healInterruptedSwap(finalOutdir);
			expect(healed).toBe(false);
			expect(existsSync(finalOutdir)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("is a no-op when neither dir exists (first-ever deploy)", () => {
		const root = mkdtempSync(join(tmpdir(), "deploy-swap-test-"));
		try {
			const finalOutdir = join(root, "pi-agent-bundle");
			expect(healInterruptedSwap(finalOutdir)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
