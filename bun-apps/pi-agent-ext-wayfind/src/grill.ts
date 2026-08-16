/**
 * Pure grill helpers — no Pi runtime, no fs. Data in, string out, so they're
 * unit-testable without mocking the ExtensionAPI.
 *
 *  - buildGrillPriming: the priming user-message that kicks a grill session.
 *      Faithfully captures the matt_skills grilling discipline (one question at a
 *      time, recommended answer each, facts from the environment, decisions to the
 *      user) and, for the `-with-docs` variant, the domain-modeling capture rules
 *      (write CONTEXT.md terms inline; offer ADRs sparingly).
 *  - buildPlanSeed: synthesize the resolved decisions + glossary into a
 *      task_plan.md seed — the grill→plan handoff.
 */

import { extractSection } from "./markdown.js";

export interface ResolvedDecision {
  title: string;
  answer: string;
}

export interface GlossaryTerm {
  term: string;
  definition: string;
}

/** Emit the "## Settled vocabulary" block — heading, blank, one `- **term**: def`
 *  line per glossary term, trailing blank. No-op when the glossary is empty.
 *  Shared by `buildPlanSeed` (custom heading) and chain.ts's
 *  `flattenTicketsToPlan` / `seedFromDecisions` (default heading), so the three
 *  emitters stay byte-identical. */
export function appendSettledVocabulary(
  lines: string[],
  glossary: GlossaryTerm[],
  heading = "## Settled vocabulary",
): void {
  if (glossary.length === 0) return;
  lines.push(heading, "");
  for (const g of glossary) lines.push(`- **${g.term}**: ${g.definition}`);
  lines.push("");
}

/** Shared `**Term**: value` matcher for the two CONTEXT.md readers.
 *  - requireBullet=false (glossary): `**Term**: def`, empty value allowed.
 *  - requireBullet=true  (decisions): `- **Term**: answer`, answer required.
 *  Returns null when the line doesn't match the requested shape. */
function parseBoldColonLine(line: string, requireBullet: boolean): { term: string; value: string } | null {
  const re = requireBullet ? /^\s*-\s*\*\*([^*]+)\*\*\s*:\s*(.+)$/ : /^\*\*([^*]+)\*\*\s*:\s*(.*)$/;
  const m = line.match(re);
  return m ? { term: m[1].trim(), value: m[2].trim() } : null;
}

/** Parse `**Term**: definition` lines out of a CONTEXT.md body. Tolerant: skips
 *  headings, blank lines, and `_Avoid_:` lines. Returns [] if none found. */
export function parseGlossary(contextMd: string): GlossaryTerm[] {
  const out: GlossaryTerm[] = [];
  for (const raw of contextMd.split(/\r?\n/)) {
    const m = parseBoldColonLine(raw.trim(), false);
    if (!m) continue;
    if (m.term.toLowerCase() === "avoid") continue;
    if (!m.value) continue; // definition on next line — skip bare bold headers
    out.push({ term: m.term, definition: m.value });
  }
  return out;
}

/** Parse the `## Decisions` section of a CONTEXT.md into `{title, answer}`
 *  records — the information backbone of the continuous chain (every handoff
 *  reads this, so no resolved decision is lost). Only bulleted
 *  `- **title**: answer` lines count; glossary-style `**Term**: def` lines
 *  (no bullet, anywhere) are ignored. Returns [] when the section is absent. */
export function parseDecisions(contextMd: string): ResolvedDecision[] {
  const section = extractSection(contextMd, "Decisions");
  if (!section.trim()) return [];
  const out: ResolvedDecision[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const m = parseBoldColonLine(raw, true);
    if (m) out.push({ title: m.term, answer: m.value });
  }
  return out;
}

/** Shared grilling discipline — the interview engine core. */
const GRILL_DISCIPLINE = [
  "Interview me relentlessly about every aspect of this until we reach a shared understanding.",
  "Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one.",
  "Ask the questions ONE AT A TIME, waiting for my answer before the next — never a questionnaire dump.",
  "For each question, provide YOUR recommended answer first; I confirm, reject, or refine.",
  "If a FACT can be found by exploring the environment (files, code, docs, tools), look it up — do not ask me.",
  "The DECISIONS are mine: put each one to me and wait.",
  "Do NOT act on anything until I confirm we have reached a shared understanding.",
].join("\n");

/** The domain-modeling capture rules, appended for the `-with-docs` variant. */
const DOCS_DISCIPLINE = [
  "This grill leaves a paper trail. Drive domain-modeling as you go:",
  "- When a term resolves, write it to CONTEXT.md right there (not batched at the end). CONTEXT.md is a glossary only — no implementation details. Use the project's own words.",
  "- Offer an ADR under docs/adr/ ONLY when a decision is all three: hard-to-reverse, surprising-without-context, AND the result of a real trade-off. Most sessions produce few or no ADRs.",
  "- Challenge terms against the existing CONTEXT.md; sharpen fuzzy language; probe edge cases; cross-reference the code.",
].join("\n");

/**
 * Build the grilling priming user-message.
 *
 * @param topic   the plan/decision/idea to grill about; undefined → current conversation
 * @param withDocs true for the flagship /grill-me-with-docs (adds domain-modeling capture)
 */
export function buildGrillPriming(topic: string | undefined, withDocs: boolean): string {
  const subject = topic?.trim() || "(the current conversation / plan under discussion)";
  const skillLine = withDocs
    ? "Load the `grilling` and `domain-modeling` skills and follow their discipline:"
    : "Load the `grilling` skill and follow its discipline:";
  const lines = [
    withDocs ? "Starting a grill-me-with-docs session." : "Starting a grilling session.",
    `Topic to grill: ${subject}`,
    "",
    skillLine,
    "",
    GRILL_DISCIPLINE,
  ];
  if (withDocs) {
    lines.push("", DOCS_DISCIPLINE);
  }
  lines.push("", "Begin with your first question now.");
  return lines.join("\n");
}

/**
 * Synthesize the grill output into a writing-plans-format seed — the grill→plan
 * handoff (ticket 08: migrated from the legacy task_plan phase-spine shape).
 * Output carries an inline `**Goal:**`, an optional glossary block, and one or
 * more `### Task N` sections with `- [ ]` steps — exactly what the plan
 * coordinator's `parsePlan` (pi-agent-ext-task) consumes.
 *
 * Two regimes:
 *  - decisions known (programmatic / future)  → a single Task with one step per decision.
 *  - decisions not yet extractable (the common case — they live in the
 *    conversation, not in a structure the command can read) → a skeleton seed
 *    with the glossary + one placeholder Task; the agent expands it.
 *
 * Returns null only when there is genuinely nothing to seed (no decisions, no
 * glossary, no topic).
 */
export function buildPlanSeed(decisions: ResolvedDecision[], glossary: GlossaryTerm[], topic?: string): string | null {
  if (decisions.length === 0 && glossary.length === 0 && !topic) return null;

  const lines: string[] = [];
  const goalLine = topic
    ? `**Goal:** _(from the grill: ${topic} — sharpen into a one-sentence end state.)_`
    : "**Goal:** _(Replace with the one-sentence end state agreed in the grill.)_";
  lines.push("# Implementation Plan — seeded from grill");
  lines.push("");
  lines.push(goalLine);
  lines.push("");

  appendSettledVocabulary(lines, glossary, "## Settled vocabulary (from CONTEXT.md)");

  if (decisions.length > 0) {
    lines.push("### Task 1: act on the resolved decisions");
    for (const d of decisions) {
      lines.push(`- [ ] ${d.title} — ${d.answer}`);
    }
  } else {
    lines.push("### Task 1: synthesize the resolved decisions");
    lines.push("- [ ] Expand this plan: one Task per resolved decision from the grill conversation.");
  }
  lines.push("");
  lines.push("> Generated by `/grill done --seed-plan`. Review/expand the Tasks, then execute the plan.");

  return lines.join("\n");
}
