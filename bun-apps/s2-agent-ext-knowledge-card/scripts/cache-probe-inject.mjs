#!/usr/bin/env bun
/**
 * cache-probe-inject.mjs — context-lifecycle ticket 10: measure the t08/t09
 * auto-recall injector on the REAL vault + local LM Studio before any
 * default-ON flip ("promotion needs a measured win" — the IDF-gate lesson).
 *
 * Ports the ultracode cache-probe pattern (scripts/cache-probe-workflow-local.mjs,
 * repo root) to the kcard injection surface. Three measurements:
 *
 *   (a) tokens-injected/turn p50/p95 across a scripted 20-turn session — the
 *       REAL pipeline (buildAutoRecallBlock + RecallLedger, real vault, real
 *       retrieveRecords incl. bge-m3 semantic) over a mixed en/zh prompt
 *       script with chitchat negatives. Reports injection rate + line/block
 *       token costs per turn.
 *   (b) cache-transition cost injected-vs-clean turn (target ≤ 1.05× warm) —
 *       LM Studio latency-based, the same A/A/B/B/C/C/D sequence the ultracode
 *       probe used: warm both prefix shapes, then measure the flip twice.
 *   (c) no_relevant-skip rate on a labeled chitchat probe set (target ≥ 80%) —
 *       deterministic shouldRecall pass, no LLM.
 *
 * Usage (repo root):
 *   bun bun-apps/s2-agent-ext-knowledge-card/scripts/cache-probe-inject.mjs
 * Env: LMSTUDIO_BASE_URL (default http://127.0.0.1:1234/v1),
 *      CACHE_PROBE_MODEL (default: first non-embedding model in /v1/models).
 *
 * Receipt: output/injection-probe/receipt-<ISO>.json (scratch, not committed);
 * the NUMBERS land in the effort map's Context section (ticket 10 acceptance).
 */
import { mkdirSync, writeFileSync } from "node:fs";

import {
	AUTORECALL_DEFAULTS,
	buildAutoRecallBlock,
	estimateTokens,
	shouldRecall,
} from "../src/inject/auto-recall.ts";
import { RecallLedger } from "../src/inject/recall-ledger.ts";
import { resolveVault } from "@repo/s2-agent-ext-obsidian";

const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
const ARMED = { ...AUTORECALL_DEFAULTS, enabled: true };

// ── (a) scripted 20-turn session — mixed en/zh, realistic shapes ──────────────
// 6 chitchat/short negatives (must gate) + 14 substantive prompts spanning the
// vault's actual domains (lora/flux2/mlx pipeline, devops, eval methodology).
const TURNS = [
	"hi",
	"謝謝",
	"ok",
	"好的繼續",
	"收到",
	"hey",
	"how should I set lora scale when composing overrides in the flux2 klein pipeline, and does the argparse sentinel interact with it",
	"flux2 klein 的 CFG 在 distilled 模型下是不是沒作用？我該拉哪些參數來提升品質",
	"the seedvr2 upscale keeps ooming on mps, what offload device setting fixed it",
	"why did the ltx int4 g32 quant bug happen and which vendor patch fixed it",
	"我想在 GUI 裡掛多個 lora，架構上要注意什麼",
	"what does the recall-audit harness measure and what baseline should a change stay above",
	"bge-m3 跟 nomic 在 eval set 上的 tradeoff 是什麼，最後選了哪個",
	"prepare-feature-branch rebase 時 fetch-before-rebase 的規則是什麼",
	"how do I resolve the vault submodule showing dirty knowledge-semantic files",
	"kcard 的 tier ladder 為什麼要 demote-not-truncate 而不是截斷",
	"the gui dev server hmr serves a stale js bundle after hot reload, known fix?",
	"mlx 8bit quantize 跟 4bit 的取捨，哪些模型不適合 4bit",
	"怎麼避免 bun test timeout 留下 zombie process",
	"what pattern should I use to test unit-invisible seams in extensions",
];

// ── (c) labeled gate probe set (deterministic) ───────────────────────────────
const CHITCHAT = [
	"hi", "hello", "hey", "yo", "thanks", "thank you!!", "thx", "ok", "okay",
	"cool", "nice", "got it", "好的", "謝謝", "嗯", "哈囉", "收到", "繼續", "沒事", "再見",
];
const SUBSTANTIVE = [
	"what broke in the lora run yesterday and how was it fixed",
	"explain the tier ladder demotion rule in one paragraph please",
	"幫我看一下 seedvr2 的記憶體配置問題出在哪裡",
	"which vendor patch fixed the ltx connector quant bug",
	"the eval harness regressed after the embed model swap, where do I look",
	"how does the recall ledger avoid poisoning from no-result turns",
	"為什麼 prepare-feature-branch 要先 fetch 才能 rebase",
	"the deployed dist fails to load extensions, which cli verifies it",
	"summarize the cache economics of per-turn system prompt swaps",
	"maskrom 是什麼狀態下才需要用的",
];

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const out = { meta: {}, tokens: {}, cache: {}, gate: {} };

console.log("── (a) scripted 20-turn session over the REAL vault ──");
const { path: vaultPath } = await resolveVault(process.cwd());
const model = process.env.CACHE_PROBE_MODEL ?? (await pickChatModel());
out.meta = {
	date: new Date().toISOString(),
	vaultPath,
	baseUrl: BASE_URL,
	model,
	cooldownTurns: ARMED.cooldownTurns,
	tokenCap: ARMED.tokenCap,
};
console.log(`   vault=${vaultPath}  probe-model=${model}`);

const ledger = new RecallLedger(ARMED.cooldownTurns);
const perTurn = [];
let biggestBlock = "";
for (const [i, prompt] of TURNS.entries()) {
	ledger.tick();
	const { block, trace } = await buildAutoRecallBlock(prompt, { vaultPath, sessionFile: "/probe/session.jsonl", ledger }, ARMED);
	const blockTok = block ? estimateTokens(block) : 0;
	perTurn.push({ turn: i + 1, gated: trace.gated, cooled: trace.cooled, kept: trace.kept, lineTok: trace.tokensUsed, blockTok });
	if (blockTok > estimateTokens(biggestBlock)) biggestBlock = block;
}
const injected = perTurn.filter((t) => t.kept > 0);
const injectedTok = injected.map((t) => t.blockTok).sort((a, b) => a - b);
out.tokens = {
	turns: TURNS.length,
	gatedTurns: perTurn.filter((t) => t.gated).length,
	silentCooldownTurns: perTurn.filter((t) => !t.gated && t.kept === 0).length,
	injectedTurns: injected.length,
	blockTokP50: injectedTok.length ? pct(injectedTok, 50) : 0,
	blockTokP95: injectedTok.length ? pct(injectedTok, 95) : 0,
	cap: ARMED.tokenCap,
	perTurn,
};
console.log(`   injected ${injected.length}/${TURNS.length} turns (gated ${out.tokens.gatedTurns}, cooled-silent ${out.tokens.silentCooldownTurns})`);
console.log(`   block tokens p50=${out.tokens.blockTokP50} p95=${out.tokens.blockTokP95} (cap ${ARMED.tokenCap} + chrome)`);

// ── (b) cache-transition cost (latency-based, ultracode pattern) ─────────────
console.log("\n── (b) LM Studio cache-transition: injected vs clean prefix ──");
if (!biggestBlock) {
	out.cache = { skipped: "no block was injected in (a) — vault/semantic unavailable" };
} else {
	const BASE_SYS = "You are a coding assistant. Follow the user's instructions precisely and reply concisely.";
	const sysBig = `${BASE_SYS}\n\n${biggestBlock}`;
	const sysSmall = BASE_SYS;
	const USER_MSG = "Reply with exactly: ok";
	const call = async (label, system) => {
		const t0 = performance.now();
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: USER_MSG }], max_tokens: 8, temperature: 0 }),
		});
		const ms = Math.round(performance.now() - t0);
		if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${JSON.stringify(await res.json()).slice(0, 200)}`);
		await new Promise((r) => setTimeout(r, 300));
		return { label, ms };
	};
	const seq = {};
	for (const [label, sys] of [
		["A1", sysBig], ["A2", sysBig], ["B1", sysSmall], ["B2", sysSmall],
		["C1", sysBig], ["C2", sysSmall], ["D1", sysBig],
	]) seq[label] = await call(label, sys);
	const warm = (seq.A2.ms + seq.B2.ms) / 2;
	const trans = (seq.C1.ms + seq.D1.ms) / 2;
	out.cache = {
		blockTok: estimateTokens(biggestBlock),
		sequence: seq,
		warmMs: warm,
		transitionMs: trans,
		transitionRatio: +(trans / warm).toFixed(3),
		target: "<= 1.05x warm",
		pass: trans / warm <= 1.05,
	};
	console.log(`   block=${out.cache.blockTok}t  warm=${warm}ms  transition=${trans}ms  ratio=${out.cache.transitionRatio}x (target ≤1.05x)`);
}

// ── (c) chitchat gate skip rate (deterministic) ──────────────────────────────
console.log("\n── (c) gate skip rate on the chitchat probe set ──");
const chatSkipped = CHITCHAT.filter((p) => !shouldRecall(p, ARMED)).length;
const subPassed = SUBSTANTIVE.filter((p) => shouldRecall(p, ARMED)).length;
out.gate = {
	chitchatTotal: CHITCHAT.length,
	chitchatSkipped: chatSkipped,
	skipRate: +(100 * chatSkipped / CHITCHAT.length).toFixed(1),
	substantiveTotal: SUBSTANTIVE.length,
	substantivePassed: subPassed,
	target: ">= 80% skip",
	pass: chatSkipped / CHITCHAT.length >= 0.8 && subPassed === SUBSTANTIVE.length,
};
console.log(`   chitchat skipped ${chatSkipped}/${CHITCHAT.length} (${out.gate.skipRate}%, target ≥80%)  substantive passed ${subPassed}/${SUBSTANTIVE.length}`);

// ── receipt ──────────────────────────────────────────────────────────────────
out.verdict = {
	tokensWithinBudget: injectedTok.length ? out.tokens.blockTokP95 <= ARMED.tokenCap + 40 : false,
	cachePass: out.cache.pass ?? false,
	gatePass: out.gate.pass,
	flipRecommendation:
		(injectedTok.length ? out.tokens.blockTokP95 <= ARMED.tokenCap + 40 : false) && (out.cache.pass ?? false) && out.gate.pass
			? "FLIP (all three gates pass)"
			: "KEEP DEFAULT OFF (record which gate failed)",
};
const dir = "output/injection-probe";
mkdirSync(dir, { recursive: true });
const file = `${dir}/receipt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\n   receipt → ${file}`);
console.log(`   VERDICT: ${out.verdict.flipRecommendation}`);

async function pickChatModel() {
	const res = await fetch(`${BASE_URL}/models`);
	const { data } = await res.json();
	const chat = data.filter((m) => !/embed|bge|whisper|tts|kokoro/i.test(m.id));
	if (!chat.length) throw new Error(`no chat model loaded at ${BASE_URL} — set CACHE_PROBE_MODEL or load one in LM Studio`);
	return chat[0].id;
}
