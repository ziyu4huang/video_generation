/**
 * CLI sub-command specs for s2-agent.
 *
 * Lets `s2-agent` expose the research-tool extension tools as top-level
 * sub-commands:
 *
 *   s2-agent cli collect-videos <platform> <preset> [keywords...] [options]
 *   s2-agent cli organize-vault [options]
 *   s2-agent cli import-memory [options]
 *   s2-agent cli news [focus...] [options]
 *
 * Each sub-command creates an agent session with the research-tool extension
 * factory loaded (so the corresponding tool is registered) and passes a
 * precise task instructing the agent which tool to call with which parameters.
 *
 * Research-tool specific CLI flags (--popular, --pages, --proxy, --recency,
 * --output-path, --hermes-dir, --vault-root, --date, --overwrite, --dry-run)
 * are parsed from the CLI and translated into tool parameters by the task
 * builder.
 *
 * This file is dependency-free of s2-agent on purpose: the workspace dep
 * direction is s2-agent → s2-agent-ext-research-tool, so the spec is typed
 * with a local structurally-compatible interface (TS structural typing makes it
 * assignable to s2-agent's `ExtensionSubcommandSpec`). See
 * `bun-apps/s2-agent/src/cli/extensions/types.ts` for the canonical shape.
 */
import extension from "./research-tool.ts";
import { parseIsoDate } from "../lib/news.ts";

/** Local shape of s2-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

// ── collect-videos ──────────────────────────────────────────────────────────

export const collectVideosSubcommand: ExtensionSubcommandSpec = {
  name: "collect-videos",
  summary:
    "collect LLM/AI videos from Bilibili/YouTube and write a Markdown summary to the vault",
  details: `Usage:
  s2-agent cli collect-videos <platform> <preset> [keywords...] [options]

Collect AI/LLM videos from Bilibili or YouTube and write a structured Markdown
summary to the vault's weekly-news/ folder.

Positionals:
  platform    "bilibili" or "youtube"
  preset      "llm", "media", or "custom"  (selects keyword defaults + relevance filter)
  keywords    override preset keywords (space-separated; only used with preset=custom or
              to augment the defaults)

Options (pi-aligned globals + research-specific):
  --popular           bilibili only: also pull the all-site popular feed and filter by preset
  --pages <n>         pages per keyword (each ≈20 bilibili / 50 youtube; default: 1)
  --order <sort>      click|pubdate|dm|stow (bilibili) / relevance|date|viewCount (youtube)
  --proxy <url>       bilibili proxy URL (e.g. http://127.0.0.1:7890) to bypass 412 errors
  --recency <days>    youtube only: only videos from last N days (default: 30)
  --output-path <p>   explicit output path (default: vault weekly-news/<platform>-<preset>-<date>.md)
  --model <pattern>   provider/id[:thinking]  (e.g. sonnet, bonsai-27b)
  --provider <name>   provider name
  --tools <csv>       override the curated tool allowlist

Examples:
  s2-agent cli collect-videos bilibili llm
  s2-agent cli collect-videos youtube llm
  s2-agent cli collect-videos bilibili media --popular --pages 2
  s2-agent cli collect-videos bilibili custom RLHF PPO --pages 3

Requires YOUTUBE_API_KEY for YouTube collection.`,
  factory: extension,
  tools: ["collect_videos"],
  task: (parsed) => {
    const pos = parsed.positionals;
    const platform = pos[0]?.toLowerCase();
    const preset = pos[1]?.toLowerCase();
    const keywords = pos.slice(2).join(",");

    // Cast to access runtime flags beyond positionals
    const p = parsed as Record<string, unknown>;
    const parts: string[] = [
      `Use the collect_videos tool with the following parameters:`,
    ];

    if (platform === "bilibili" || platform === "youtube") {
      parts.push(`  platform="${platform}"`);
    } else {
      parts.push(`  platform="bilibili"  (default; unrecognised "${platform}" treated as bilibili)`);
    }

    if (preset === "llm" || preset === "media" || preset === "custom") {
      parts.push(`  preset="${preset}"`);
    } else if (preset) {
      parts.push(`  preset="custom"  (treated as custom; unrecognised "${preset}")`);
    } else {
      parts.push(`  preset="llm"  (default)`);
    }

    if (keywords) {
      parts.push(`  keywords=["${keywords.replace(/"/g, '\\"')}"]`);
    }

    if (p.popular === true) {
      parts.push(`  popular=true`);
    }
    if (typeof p.pages === "number") {
      parts.push(`  pages=${p.pages}`);
    }
    if (typeof p.order === "string") {
      parts.push(`  order="${p.order}"`);
    }
    if (typeof p.proxy === "string") {
      parts.push(`  proxy="${p.proxy}"`);
    }
    if (typeof p.recency === "number") {
      parts.push(`  recency=${p.recency}`);
    }
    if (typeof p.outputPath === "string") {
      parts.push(`  outputPath="${p.outputPath}"`);
    }
    if (p.dryRun === true) {
      parts.push(`  dryRun=true`);
    }

    parts.push(
      `\nCall the tool, then report the result: total videos collected, ` +
        `per-keyword counts, output file path, and any errors.`)
    ;

    return parts.join("\n");
  },
};

// ── organize-vault ──────────────────────────────────────────────────────────

export const organizeVaultSubcommand: ExtensionSubcommandSpec = {
  name: "organize-vault",
  summary:
    "auto-tag frontmatter on vault notes and list unclassified orphans",
  details: `Usage:
  s2-agent cli organize-vault [options]

Scan the Obsidian vault, auto-tag notes that lack frontmatter (tags/aliases/
created inferred from filename + path patterns), and list orphan notes that
don't match any rule.

Options:
  --dry-run               preview changes without writing
  --vault-root <path>     explicit vault root (default: active vault)
  --model <pattern>       provider/id[:thinking]
  --tools <csv>           override the curated tool allowlist

Examples:
  s2-agent cli organize-vault
  s2-agent cli organize-vault --dry-run`,
  factory: extension,
  tools: ["organize_vault_notes"],
  task: (parsed) => {
    const p = parsed as Record<string, unknown>;
    const parts: string[] = [
      "Use the organize_vault_notes tool with the following parameters:",
    ];

    if (p.dryRun === true) {
      parts.push(`  dryRun=true`);
    }
    if (typeof p.vaultRoot === "string") {
      parts.push(`  vaultRoot="${p.vaultRoot}"`);
    }

    parts.push(
      `\nCall the tool and report the results: how many notes were updated, ` +
        `how many skipped, and how many orphans remain.`,
    );

    return parts.join("\n");
  },
};

// ── news ────────────────────────────────────────────────────────────────────

export const newsSubcommand: ExtensionSubcommandSpec = {
  name: "news",
  summary:
    "scaffold the weekly LLM community news digest issue in the vault",
  details: `Usage:
  s2-agent cli news [focus...] [options]

Scaffold this week's LLM 社群每週新聞 digest issue in the vault's
weekly-news/ folder (llm-weekly-news-<saturday>.md): frontmatter, zh title
spanning the Monday–Saturday range, and the fill-in guide.

SCOPE NOTE: this subcommand scaffolds ONLY. CLI subcommand sessions carry
just the research-tool factory (no web search, no file tools), so the
research + write half must run in a full session — /collect-news-llm or the
collect-news-llm skill.

Positionals:
  focus       optional focus topics for the research half (space-separated),
              echoed into the report

Options:
  --date <iso>        anchor the issue week (default: today; the issue covers
                      that week's Monday–Saturday)
  --output-path <p>   explicit output path (default: vault weekly-news/llm-weekly-news-<date>.md)
  --overwrite         regenerate the scaffold even if the issue file has content
  --model <pattern>   provider/id[:thinking]  (e.g. sonnet, bonsai-27b)
  --provider <name>   provider name
  --tools <csv>       override the curated tool allowlist

Examples:
  s2-agent cli news
  s2-agent cli news agents evals
  s2-agent cli news --date 2026-09-01

No API key needed; the scaffold itself makes no network calls.`,
  factory: extension,
  tools: ["collect_news"],
  task: (parsed) => {
    const p = parsed as Record<string, unknown>;
    const focus = parsed.positionals.filter(Boolean).join(", ");
    const parts: string[] = [
      "Scaffold the weekly news digest issue with the collect_news tool:",
      `  call collect_news with these parameters:`,
    ];

		if (typeof p.date === "string") {
			if (parseIsoDate(p.date)) {
				parts.push(`  date="${p.date}"`);
			} else {
				// Fail soft at the CLI surface (the task is just a prompt): keep the
				// session from passing the bad anchor through to collect_news.
				parts.push(
					`  (date="${p.date}" is NOT a valid ISO yyyy-mm-dd calendar date — ` +
						"do NOT call collect_news with a date parameter; open your reply with " +
						`an error naming the invalid --date flag)`,
				);
			}
		}
    if (typeof p.outputPath === "string") {
      parts.push(`  outputPath="${p.outputPath}"`);
    }
    if (p.overwrite === true) {
      parts.push(`  overwrite=true`);
    }
    if (p.dryRun === true) {
      parts.push(`  dryRun=true`);
    }

    parts.push(
      `\nCall the tool, then report: the scaffolded file path, the covered ` +
        `date range, and the scaffold's fill-in checklist. Do NOT attempt the ` +
        `research or writing half — this session has no web or file tools; ` +
        `instead remind the user to run /collect-news-llm in a full session` +
        `${focus ? ` (focus topics: ${focus})` : ""}.`,
    );

    return parts.join("\n");
  },
};

// ── import-memory ───────────────────────────────────────────────────────────

export const importMemorySubcommand: ExtensionSubcommandSpec = {
  name: "import-memory",
  summary:
    "parse pi-hermes-memory entries and append to a vault-mind JSONL collection",
  details: `Usage:
  s2-agent cli import-memory [options]

Parse pi-hermes-memory entries from MEMORY.md / USER.md / failures.md and
append them (dedup by id) to a vault-mind JSONL collection. Output defaults
to <vault>/collections/study_news.jsonl.

Options:
  --output-path <path>    JSONL output file (default: <vault>/collections/study_news.jsonl)
  --hermes-dir <path>     override hermes-memory directory
                          (default: $HOME/.pi/agent/pi-hermes-memory)
  --model <pattern>       provider/id[:thinking]
  --tools <csv>           override the curated tool allowlist

Examples:
  s2-agent cli import-memory
  s2-agent cli import-memory --output-path ./my-collection.jsonl`,
  factory: extension,
  tools: ["import_memory_to_vault"],
  task: (parsed) => {
    const p = parsed as Record<string, unknown>;
    const parts: string[] = [
      "Use the import_memory_to_vault tool with the following parameters:",
    ];

    if (typeof p.outputPath === "string") {
      parts.push(`  outputPath="${p.outputPath}"`);
    }
    if (typeof p.hermesDir === "string") {
      parts.push(`  hermesDir="${p.hermesDir}"`);
    }
    if (p.dryRun === true) {
      parts.push(`  dryRun=true`);
    }

    parts.push(
      `\nCall the tool and report how many entries were imported, how many ` +
        `already existed, and the output path.`,
    );

    return parts.join("\n");
  },
};
