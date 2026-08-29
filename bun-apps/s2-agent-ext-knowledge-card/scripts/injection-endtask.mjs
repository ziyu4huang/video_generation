#!/usr/bin/env bun
/**
 * injection-endtask.mjs — context-lifecycle ticket 16: does auto-recall
 * injection actually move END-TASK accuracy? (t10 measured cost/gating only;
 * the payoff question was deliberately left open — map Fog of war.)
 *
 * Three phases, all serialized (LM Studio contention trap, t08/t10):
 *
 *   1. CALIBRATE (deterministic, no LLM): sweep scoreFloor 2 vs 1 over the
 *      20-question probe set via buildAutoRecallBlock on the REAL vault,
 *      fresh RecallLedger per question (the arms run each question in its own
 *      session, so no cross-question cooldown). Reports per-config injection
 *      rate + TARGET-card hit rate, and gate behavior on the chitchat
 *      negatives under the CJK-weighted length gate (t16's code change —
 *      t10 measured raw-char 40 gating out ~20-char zh questions).
 *   2. ARMS (LLM): per question, headless `./s2-agent.sh -p --provider
 *      lm-studio --model <m> --tools read "<q> 請用一句話回答。"` — three
 *      arms: off / KC_AUTORECALL=1 (floor 2) / KC_AUTORECALL=1
 *      KC_AUTORECALL_FLOOR=1. `--tools read` isolates the injector's
 *      contribution from model-initiated retrieval (zk_* tools absent — an
 *      unarmed arm that tool-browses the vault would confound the delta).
 *      KC_AUTORECALL_DEBUG=1 receipts WHICH turns injected how many tokens.
 *   3. GRADE: deterministic grader (regex set per question, ANY match) over
 *      each arm's replies; accuracy per arm + delta. Success per ticket:
 *      armed accuracy ≥ unarmed accuracy (injection must at least not hurt).
 *
 * Usage (repo root):
 *   OB_VAULT_PATH=/Users/huangziyu/proj/pi-agent-vault \
 *     bun bun-apps/s2-agent-ext-knowledge-card/scripts/injection-endtask.mjs
 *   --calibrate-only   stop after phase 1
 *   --arm <name>       run a single arm (off | floor2 | floor1)
 * Env: OB_VAULT_PATH (REQUIRED — t10 vault-resolution trap: resolveVault
 *      from a repo cwd resolves the personal-config vault otherwise),
 *      ENDTASK_PROVIDER (default lm-studio), ENDTASK_MODEL (default
 *      prism-ml/bonsai-27b, the central tiers.small local lane).
 *
 * Receipt: output/injection-endtask/receipt-<ISO>.json (scratch, not
 * committed); the numbers land in the effort map (ticket 16 acceptance).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	AUTORECALL_DEFAULTS,
	applyAutoRecallEnv,
	buildAutoRecallBlock,
	estimateTokens,
	shouldRecall,
} from "../src/inject/auto-recall.ts";
import { RecallLedger } from "../src/inject/recall-ledger.ts";
import { resolveVault } from "@repo/s2-agent-ext-obsidian";

// ── probe set ────────────────────────────────────────────────────────────────
// 20 questions answerable ONLY from a specific vault card (each `card` is the
// card filename slug; facts are repo-measured numbers/names no parametric
// prior can know). Grader = regex source strings, ANY-match, case-insensitive.
// zh-TW phrasing dominates (the vault is zh-heavy — exercises the CJK gate).
const QUESTIONS = [
	{ id: 1, card: "zimage-cfg-wired-biggest-quality-lever", needle: "biggest dbzit9 quality lever", q: "在 ZImage 搭配 dbzit9 的 A/B 測試裡，cfg 開多少的整體品質分數最好？", grader: ["3(\\.0)?[^0-9]|開到?3|cfg[^0-9]{0,6}3(\\.0)?"] },
	{ id: 2, card: "flux2-klein-cfg-inert-when-distilled", needle: "distilled flux2-klein", q: "vendored flux2-klein 的 CFG dual-forward 裡，negative prompt（uncond 條件）實際上是什麼字串？", grader: ["space|空白|「 」|\" \"|' '|單一空格|一個空格"] },
	{ id: 3, card: "seedvr2-offload-device-mps", needle: "offload_device must be", q: "SeedVR2 在 Apple Silicon MPS 上，offload_device 的正確值是什麼（不是 cpu）？", grader: ["none|不?offload|\"none\""] },
	{ id: 4, card: "ltx-connector-int4-g32-quant-bug", needle: "int4/g32", q: "ltx-2.3 的 connector.safetensors 實際上是幾 bit、group_size 多少的量化配置？", grader: ["int.?4|4.?bit|四.?bit|(4|四).{0,12}(32|三十二)|32.{0,12}(4|四)"] },
	{ id: 5, card: "mlx-naive-attention-perf-bug", needle: "catastrophically slow", q: "Lens 的 MLX port 把 manual einsum attention 換成 fused SDPA 之後，1440 base 提速幾倍？", grader: ["5\\.8|814|140"] },
	{ id: 6, card: "count-without-seed-start-identical-images", needle: "distinct seeds", q: "修復之前 run.py 的 --count 不加 --seed-start 會生出什麼問題？", grader: ["identical|相同|同一|一樣|重複"] },
	{ id: 7, card: "mflux-int8-lora-noise-bug", needle: "dequantizing int8 LoRA", q: "mflux 載入 int8 LoRA 輸出純雜訊的 bug，最後是第幾號 vendor patch 修的？", grader: ["patch.?12|12.?號|第.?12|12"] },
	{ id: 8, card: "ltx-av-ca-timestep-scale-bug", needle: "av_ca_timestep_scale_multiplier", q: "LTX-2.3 的 audio bug 裡，av_ca_timestep_scale_multiplier 正確值應該是多少？", grader: ["1000"] },
	{ id: 9, card: "t2i-resolution-tier-system", needle: "resolution tier", q: "run.py 的 --resolution tier 系統提供哪三個 tier？", grader: ["model.{0,40}benchmark.{0,40}large|benchmark.{0,40}large"] },
	{ id: 10, card: "angle-command-optimized-refcount-presets", needle: "ref-count identity lever", q: "image angle 指令優化後，控制 identity 的 lever 是什麼觀念？", grader: ["ref.?-?.?count|參考.{0,6}(張|圖|數)|張數"] },
	{ id: 11, card: "anime2real-reference-conditioning", needle: "reference conditioning", q: "anime2real 轉真人的流程裡，比 I2I noise mixing 更能保持身份的做法是什麼？", grader: ["reference|條件|Flux2KleinEdit"] },
	{ id: 12, card: "zimage-moody-plasticky-skin-base-not-lora", needle: "no-pores skin", q: "MLX 出圖的塑膠感皮膚問題，根源是哪一層（LoRA？base 模型？還是整個平台）？", grader: ["平台|platform|整個.{0,4}(系統|平台)|不是.{0,8}lora|not.{0,8}lora"] },
	{ id: 13, card: "i2i-controlnet-lazy-tensor-fix", needle: "mx.eval(ctrl_33ch)", q: "controlnet 的 33ch 輸入產生垃圾影像時，在 build_control_input_33ch 之後還要呼叫什麼才會正確？", grader: ["mx\\.eval|eval\\("] },
	{ id: 14, card: "acelogic-text-encoder-fixes", needle: "NOT needed for our pipeline", q: "acelogic 的 text encoder fixes，我們的 pipeline 需要嗎？誰本來就處理對了？", grader: ["不需|not.{0,10}need|沒有必|mlx-lm"] },
	{ id: 15, card: "lmstudio-kv-cache-quant-vlm-load", needle: "KV-cache quantization", q: "qwen3-vl-4b 在 LM Studio 載入失敗，root cause 是什麼設定造成的？", grader: ["kv|快取|cache"] },
	{ id: 16, card: "fp8-compute-mps-incompatible", needle: "fp8-mps-metal", q: "MPS 上讓 FP8 matmul 走 Metal kernel 的 custom node 叫什麼名字？", grader: ["fp8-?mps-?metal|fp8_mps"] },
	{ id: 17, card: "purify-redraw-not-skin-lever-seedvr2-2x-oom", needle: "2x upscales CRASH", q: "purify 用 seedvr2 做 2x redraw 時會發生什麼事？", grader: ["crash|崩潰|當掉|134|page.?fault|失敗"] },
	{ id: 18, card: "flf2v-keyframe-best-practice", needle: "same seed, different prompt", q: "FLF2V keyframe 生成的勝利公式在 seed 跟 prompt 上怎麼搭配？", grader: ["同.{0,8}(seed|種子)|same.{0,8}seed|種子.{0,4}相同"] },
	{ id: 19, card: "seedvr2-7b-config-fixes", needle: "differ from defaults", q: "SeedVR2 7B 的 transformer config 裡 rope_freqs_for 要設成什麼？", grader: ["pixel"] },
	{ id: 20, card: "lens-mlx-t2i-rope-patchify", needle: "RoPE convention", q: "Lens 的 MLX T2I port 有兩個 forward-pass bug，分別是什麼性質的問題？", grader: ["rope|patchif"] },
];

// Chitchat negatives (must NOT inject; no accuracy grade — injection rate only).
const CHITCHAT = ["嗨", "謝謝你", "ok 收到", "好的沒問題", "先這樣再見"];

const PROMPT_SUFFIX = " 請用一句話回答。";

const ARGS = new Set(process.argv.slice(2));
const argValue = (name) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};

const VAULT = process.env.OB_VAULT_PATH;
if (ARGS.has("--help")) {
	console.log("usage: OB_VAULT_PATH=<vault> bun bun-apps/s2-agent-ext-knowledge-card/scripts/injection-endtask.mjs [--calibrate-only] [--arm off|floor2|floor1]");
	process.exit(0);
}
if (!VAULT) {
	console.error("OB_VAULT_PATH is REQUIRED (t10 vault-resolution trap — resolveVault from a repo cwd picks the personal-config vault).");
	process.exit(2);
}

const S2_AGENT_SH = join(import.meta.dir, "..", "..", "..", "s2-agent.sh");
const PROVIDER = process.env.ENDTASK_PROVIDER ?? "lm-studio";
const MODEL = process.env.ENDTASK_MODEL ?? "prism-ml/bonsai-27b";
const RUN_CAP_MS = 55 * 60 * 1000; // whole-battery cap (ticket: ≤1 h)
const t0 = Date.now();
const elapsed = () => Date.now() - t0;

const out = {
	meta: {
		date: new Date().toISOString(),
		vault: VAULT,
		provider: PROVIDER,
		model: MODEL,
		thinking: "off (bonsai-27b thinks ~4.5 min on zh knowledge questions without it — measured q01 272 s vs 7 s)",
		embedBase: "http://127.0.0.1:1234/v1 (child default — SEMANTIC_EMBED_BASE is honored by the standalone script but measured NOT honored inside the extension-loaded s2-agent child; earlier battery attempts against a wedged :1234 are the contaminated-run record)",
		embedModel: process.env.SEMANTIC_EMBED_MODEL ?? "text-embedding-bge-m3",
		armedTimeoutMs: "15000 (default 3 s measured to miss inside a full extension-loaded child even when the same retrieval runs ~200 ms standalone)",
	},
};
console.log(`endtask battery  vault=${VAULT}  model=${PROVIDER}/${MODEL}`);

// Sanity: the named vault must be the kcard knowledge vault, not the personal
// one (t10 ran half a probe against the wrong vault before catching this).
const resolved = (await resolveVault(process.cwd())).path;
if (resolved !== VAULT) {
	console.error(`vault mismatch: resolveVault → ${resolved}, OB_VAULT_PATH → ${VAULT}; refusing (env must win or the run measures the wrong vault)`);
	process.exit(2);
}
out.meta.resolvedVault = resolved;

// ── phase 0: semantic-cache warmup (unbounded, no race) ─────────────────────
// The cache fingerprint is name+mtime per card; ANY vault touch (hermes
// auto-converge at a previous session's shutdown — measured t16: it wrote
// `hermes-untitled.md` per headless child) invalidates it and the next
// retrieval pays a full 828-card re-embed burst (measured 53 s) — far past
// the injector's 3 s bound. Arms therefore run with OB_HERMES_AUTOCONVERGE=0,
// and this warmup pays any pending burst ONCE before timing anything.
console.log("\n── (0) semantic-cache warmup (pays any pending re-embed burst once) ──");
{
	const { retrieveRecords } = await import("../src/retrieve.ts");
	const t = Date.now();
	await retrieveRecords({
		vaultPath: VAULT,
		folder: "Zettelkasten/knowledge-graph",
		tags: ["warmup"],
		topK: 1,
		tier: "abstract",
		bodyMatch: true,
		slugDom: true,
		semantic: true,
		queryText: "cache warmup probe",
		usageLog: false,
	});
	console.log(`   warmup done in ${Date.now() - t} ms`);
	out.meta.cacheWarmupMs = Date.now() - t;
}

// ── phase 1: calibration sweep (deterministic) ──────────────────────────────
console.log("\n── (1) calibration sweep: scoreFloor 2 vs 1 vs 0, CJK-weighted gate ──");
const sweep = {};
for (const floor of [2, 1, 0]) {
	const cfg = applyAutoRecallEnv({ KC_AUTORECALL_FLOOR: String(floor) }, { ...AUTORECALL_DEFAULTS, enabled: true });
	const rows = [];
	for (const item of QUESTIONS) {
		// Fresh ledger per question: the arms run one question per session.
		const ledger = new RecallLedger(cfg.cooldownTurns);
		const { block, trace } = await buildAutoRecallBlock(
			item.q + PROMPT_SUFFIX,
			{ vaultPath: VAULT, sessionFile: "/probe/session.jsonl", ledger },
			cfg,
		);
		rows.push({
			id: item.id,
			card: item.card,
			gated: trace.gated,
			kept: trace.kept,
			tok: trace.tokensUsed,
			blockTok: block ? estimateTokens(block) : 0,
			targetInjected: block ? block.includes(item.needle) : false,
		});
	}
	const injected = rows.filter((r) => r.kept > 0);
	const targets = rows.filter((r) => r.targetInjected);
	sweep[`floor${floor}`] = {
		scoreFloor: cfg.scoreFloor,
		minPromptChars: cfg.minPromptChars,
		gate: "CJK-weighted length (t16 change) + chitchat RE",
		injected: `${injected.length}/${rows.length}`,
		targetCardInjected: `${targets.length}/${rows.length}`,
		rows,
	};
		console.log(`   floor=${floor}: injected ${injected.length}/20, target card in block ${targets.length}/20`);
}
// Gate behavior on chitchat under the new weighted gate (must stay skipped).
const armedCfg = { ...AUTORECALL_DEFAULTS, enabled: true };
const chatTripped = CHITCHAT.filter((p) => shouldRecall(p, armedCfg));
sweep.chitchat = { total: CHITCHAT.length, trippedGate: chatTripped };
console.log(`   chitchat tripped gate: ${chatTripped.length}/${CHITCHAT.length} (must be 0)`);
out.calibration = sweep;
if (ARGS.has("--calibrate-only")) {
	writeReceipt();
	process.exit(0);
}

// ── phase 2+3: arms ─────────────────────────────────────────────────────────
const ARMS = [
	{ name: "off", env: { OB_HERMES_AUTOCONVERGE: "0" } },
	{ name: "floor2", env: { KC_AUTORECALL: "1", KC_AUTORECALL_TIMEOUTMS: "15000", OB_HERMES_AUTOCONVERGE: "0" } },
	{ name: "floor0", env: { KC_AUTORECALL: "1", KC_AUTORECALL_FLOOR: "0", KC_AUTORECALL_TIMEOUTMS: "15000", OB_HERMES_AUTOCONVERGE: "0" } },
];
const only = argValue("--arm");
const arms = only ? ARMS.filter((a) => a.name === only) : ARMS;
if (!arms.length) {
	console.error(`unknown --arm "${only}" (off | floor2 | floor1)`);
	process.exit(2);
}

const { spawnSync } = await import("node:child_process");
for (const arm of arms) {
	const chatCount = arm.name === "off" ? 0 : CHITCHAT.length;
	console.log(`\n── (2) arm ${arm.name} (${QUESTIONS.length} questions + ${chatCount} chitchat, serialized) ──`);
	const results = [];
	const prompts = [
		...QUESTIONS.map((it) => ({ kind: "q", id: it.id, text: it.q + PROMPT_SUFFIX })),
		...(arm.name === "off" ? [] : CHITCHAT.map((c, i) => ({ kind: "chat", id: 100 + i, text: c }))),
	];
	for (const p of prompts) {
		if (elapsed() > RUN_CAP_MS) {
			console.error(`   RUN CAP hit at ${Math.round(elapsed() / 60000)} min — remaining prompts skipped, receipt marks incomplete`);
			out.cappedAtMs = elapsed();
			break;
		}
		const t = Date.now();
		const proc = spawnSync(
			"/bin/bash",
			[
				S2_AGENT_SH,
				"-p",
				"--provider", PROVIDER,
				"--model", MODEL,
				// bonsai-27b is a reasoning model: WITHOUT this a hard zh
				// knowledge question thinks for ~4.5 min (measured q01 272 s),
				// blowing the ≤1 h cap; with it the same call lands in ~7 s.
				// Uniform across arms — it disables thinking, not reading.
				"--thinking", "off",
				"--tools", "read",
				p.text,
			],
			{
				env: { ...process.env, OB_VAULT_PATH: VAULT, KC_AUTORECALL_DEBUG: "1", ...arm.env },
				encoding: "utf8",
				timeout: 4 * 60 * 1000,
			},
		);
		const ms = Date.now() - t;
		const stdout = (proc.stdout ?? "").trim();
		const stderr = (proc.stderr ?? "");
		// One debug line per injected/attempted turn: kept=N tok=M [error=...]
		const dbg = [...stderr.matchAll(/\[autorecall-debug\] gated=(\w+) kept=(\d+) tok=(\d+)(?: error="?([^"\n]*?)"?)?/g)].pop();
		let pass = null;
		if (p.kind === "q") {
			const item = QUESTIONS.find((x) => x.id === p.id);
			const res = item.grader.map((g) => new RegExp(g, "i"));
			pass = stdout.length > 0 && res.some((r) => r.test(stdout));
		}
		results.push({
			kind: p.kind,
			id: p.id,
			ms,
			injected: dbg ? Number(dbg[2]) : 0,
			injTok: dbg ? Number(dbg[3]) : 0,
			gated: dbg ? dbg[1] === "true" : null,
			error: dbg?.[4] || null,
			pass,
			reply: stdout.slice(0, 400),
			exit: proc.status,
		});
		const tag = p.kind === "q" ? `q${String(p.id).padStart(2, "0")}` : `chat${p.id}`;
		console.log(`   ${tag} ${String(ms).padStart(6)}ms inj=${results.at(-1).injected}${results.at(-1).error ? ` ERR=${results.at(-1).error}` : ""} pass=${pass}`);
	}
	const graded = results.filter((r) => r.kind === "q");
	const correct = graded.filter((r) => r.pass).length;
	const injectedTurns = results.filter((r) => r.injected > 0).length;
	out[arm.name] = {
		accuracy: `${correct}/${graded.length}`,
		accuracyPct: graded.length ? Math.round((100 * correct) / graded.length) : null,
		injectedTurns: `${injectedTurns}/${results.length}`,
		injTokPerTurn: results.filter((r) => r.injected > 0).map((r) => r.injTok),
		medianMs: median(graded.map((r) => r.ms)),
		totalMs: results.reduce((s, r) => s + r.ms, 0),
		results,
	};
	console.log(`   arm ${arm.name}: accuracy ${correct}/${graded.length} (${out[arm.name].accuracyPct}%), injected ${injectedTurns}/${results.length} turns, median ${out[arm.name].medianMs}ms`);
	if (out.cappedAtMs) break;
}

// ── verdict ─────────────────────────────────────────────────────────────────
if (out.off && (out.floor0 || out.floor2)) {
	const base = out.off.accuracyPct ?? 0;
	const best = [out.floor0, out.floor2].filter(Boolean).sort((a, b) => b.accuracyPct - a.accuracyPct)[0];
	out.verdict = {
		unarmedAccuracyPct: base,
		bestArmedAccuracyPct: best.accuracyPct,
		deltaPct: (best.accuracyPct ?? 0) - base,
		ticketGate: "armed ≥ unarmed (injection must at least not hurt)",
		pass: (best.accuracyPct ?? 0) >= base,
		measuredUnder: {
			scoreFloor: best === out.floor0 ? 0 : 2,
			minPromptChars: AUTORECALL_DEFAULTS.minPromptChars,
			gate: "CJK-weighted length (t16)",
		},
	};
	console.log(`\nVERDICT: armed ${best.accuracyPct}% vs unarmed ${base}% (Δ${out.verdict.deltaPct >= 0 ? "+" : ""}${out.verdict.deltaPct}pct, floor=${out.verdict.measuredUnder.scoreFloor}) → ${out.verdict.pass ? "injection does not hurt" : "injection HURTS — record rollback rationale"}`);
}
writeReceipt();

function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

function writeReceipt() {
	const dir = "output/injection-endtask";
	mkdirSync(dir, { recursive: true });
	const file = `${dir}/receipt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
	writeFileSync(file, JSON.stringify(out, null, 2));
	console.log(`\n   receipt → ${file}  (${Math.round(elapsed() / 1000)}s elapsed)`);
}
