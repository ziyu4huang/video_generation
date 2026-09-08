/**
 * vlm/mermaid.ts — light mermaid-block handling for vision descriptions (D15).
 *
 * Vision models asked to reconstruct flow/architecture diagrams emit fenced
 * ```mermaid blocks. We do NOT render or deeply validate them (no mermaid
 * engine, no new deps — the ADR-file2md-0001 posture): the only contract is that a block
 * that reaches a note LOOKS like mermaid (fence + a known first keyword).
 * A block that fails the keyword check is unwrapped — the body stays as
 * prose — and an unrecoverable case never fails the page (D4 discipline).
 */

/** First keywords of the mermaid diagram types worth reconstructing. */
const MERMAID_KEYWORDS: RegExp[] = [
  /^(?:graph|flowchart)\b/i,
  /^sequenceDiagram\b/i,
  /^stateDiagram(?:-v2)?\b/i,
  /^classDiagram\b/i,
  /^erDiagram\b/i,
  /^journey\b/i,
  /^gantt\b/i,
  /^pie\b/i,
  /^mindmap\b/i,
  /^timeline\b/i,
  /^quadrantChart\b/i,
  /^gitGraph\b/i,
];

/** True when `body` starts with a known mermaid diagram keyword. */
export function looksLikeMermaid(body: string): boolean {
  const head = body.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return MERMAID_KEYWORDS.some((re) => re.test(head.trim()));
}

/**
 * Post-process a vision description: every fenced ```mermaid block whose body
 * fails the keyword check is unwrapped to plain text (fence markers removed,
 * body kept); valid blocks pass through untouched; prose is never altered.
 */
export function sanitizeMermaidBlocks(md: string): string {
  return md.replace(/```mermaid[^\S\n]*\n([\s\S]*?)```/g, (_m, body: string) =>
    looksLikeMermaid(body) ? `\`\`\`mermaid\n${body}\`\`\`` : body.trimEnd(),
  );
}
