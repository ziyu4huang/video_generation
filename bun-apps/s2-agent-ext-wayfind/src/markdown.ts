/** Fs-free markdown section parsing. Shared core for the wayfind map + grill
 *  pipelines. Lenient section keys (suffix-stripped before keying) so
 *  `## Resolution (closed …)` / `## Section — desc` / `## Notes: x` all resolve
 *  under `Resolution` / `Section` / `Notes`. Kept fs-free so it can be imported
 *  by both the fs-free model.ts and the import-light grill.ts. */

/** Extract the body of a named `## Section` (text between this heading and the
 *  next `## ` or EOF). Returns "" when absent. Lenient: a suffixed heading
 *  like `## Decisions (draft)` resolves to `Decisions`. */
export function extractSection(md: string, heading: string): string {
  return parseMapBody(md)[heading] ?? "";
}

/** Parse a `## Section`-delimited body into a map of section→text. Sections
 *  without a heading (preamble) land under key "". Body trimmed; last section
 *  wins on duplicate keys. */
export function parseMapBody(md: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = md.split(/\r?\n/);
  let current = "";
  let buf: string[] = [];
  const flush = () => {
    sections[current] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      flush();
      current = m[1].split(/[(\u2014\u2013:]/)[0].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}
