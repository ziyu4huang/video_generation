/**
 * story_native.ts — native Bun replacement for `run.py story angles/propose`.
 *
 * `app/planning/story_angles.py` + `app/commands/story.py`'s `angles`/`propose`
 * sub-actions are pure prompt-templating + JSON parsing around a plain LM
 * Studio HTTP call (`_gemma_json_call` → `requests.post(.../chat/completions)`)
 * — no MLX compute happens in that Python at all. This module ports the prompt
 * builders/parsers 1:1 (same schema, same tolerant-parse discipline: strip
 * `<think>` blocks + ```json fences, find the first `[ … ]`) and calls
 * `lmstudio.ts`'s direct client instead of shelling out to `run.py`.
 *
 * `story shots` is NOT ported here: it only folds a concept into a
 * (story, style_hint, num_panels) triple (pure, ported below as
 * `conceptToStory`) and then delegates the actual generation to `image
 * storyboard`. IMPORTANT: calling `story shots` itself (via `runpy_story.ts`)
 * still gets NONE of that — `run.py story shots` shells out to Python's own
 * `run_shots()`, which itself spawns a SECOND, entirely Python, `run.py image
 * storyboard` subprocess (see `app/commands/story.py`'s `run_shots`); this
 * never touches the TS registry/selector, so it never reaches
 * `storyboard_native.ts`'s Bun-native generation line (2026-08-01, see
 * .planning/specs/2026-08-01-storyboard-native-port-design.md). The
 * ONLY way to reach the Bun-native path is to bypass `runpy_story.ts`
 * entirely: build the shots request with `conceptToStory` and call
 * `image_generation:storyboard` directly — this both cuts one full Python
 * process layer (vs. going through `story shots`) AND, as of 2026-08-01,
 * lands on the fully Bun-native generation path once there.
 */
import { lmStudioJsonCall, type LmStudioChatOptions } from "./lmstudio.ts";

export interface StoryAngle {
  angle?: string;
  logline?: string;
  tone?: string;
  why_different?: string;
  target_audience?: string;
}

export interface StoryConcept {
  title?: string;
  angle?: string;
  logline?: string;
  scene_list?: string[];
  visual_language?: string;
  est_shot_count?: number;
  estimated_cost?: string;
}

const ANGLES_SCHEMA = `[
  {
    "angle": "the creative angle / hook (a short noun phrase)",
    "logline": "one-sentence synopsis of the story this angle produces",
    "tone": "emotional tone, e.g. 'whimsical', 'tense', 'melancholic'",
    "why_different": "one phrase on how this angle differs from the others",
    "target_audience": "who this resonates with (short)"
  }
]`;

/** Build the gemma angles-generation prompt for a topic (mirrors story_angles.py:build_angles_prompt). */
export function buildAnglesPrompt(topic: string, count = 3): string {
  const n = Math.max(1, Math.trunc(count));
  return `You are a creative director brainstorming story CONCEPTS. Given a topic, generate exactly ${n} DISTINCT creative angles for a short visual story (a storyboard of a few images). The angles must be MAXIMALLY differentiated — different tone, audience, hook, and emotional register. Do NOT produce variations of the same idea.

Rules:
- Exactly ${n} angles. Each is a genuinely different take on the topic.
- "angle" is a concrete creative hook (not a restatement of the topic).
- "logline" is one sentence — the actual story this angle would tell.
- Each angle must be filmable as a short sequence of images.

Return ONLY a JSON array (no prose, no markdown fences) of exactly ${n} objects, each matching this shape:

${ANGLES_SCHEMA}

Topic:
"""${topic}"""

JSON array:`;
}

const PROPOSAL_SCHEMA = `[
  {
    "title": "a short evocative title",
    "angle": "the creative angle this concept pursues",
    "logline": "one-sentence story synopsis",
    "scene_list": ["beat 1 — one concrete filmable moment", "beat 2 — ...", "beat 3 — ..."],
    "visual_language": "the look: palette, lighting, film stock / illustration style",
    "est_shot_count": 4,
    "estimated_cost": "low|medium|high (relative render budget)"
  }
]`;

/** Build the gemma proposal-packet prompt for a topic (mirrors story_angles.py:build_propose_prompt). */
export function buildProposePrompt(topic: string, count = 2): string {
  const n = Math.max(1, Math.trunc(count));
  return `You are a creative director producing a STORY PROPOSAL. Given a topic, propose exactly ${n} distinct CONCEPT OPTIONS for a short visual story (a storyboard). Each concept is a complete, approval-ready pitch with a concrete scene_list of filmable beats and a defined visual language.

Rules:
- Exactly ${n} concept options, each a genuinely different approach.
- "scene_list" is 3-6 concrete, filmable beats (one image each) covering a beginning → middle → end arc.
- "visual_language" is a concrete look the image model can render (palette + lighting + style).
- "est_shot_count" equals the number of beats in scene_list.
- "estimated_cost" reflects relative render budget (more shots + higher detail = higher).

Return ONLY a JSON array (no prose, no markdown fences) of exactly ${n} objects, each matching this shape:

${PROPOSAL_SCHEMA}

Topic:
"""${topic}"""

JSON array:`;
}

/** Tolerant JSON-array extraction shared by parseAngles/parseProposal (mirrors story_angles.py's parse_angles/parse_proposal). */
function parseJsonArray(raw: string, label: string): unknown[] {
  let cleaned = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, "").trim();
  if (!cleaned && /<think/i.test(raw)) {
    cleaned = raw.replace(/<\/?think\s*>/gi, "").trim();
  }
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  throw new Error(`${label} response had no parseable JSON array (first 200 chars: ${JSON.stringify(cleaned.slice(0, 200))})`);
}

export function parseAngles(raw: string): StoryAngle[] {
  return parseJsonArray(raw, "angles") as StoryAngle[];
}

export function parseProposal(raw: string): StoryConcept[] {
  return parseJsonArray(raw, "proposal") as StoryConcept[];
}

/** Serialize a proposal_packet to YAML-compatible text (JSON is a valid YAML subset — mirrors story_angles.py's no-PyYAML fallback). */
export function proposalToYaml(packet: StoryConcept[]): string {
  return JSON.stringify(packet, null, 2);
}

/** Fold an approved concept into (story, style_hint, num_panels) for `image storyboard` (mirrors story_angles.py:concept_to_story). */
export function conceptToStory(concept: StoryConcept): { story: string; styleHint: string; numPanels: number } {
  const title = (concept.title ?? "").trim();
  const logline = (concept.logline ?? "").trim();
  const beats = (Array.isArray(concept.scene_list) ? concept.scene_list : [])
    .map((b) => String(b).trim())
    .filter((b) => b.length > 0);

  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (logline) parts.push(`Logline: ${logline}`);
  if (beats.length > 0) {
    parts.push("Story beats:");
    beats.forEach((b, i) => parts.push(`  ${i + 1}. ${b}`));
  }
  const story = parts.join("\n");

  const styleHint = (concept.visual_language ?? "").trim();
  let numPanels = Number(concept.est_shot_count) || beats.length || 4;
  if (!Number.isFinite(numPanels) || numPanels < 1) numPanels = beats.length || 4;
  return { story, styleHint, numPanels: Math.max(1, Math.trunc(numPanels)) };
}

export interface StoryAnglesResult {
  angles: StoryAngle[];
}

export interface StoryProposeResult {
  concepts: StoryConcept[];
}

/** `story angles` — N differentiated creative angles from a topic, via direct LM Studio call (no run.py). */
export async function runStoryAnglesNative(
  topic: string,
  count = 3,
  opts: LmStudioChatOptions = {},
): Promise<StoryAnglesResult> {
  const prompt = buildAnglesPrompt(topic, count);
  const angles = await lmStudioJsonCall(prompt, parseAngles, opts);
  return { angles: angles.length > count ? angles.slice(0, count) : angles };
}

/** `story propose` — an OM-shaped proposal_packet, via direct LM Studio call (no run.py). */
export async function runStoryProposeNative(
  topic: string,
  count = 2,
  opts: LmStudioChatOptions = {},
): Promise<StoryProposeResult> {
  const prompt = buildProposePrompt(topic, count);
  const concepts = await lmStudioJsonCall(prompt, parseProposal, opts);
  return { concepts: concepts.length > count ? concepts.slice(0, count) : concepts };
}
