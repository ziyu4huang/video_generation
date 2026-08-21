import { verifiedFilesBlock, type FileOpsSummary } from "./file-ops.ts";
import type { SessionType } from "./session-type.ts";
import type { CollectedUserMessage } from "./user-messages.ts";

export const SECTION_TITLES = [
  "Primary Request and Intent",
  "Key Technical Concepts",
  "Files and Code Sections",
  "Errors and fixes",
  "Problem Solving",
  "All user messages",
  "Pending Tasks",
  "Current Work",
  "Optional Next Step",
] as const;

const SESSION_TYPE_DIRECTIVES: Record<SessionType, string> = {
  implementation: "This is an IMPLEMENTATION session: weight sections toward concrete code state, file changes, and remaining work.",
  debugging: "This is a DEBUGGING session: weight sections toward error symptoms, root-cause hypotheses tested, and which fixes were verified.",
  review: "This is a REVIEW session (read-only tools): do NOT claim code was changed. Report findings and verdicts, never implementation progress.",
  discussion: "This is a DISCUSSION session with no tool use: weight sections toward decisions, constraints, and open questions.",
};

export function buildSystemPrompt(): string {
  return [
    "You are a context summarization assistant. Read the conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified in the user message.",
    "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the <analysis> section followed by the <summary> section.",
  ].join("\n\n");
}

export interface PromptInput {
  conversationText: string;
  previousSummary?: string;
  customInstructions?: string;
  fileOps: FileOpsSummary;
  sessionType: SessionType;
  userMessages: readonly CollectedUserMessage[];
}

export function buildUserPrompt(input: PromptInput): string {
  const parts: string[] = [];
  parts.push(verifiedFilesBlock(input.fileOps));
  parts.push(`<conversation>\n${input.conversationText}\n</conversation>`);
  if (input.previousSummary) {
    parts.push(`<previous-summary>\n${input.previousSummary}\n</previous-summary>`);
  }
  if (input.userMessages.length > 0) {
    parts.push(
      `<user-messages>\n${input.userMessages.map((m) => `[${m.index}] ${m.text}`).join("\n")}\n</user-messages>`,
    );
  }

  const sections = SECTION_TITLES.map((t) => `- ${t}`).join("\n");
  const lines: string[] = [
    "Summarize the conversation for a future assistant session that will continue this work with NO other context.",
    "",
    "Step 1 — <analysis>: before writing the summary, reason section by section about what must be captured. Check each section title against the conversation. This is your self-check scratchpad.",
    `Step 2 — <summary>: output exactly these sections, in order, each as a markdown level-2 heading:\n${sections}`,
    "",
    "Hard rules:",
    `1. Ground truth: the file list in <verified-files> was extracted deterministically from actual tool calls. Section "Files and Code Sections" may ONLY reference paths that appear in <verified-files> or verbatim inside <conversation>. Never invent or guess a path.`,
    `2. Section "All user messages" preserves the user's requests VERBATIM (word-for-word, in order). Use the <user-messages> block as the authoritative copy.`,
    "3. Exact identifiers: preserve code identifiers (function, variable, file, test names) character-for-character. Never paraphrase or translate them.",
    `4. Additional evidence rule: mark something Done ONLY with evidence — a passing test run or explicit user confirmation shown in the conversation. Otherwise it stays under Pending Tasks.`,
    `5. Quote the latest exchange: "Current Work" and "Optional Next Step" must be grounded in the most recent turns of the conversation, quoting the user's last message where relevant.`,
    SESSION_TYPE_DIRECTIVES[input.sessionType],
  ];
  if (input.previousSummary) {
    lines.push(
      "6. UPDATE mode: a <previous-summary> is provided. PRESERVE the information it already contains, ADD new progress, UPDATE statuses (In Progress → Done only with evidence), refresh Next Steps, and drop only items that became irrelevant.",
    );
  }
  if (input.customInstructions) {
    lines.push(`\nAdditional focus: ${input.customInstructions}`);
  }
  parts.push(lines.join("\n"));
  return parts.join("\n\n");
}

export function extractSummary(raw: string): string {
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1] : raw;
}
