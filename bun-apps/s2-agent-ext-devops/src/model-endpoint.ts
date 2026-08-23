/**
 * Shared model-endpoint helpers — the chat endpoint the local probes hit
 * (default LM Studio at 127.0.0.1:1234) and the "contention" judgment about
 * what it is serving.
 *
 * Extracted 2026-08-23 from deploy-e2e-recipe.ts (which re-exports everything
 * for compatibility) so oneshot-smoke can run the same contention precheck
 * without a runtime cycle: deploy-e2e-recipe imports classifyRun from
 * oneshot-smoke, so oneshot-smoke cannot import back.
 *
 * WHY CONTENTION MATTERS (measured 2026-08-23 on this machine): LM Studio
 * with several large models resident (qwen 27b ×2 + gemma 12b + 3 embedders)
 * generated 10 tokens in 31.7s and the same one-shot completed in ~3–4 min
 * uncapped. Under that condition a wall-clock cap cannot tell SLOW GENERATION
 * from a hang — probes that hit one should say "contention", not "fail".
 */

/** Default chat-endpoint base for the contention precheck (LM Studio). */
export const DEFAULT_MODEL_ENDPOINT = "http://127.0.0.1:1234";

/** Resolve the precheck endpoint: env override first (baseUrl alias included). */
export function resolveModelEndpoint(env: Record<string, string | undefined> = process.env): string {
	return env.LMSTUDIO_BASE_URL ?? DEFAULT_MODEL_ENDPOINT;
}

/** Model ids that are embedding servers, not chat models — never contention. */
const EMBEDDING_ID_RE = /embed|bge/i;
/** "27b" / "12b" in a model id, parsed as a parameter count. */
const PARAMS_B_RE = /(\d+(?:\.\d+)?)\s*b\b/i;
/** ≥ this many billion params counts as a LARGE chat model. */
const LARGE_MODEL_MIN_B = 7;

/**
 * Contention precheck (pure): given `/v1/models` ids, warn when MORE THAN ONE
 * large chat model is resident — the measured condition under which even a
 * 300s model-call cap can be exceeded. Returns null when quiet.
 */
export function modelContentionWarning(modelIds: string[], capMs: number = 300_000): string | null {
	const large = modelIds.filter((id) => {
		if (EMBEDDING_ID_RE.test(id)) return false;
		const m = id.match(PARAMS_B_RE);
		return m !== null && Number.parseFloat(m[1]) >= LARGE_MODEL_MIN_B;
	});
	if (large.length > 1) {
		return `model endpoint lists ${large.length} large chat models resident (${large.join(", ")}) — generation may be slow enough to exceed even the ${Math.round(capMs / 1000)}s model-call cap; consider unloading the extras in LM Studio before deploying/probing`;
	}
	return null;
}

/** Fetch seam for the contention precheck — narrow so tests inject a plain fn. */
export type ModelsFetch = (url: string, init?: RequestInit) => Promise<Response>;
