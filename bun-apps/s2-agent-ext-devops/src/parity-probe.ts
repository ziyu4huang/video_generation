/**
 * parity-probe — the dev↔deploy surface fingerprint probe.
 *
 * WHY THIS EXISTS
 * ----------------
 * verify-deploy-e2e probes the dist IN ISOLATION (core builtins present,
 * deploy.json set reports loaded). Nothing diffs the dist against the dev
 * tree. Three incident classes motivated this (spec 2026-08-31): the silent
 * `-e` skip (host-module-map miss), #1946 (toolless deploys past every
 * isolated gate), and bundled-vs-discovered skill precedence. Survey
 * 2026-08-31 measured same-commit parity holding (tools 64⊂88, 0 hash
 * diffs, providers identical) — this probe makes that a checked invariant.
 *
 * The probe source itself must import NOTHING: it is written to a tmpdir and
 * loaded by the target launcher's own bun (deployed trees resolve `-e`
 * imports against a fixed host-module map — see TOOLS_ACTIVE_PROBE).
 *
 * ORDERING (tools-active-probe precedent): `-e` probes load FIRST, so
 * session_start here fires before other extensions' handlers. That is fine
 * for the REGISTRATION surface (getAllTools reads what loaded, not the
 * active set); skills are read at before_agent_start, after all load-time
 * handlers ran. The exit happens before any provider response is awaited.
 */
export const PARITY_PROBE_SOURCE = `
// parity fingerprint probe v1 — zero-import by contract (tests grep for import).
export default (pi: any) => {
	const mode = process.env.PARITY_MODE ?? "unknown";
	const stable = (v: any): string => {
		if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
		if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
		const ks = Object.keys(v).sort();
		return "{" + ks.map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
	};
	const hash = (s: string): bigint => Bun.hash(s);
	let tools: any[] = [];
	let sessionStartFired = false;
	pi.on("session_start", () => {
		sessionStartFired = true;
		try {
			tools = pi
				.getAllTools()
				.map((t: any) => ({
					n: String(t.name),
					s: String(t.sourceInfo?.source ?? ""),
					p: String(t.sourceInfo?.path ?? ""),
					dh: String(hash(String(t.description ?? ""))),
					sh: String(hash(stable(t.parameters ?? null))),
				}))
				.sort((a: any, b: any) => (a.n < b.n ? -1 : 1));
		} catch (e: any) {
			tools = [{ n: "__PROBE_ERROR__", s: "error", p: String(e), dh: "0", sh: "0" }];
		}
	});
	pi.on("before_agent_start", async (event: any) => {
		const skills: any[] = [];
		for (const sk of event?.systemPromptOptions?.skills ?? []) {
			try {
				const p = String(sk.filePath ?? sk.path ?? "");
				skills.push({ n: String(sk.name ?? ""), p, ch: p ? String(hash(await Bun.file(p).text())) : "0" });
			} catch {
				skills.push({ n: String(sk?.name ?? ""), p: String(sk?.filePath ?? ""), ch: "0" });
			}
		}
		skills.sort((a: any, b: any) => (a.n < b.n ? -1 : 1));
		const fp = {
			marker: "PARITY_FP_v1",
			mode,
			sessionStartFired,
			toolCount: tools.length,
			tools,
			skillCount: skills.length,
			skills,
		};
		process.stderr.write("\\n[PARITY-FP-START]" + JSON.stringify(fp) + "[PARITY-FP-END]\\n");
		process.exit(0);
	});
};
`;

export interface ParityFpTool {
	n: string;
	s: string;
	p: string;
	/** Bun.hash digest as a decimal string — Bun.hash returns BigInt, which JSON.stringify cannot serialize. */
	dh: string;
	sh: string;
}
export interface ParityFpSkill {
	n: string;
	p: string;
	ch: string;
}
export interface ParityFingerprint {
	mode: string;
	sessionStartFired: boolean;
	toolCount: number;
	tools: ParityFpTool[];
	skillCount: number;
	skills: ParityFpSkill[];
}

const FP_MARKER = "PARITY_FP_v1";

export type ParseParityFp =
	| { ok: true; fp: ParityFingerprint }
	| { ok: false; error: string };

/** Extract the fingerprint JSON from launcher stderr (tolerates surrounding noise). */
export function parseParityFpLine(stderr: string): ParseParityFp {
	const i = stderr.indexOf("[PARITY-FP-START]");
	if (i < 0) return { ok: false, error: "PARITY-FP-START marker absent from probe stderr" };
	const j = stderr.indexOf("[PARITY-FP-END]", i);
	if (j < 0) return { ok: false, error: "PARITY-FP-END marker absent (truncated probe output?)" };
	let raw: unknown;
	try {
		raw = JSON.parse(stderr.slice(i + "[PARITY-FP-START]".length, j));
	} catch (e) {
		return { ok: false, error: `fingerprint JSON unparseable: ${(e as Error).message}` };
	}
	// `marker` is a wire detail — validated here, never exported on ParityFingerprint.
	const o = raw as Partial<ParityFingerprint> & { marker?: unknown };
	if (o.marker !== FP_MARKER) return { ok: false, error: `marker version mismatch: ${String(o.marker)}` };
	if (!Array.isArray(o.tools) || !Array.isArray(o.skills)) {
		return { ok: false, error: "fingerprint missing tools/skills arrays" };
	}
	return {
		ok: true,
		fp: {
			mode: String(o.mode ?? "unknown"),
			sessionStartFired: o.sessionStartFired === true,
			toolCount: Number(o.toolCount ?? o.tools.length),
			tools: o.tools as ParityFpTool[],
			skillCount: Number(o.skillCount ?? o.skills.length),
			skills: o.skills as ParityFpSkill[],
		},
	};
}
