/**
 * Keyword presets + relevance filters.
 *
 * The two Bilibili scripts differed ONLY in their default keywords and filter
 * function — both are unified here. `presetFor()` returns the keyword list +
 * relevance keywords for a given preset; callers can also pass custom keywords.
 */
import type { VideoResult, Preset } from "./types.ts";

/** Default search keywords per preset. */
export const DEFAULT_KEYWORDS: Record<Exclude<Preset, "custom">, string[]> = {
	llm: ["大模型", "LLM", "AI 前沿"],
	media: ["AI 繪畫", "AI 影片生成", "AIGC 教學", "Stable Diffusion", "Sora 影片"],
};

/**
 * YouTube presets use English-friendly defaults (the YouTube API indexes
 * English metadata more reliably than CJK for global AI content).
 */
export const DEFAULT_KEYWORDS_YOUTUBE: Record<Exclude<Preset, "custom">, string[]> = {
	llm: ["LLM", "Large Language Model", "AI 2026"],
	media: ["AI image generation", "AI video generation", "Stable Diffusion", "Sora"],
};

/** Relevance keywords used to filter the "popular"/"hot" feed. */
const LLM_RELEVANCE = [
	"大模型", "LLM", "AI", "GPT", "ChatGPT", "Claude", "Gemini",
	"深度學習", "機器學習", "神經網絡", "transformer", "attention",
	"RAG", "Agent", "prompt", "fine-tun", "RLHF", "對齊",
	"開源模型", "Llama", "Qwen", "DeepSeek", "Mistral", "MoE",
	"擴散模型", "多模態", "多模态", "embedding", "token",
	"Hugging Face", "langchain", "CrewAI", "AutoGPT",
	"推理", "生成式", "AIGC",
];

const MEDIA_RELEVANCE = [
	"AI 繪畫", "AI绘画", "AI 畫圖", "AI画图", "AI 插畫",
	"AI 影片", "AI影片", "AI 生成影片", "AI 视频生成", "AI 视频制作",
	"AIGC", "Stable Diffusion", "SD", "Midjourney", "MJ",
	"ComfyUI", "Flux", "Sora", "Runway", "Pika", "Kling", "可靈",
	"圖生圖", "图生图", "文生圖", "文生图", "擴散模型",
	"AI 動畫", "AI 动画", "AI 短片", "ControlNet", "LoRA", "lora",
	"AI 模型", "AI换脸", "AI 換臉", "neural rendering",
];

/** Relevance keyword set per preset (lowercased matching). */
const RELEVANCE: Record<Exclude<Preset, "custom">, string[]> = {
	llm: LLM_RELEVANCE,
	media: MEDIA_RELEVANCE,
};

/**
 * Resolve keywords for a run: explicit > preset default > platform default.
 * `custom` preset requires explicit keywords (falls back to llm preset if empty).
 */
export function resolveKeywords(
	preset: Preset,
	custom: string[] | undefined,
	platform: "bilibili" | "youtube",
): string[] {
	if (custom && custom.length > 0) return custom;
	if (preset === "custom") return DEFAULT_KEYWORDS.llm;
	const table = platform === "youtube" ? DEFAULT_KEYWORDS_YOUTUBE : DEFAULT_KEYWORDS;
	return table[preset];
}

/**
 * Filter a video list down to preset-relevant entries by scanning
 * title + tag + description (case-insensitive substring match).
 * `custom` preset skips filtering (returns input unchanged).
 */
export function filterRelevant(
	videos: VideoResult[],
	preset: Preset,
): VideoResult[] {
	if (preset === "custom") return videos;
	const kws = RELEVANCE[preset].map((k) => k.toLowerCase());
	return videos.filter((v) => {
		const text = `${v.title} ${v.tag} ${v.description}`.toLowerCase();
		return kws.some((kw) => text.includes(kw));
	});
}

/** Split a comma-separated keyword string into a trimmed array. */
export function parseKeywords(input: string | undefined): string[] | undefined {
	if (!input) return undefined;
	const parts = input
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length > 0 ? parts : undefined;
}
