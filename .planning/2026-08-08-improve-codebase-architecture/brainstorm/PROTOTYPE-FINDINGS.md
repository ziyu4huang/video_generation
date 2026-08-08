# Prototype findings — offline Markdown→HTML converter (C, ticket 04)

Throwaway de-risking prototype, not production. Built under `.planning/2026-08-08-improve-codebase-architecture/brainstorm/`: `sample-report.md` (2 candidate cards, Mermaid + ASCII) + `render-prototype.ts` (Bun/TS, stdlib only) + vendored `mermaid.min.js`.

## The 4 ticket-04 choices — RESOLVED

1. **Tailwind offline → static pre-built CSS (NOT play-CDN JS).** The prototype uses hand-written CSS to prove the *static-CSS* posture; production will build a curated static Tailwind stylesheet with only the report's classes. Play-CDN JIT rejected — heavier and the `eval`-style JIT fights the offline/`--offline` posture. *Why: static CSS is smaller and truly offline.*
2. **Mermaid offline → inlined vendored `mermaid.min.js` (UMD global), not an ESM bundle.** One `<script>` embeds the vendored UMD build; a second tiny `<script>` calls `mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" })`. Mermaid code-fences become `<pre class="mermaid">`. *Why: single self-contained file, no module graph, zero network.*
3. **Editorial visuals → Mermaid where graph-shaped, ASCII `<pre>` where editorial.** Candidate 1 (call-flow / leakage) is Mermaid `flowchart`; Candidate 2 (interface-vs-implementation mass) is an ASCII mass-diagram in a plain `<pre>`. The converter treats ```mermaid fences and plain fences differently. *Why: matches the HTML-REPORT guidance — "mix the two, don't lean on Mermaid for everything."*
4. **Converter shape → Bun script, CLI `render <in.md> [out.html]`, emits one self-contained offline HTML.** Default output `$TMPDIR/architecture-review-prototype.html`. In production this lives in `pi-agent-ext-wayfind` (vendored mermaid + static Tailwind checked into the package), invoked as a sub-skill command. *Why: Bun is already the toolchain; stdlib-only parse keeps the skill dependency-free.*

## What worked

- **Self-containment holds.** Stripping the inlined mermaid `<script>` leaves my own emitted HTML/CSS/markdown with **0** `cdn`/`http` references; all occurrences live inside the vendored mermaid source (library-internal, permitted). `open` loads it fully offline.
- **Side-by-side before/after** via a small rule: a bold-only line (`**Before**` / `**After**`) immediately before a fenced block becomes a caption, and two captioned blocks in a row collapse into a `.before-after` grid. Works for both Mermaid and ASCII.
- **Badge palette** (Strong=emerald, Worth exploring=amber, Speculative=slate) + left-border accent per card reads editorial, not dashboard-y. Stone/slate base holds up.
- **Zero-dep parser** handled the candidate-card structure (headings, fields, bullets, ```mermaid and plain fences, ADR callout) with ~60 lines.

## What's rough / production must do differently

- **Markdown parser is a toy.** Line-based; no nested lists, no tables, no blockquotes, no setext headings, fragile inline regex. Production needs a real parser (e.g. `marked` vendored, or a tiny hand-rolled one with a snapshot test) — the card structure is narrow enough that either is fine.
- **Real Tailwind build.** Replace hand-written CSS with a curated static Tailwind stylesheet generated at build time (only the report's classes purged), then inline it. Keeps the editorial look while staying single-file offline.
- **Mermaid vendored in the package.** The fetch (`curl ... mermaid@11/dist/mermaid.min.js`) is the vendoring step; in production `mermaid.min.js` (3.4 MB) lives **inside `pi-agent-ext-wayfind`**, not `.planning/`, and is committed (it's source, not regenerable build output, for a shipped skill). It is `.gitignore`d here because this brainstorm copy is regenerable and large.
- **Snapshot test.** Add a golden HTML snapshot (with mermaid stubbed) so converter changes are diffable.
- **Mermaid render check.** Mermaid renders client-side on `startOnLoad`; the prototype can't assert the SVG painted (no headless browser). Production should add a Playwright snapshot of at least one Mermaid card.
- **Diagrams ~320px tall** (HTML-REPORT guidance) not enforced — before/after Mermaid auto-sizes; ASCII is whatever the art is. Production should constrain heights so side-by-side doesn't scroll.

## Output

- Path: `$TMPDIR/architecture-review-prototype.html` (resolved: `/var/folders/r0/f18dr3wn6czf35q1xmktsjhm0000gn/T/architecture-review-prototype.html`)
- Size: **3,575,320 bytes** (≈3.4 MiB; ~99% is the inlined `mermaid.min.js`; my own HTML+CSS is ~9 KB).
- Self-contained check: my emitted HTML has **0** `cdn`/`http` refs; all 87 token hits are inside the vendored mermaid source.
