/**
 * render-markdown.ts — server-side markdown -> HTML (specs/06 D3/D6).
 *
 * `marked@^15` is server-side only; the browser shell never renders markdown
 * itself (it injects the HTML this produces). `{ async: false }` forces the
 * synchronous return so the type narrows to `string`.
 */
import { marked } from "marked";

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
