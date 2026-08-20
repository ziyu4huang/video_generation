/**
 * Shared types for the research-tool collection engines.
 *
 * Both Bilibili and YouTube results normalize into `VideoResult` so the
 * formatter and tools stay platform-agnostic.
 */

/** A single collected video, normalized across platforms. */
export interface VideoResult {
	id: string;
	/** Canonical watch URL. */
	url: string;
	title: string;
	author: string;
	/** View/play count. */
	play: number;
	/** Danmaku (Bilibili) or comment count fallback. */
	danmaku: number;
	favorites: number;
	/** Reply/comment count. */
	replies: number;
	/** ISO date string (YYYY-MM-DD). */
	date: string;
	/** Human-readable duration, e.g. "12:34". */
	duration: string;
	/** Cover/thumbnail URL. */
	thumbnail: string;
	tag: string;
	description: string;
}

/** A keyword search group with its collected videos. */
export interface KeywordGroup {
	keyword: string;
	videos: VideoResult[];
}

/** The full result of a collection run, ready for formatting. */
export interface CollectionResult {
	platform: "bilibili" | "youtube";
	preset: "llm" | "media" | "custom";
	/** Per-keyword search groups. */
	groups: KeywordGroup[];
	/** Optional "popular"/"hot" pre-filtered section. */
	hot?: VideoResult[];
	/** ISO date string the collection was run. */
	dateStr: string;
}

/** Platform supported by collect_videos. */
export type Platform = "bilibili" | "youtube";

/** Keyword preset selecting the default keywords + relevance filter. */
export type Preset = "llm" | "media" | "custom";
