# improve-codebase-architecture (Deliverable C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `improve-codebase-architecture` as a command-style wayfind skill that scans this codebase for deepening opportunities (YAGNI hot-spot-scoped), presents them as a committed Markdown+Mermaid report with a deterministic offline HTML render, and grills the candidate the user picks — composing with the shipped `codebase-design`, `grilling`, and `domain-modeling` skills.

**Architecture:** A new command-style skill (`skills/improve-codebase-architecture/SKILL.md`, `disable-model-invocation: true`) adapted from the Matt-Pocock source into a three-step flow (Explore → Present → Grill). The Present step emits a committed Markdown report under `.planning/`; an offline Bun converter (`src/architecture-render.ts`, CLI `architecture:render`) renders it to one self-contained HTML using a curated static Tailwind build + inlined vendored `mermaid.min.js` (no CDN). The converter is pure (a `renderReport()` function) so it is golden-snapshot tested; a gated Playwright check asserts Mermaid actually paints. The skill consumes `codebase-design`'s vocabulary verbatim and follows `code-review`'s process hygiene.

**Tech Stack:** Markdown skill (`pi-agent-ext-wayfind`); Bun + TypeScript converter; `marked` (Markdown lexer); Tailwind v4 CLI (curated static CSS, built once, vendored, inlined); vendored `mermaid@11` UMD (inlined); `@playwright/test` (gated paint-check); Biome + `bun test` (CSO guard).

## Global Constraints

Copied verbatim from the spec — every task implicitly includes these:

- **All written artifacts in English** (skill body, converter code, comments, commits, the e2e report).
- **Command-style skill:** `disable-model-invocation: true`; explicit `/skill:improve-codebase-architecture` invocation only; never auto-fires.
- **Frontmatter must pass the CSO guard** `tests/skills.test.ts`: `name: improve-codebase-architecture` (matches `^[a-z0-9-]+$`); `description:` starts with the literal `Use when` and is ≤ 1024 chars; valid YAML to `Bun.YAML.parse`; body has a top-level H1.
- **Vocabulary is consumed VERBATIM from `codebase-design`** — module / interface / implementation / depth / deep / shallow / seam / adapter / leverage / locality; the deletion test; internal vs external seams. **Never** substitute component/service/unit (module), API/signature (interface), boundary (seam).
- **Process hygiene ported from `code-review`:** pin a fixed scan base (a commit/ref or "working tree"); every candidate cites its friction + the `codebase-design` principle it invokes; fail-fast on bad refs / empty scope; keep the Present step separate from the Grill step; scan is delegated to a subagent but the vocabulary synthesis + ranking are NOT.
- **Offline-only converter:** zero CDN, zero runtime network. Tailwind is a curated static build (vendored in the package, inlined); Mermaid is a vendored UMD `mermaid.min.js` (inlined). The default `bun test` stays green offline; only the gated Playwright paint-check needs a one-time browser download.
- **No superpowers skill-body edits** (ADR-0004). C lives in `pi-agent-ext-wayfind` only.
- **Skills register by directory scan** (`package.json` → `"pi": { "skills": ["./skills"] }`). **Zero manifest edit** — dropping `skills/improve-codebase-architecture/SKILL.md` is the whole registration.
- **Shell discipline:** subshell-only git — `( cd <dir> && ... )`, never top-level `cd`. `.planning/` artifacts are committed + pushed (standing rule). **PRESERVE the unstaged `.agents/memory/MEMORY.md` mod — never `git add` it, never `git add -A`.**
- **`skill-weight.test.ts` is out of scope to edit** — it pins 3 named skills (domain-modeling / grilling / grill-memory); the new skill is not among them, so it stays green untouched (confirmed in Task 4).

---

## File Structure

Every file this plan creates or modifies, with its one-line responsibility:

**In `bun-apps/pi-agent-ext-wayfind/`** (the owning package):

- **Create `skills/improve-codebase-architecture/SKILL.md`** — the command-style skill: the adapted three-step flow (Explore → Present → Grill), consuming `codebase-design` vocabulary verbatim and `code-review` process hygiene, delegating Grill→`grilling` + docs→`domain-modeling`, using `codebase-design` design-it-twice for alternative interfaces.
- **Create `src/architecture-render.ts`** — the offline converter: a pure `renderReport(markdown, css, mermaidSource, options)` that turns an architecture-review Markdown into one self-contained HTML (marked lexer → custom walk → cards/before-after/mermaid fences), plus a `main(argv)` CLI entry (`architecture:render <report.md> [out.html]`, default `$TMPDIR/architecture-review.html`).
- **Create `src/architecture.css`** — the curated Tailwind v4 entry: `@import "tailwindcss";` + `@source "./architecture-render.ts";` (pins the emitted utility set to the converter's own template → deterministic) + a small custom `@layer` for editorial classes (`.before-after`, `.diagram`, `.cap`, `.ascii`, `.mermaid`, `.adr`, `.legend`, `.card`, `.badge`, `.top`).
- **Create `vendor/tailwind.css`** — the built-once curated static Tailwind output (generated by `architecture:css`, **committed** because it is source for a shipped skill, inlined by the converter at render time). ~few KB.
- **Create `vendor/mermaid.min.js`** — the vendored `mermaid@11` UMD build (fetched once, **committed**, inlined at render time). ~3.4 MiB.
- **Create `tests/architecture-render.test.ts`** — the deterministic converter tests: golden-HTML snapshot (mermaid stubbed → small + byte-stable) + offline-assertion (full render, mermaid stripped, zero `https?://` refs) + a render smoke test.
- **Create `tests/architecture-mermaid.test.ts`** — the gated Playwright paint-check (`it.skipIf(process.env.RUN_RENDER !== "1")`): loads the full rendered HTML via `file://`, waits for `.mermaid svg`, asserts ≥ 1 diagram painted. This is the assertion the prototype could NOT make.
- **Create `tests/fixtures/architecture-render.golden.html`** — the committed golden output for the snapshot test (mermaid stubbed).
- **Modify `package.json`** — add `marked` (runtime dep, exact-pinned); add devDeps `tailwindcss`, `@tailwindcss/cli`, `@playwright/test`; add scripts `architecture:render` (`bun run src/architecture-render.ts`) and `architecture:css` (`bunx @tailwindcss/cli -i src/architecture.css -o vendor/tailwind.css --minify`).
- **No `.gitignore` change** — `vendor/` is NOT ignored (the package `.gitignore` covers only `node_modules/`, `dist/`, `*.tsbuildinfo`), so vendored assets commit cleanly.

**In `.planning/`** (committed + pushed):

- **Create `.planning/2026-08-08-improve-codebase-architecture/architecture-review-<YYYY-MM-DD>.md`** — the Task-5 end-to-end exercise report (the skill run on a real package; committed per the planning-artifacts standing rule).

This structure keeps the skill (prose, CSO-guarded) cleanly separated from the converter (code, unit-tested) — two independent review gates, each ending in a testable deliverable.

---

### Task 1: The skill — `improve-codebase-architecture/SKILL.md`

Create the command-style skill, validated by the CSO guard (`tests/skills.test.ts`) as its structural test.

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/skills/improve-codebase-architecture/SKILL.md`
- Test (the gate): `bun-apps/pi-agent-ext-wayfind/tests/skills.test.ts` (unchanged — it auto-discovers the new dir)

**Interfaces:**
- Consumes: `codebase-design` vocabulary (module/interface/implementation/depth/deep/shallow/seam/adapter/leverage/locality, deletion test, internal vs external seams); `code-review` process hygiene (pin scan base, cite findings, fail-fast, separate presentation); `grilling` (grill loop); `domain-modeling` (CONTEXT.md/ADR inline); `codebase-design` design-it-twice.
- Produces: a skill invocable as `/skill:improve-codebase-architecture` that, when run, writes `.planning/<effort>/architecture-review-<date>.md` and (optionally) renders it via `architecture:render`.

- [ ] **Step 1: Read the three composition sources in full** so the body references them accurately: `bun-apps/pi-agent-ext-wayfind/skills/codebase-design/SKILL.md` (vocabulary + design-it-twice link), `.../skills/code-review/SKILL.md` (process hygiene), and the upstream Matt-Pocock source `/Users/huangziyu/proj/pi-ext-matt-skills/skills/engineering/improve-codebase-architecture/SKILL.md` (the flow to adapt).

- [ ] **Step 2: Write `SKILL.md`** with EXACTLY this frontmatter (the `description` starts with `Use when`, is ≤ 1024 chars, and is the only always-on surface):

```markdown
---
name: improve-codebase-architecture
description: Use when you want to surface where this codebase's architecture shallows out and decide what to deepen — a command-style scan that scopes to where work actually happens (a direction you name or recent git hot spots), spawns a subagent to walk the code for friction raw, then synthesizes deepening candidates in the shared codebase-design vocabulary (module / interface / seam / depth / leverage / locality) using the deletion test, presents them as a committed Markdown + Mermaid report you can render to a self-contained offline HTML, and grills the candidate you pick. Never auto-fires.
disable-model-invocation: true
---

# Improve Codebase Architecture
```

- [ ] **Step 3: Write the body** as the adapted three-step flow. Use the upstream Matt-Pocock `SKILL.md` as the skeleton and apply these deltas (do NOT inline the vocabulary — reference `codebase-design` by name; do NOT edit any superpowers body — ADR-0004):

  - **Intro** (2–3 lines): surface architectural friction and propose **deepening opportunities**. State it is informed by the project's domain model and built on the shared `codebase-design` vocabulary — invoke that skill for the architecture terms (module/interface/depth/seam/adapter/leverage/locality) and use them exactly, never drifting into component/service/unit/API/signature/boundary. The domain language in the per-package `CONTEXT.md` names good seams; `docs/adr/` records decisions not to re-litigate.

  - **## Process → ### 1. Explore** — port Matt-Pocock's YAGNI scoping verbatim in spirit: **scope before you scan**. If the user named a direction (module/subsystem/pain point/package), take it and skip inference. Otherwise walk `git log --oneline` for hot spots (subshell-only git). Add **optional package-targeting** for this repo's distinct clusters (`bun-apps/pi-agent-ext-*`, `python/mlx-movie-director`, `bun-apps/gui-movie-director`). **Read the per-package `CONTEXT.md` + `docs/adr/` first.** Then **spawn a subagent** (pi `subagent`/`workflow`) to walk the codebase for friction **raw** — exploring organically, noting where understanding bounces between many small modules, where modules are shallow, where pure functions were extracted for testability without locality, where seams leak, where code is hard to test through its interface. The **skill synthesizes** the raw notes into deepening candidates using the `codebase-design` vocabulary and the **deletion test** (would deleting it concentrate complexity, or just move it?). Quote the upstream's five friction prompts verbatim.

  - **Process hygiene block (from `code-review`)** — pin the **scan base**: a commit/ref or "working tree", stated up front so the scan is reproducible. **Every candidate cites its friction + the `codebase-design` principle it invokes.** **Fail-fast** on a bad ref / empty scope before scanning. **The scan is delegated to a subagent; the vocabulary synthesis + ranking are NOT** — the skill does those directly. Keep the Present step separate from the Grill step.

  - **### 2. Present** — write a Markdown report to `.planning/<effort>/architecture-review-<date>.md` (**committed**, per the repo's planning-artifacts standing rule — never the OS temp dir; that was the upstream's choice, we keep the durable source-of-truth in the repo). One card per candidate with these fields, adapted to Markdown + Mermaid: **Files** / **Problem** / **Solution** / **Wins** (≤6-word bullets in glossary terms) / **strength badge** (`Strong` / `Worth exploring` / `Speculative`) / a **before-after diagram** (Mermaid `flowchart`/`sequence` where graph-shaped; ASCII `<pre>` where editorial — mass/cross-section). End with a **Top recommendation**. Use `CONTEXT.md` vocabulary for the domain, `codebase-design` vocabulary for the architecture. **ADR conflicts**: only surface a candidate that contradicts an ADR when the friction is real enough to warrant reopening it; mark it clearly. **Do NOT propose interfaces yet.** Then **optionally render** the report to a self-contained **offline** HTML via the package command `architecture:render <report.md> [out.html]` (default `$TMPDIR/architecture-review.html`) and tell the user the absolute path. Finally, **ask**: "Which of these would you like to explore?"

  - **### 3. Grill** — on the user's pick, **delegate to `grilling`** (relentless one-question-at-a-time with a recommended answer; facts looked up, decisions put to the user) to walk the decision tree: constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive. Side effects happen **inline** via **`domain-modeling`**: name a deepened module after a concept not in `CONTEXT.md` → add the term (create the file lazily); sharpen a fuzzy term → update `CONTEXT.md` there; user rejects a candidate with a load-bearing reason → offer an ADR. For **alternative interfaces** of the deepened module, **use `codebase-design`'s design-it-twice** (spin up parallel subagents to design the interface several radically different ways, compare on depth/locality/seam placement).

  - **Anti-delegation guard for synthesis** (one line): "Delegate the raw code walk to a subagent, but perform the vocabulary synthesis and the Top-recommendation ranking yourself — do not let the subagent pick the candidates."

- [ ] **Step 4: Verify frontmatter by hand** before the test run. Confirm: the `description:` value begins with the literal `Use when` (the CSO guard hard-checks `startsWith("Use when")`); the whole frontmatter block (between the `---` fences, exclusive) is ≤ 1024 chars; `name` is `improve-codebase-architecture`; there is a top-level `# Improve Codebase Architecture` H1 in the body.

```bash
( cd bun-apps/pi-agent-ext-wayfind && awk '/^---$/{c++; next} c==1{print}' skills/improve-codebase-architecture/SKILL.md | wc -c )
```
Expect ≤ 1024.

- [ ] **Step 5: Run the CSO guard (the test) and Biome.** The new skill dir is auto-discovered; `skills.test.ts` now runs its `describe("skill: improve-codebase-architecture", …)` block.

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/skills.test.ts && bun run check )
```
Expected: PASS — frontmatter delimited, valid YAML, name matches `^[a-z0-9-]+$`, description starts with "Use when" and is > 20 chars, ≤ 1024 chars, body has an H1. If any assertion fails, fix the frontmatter/body and re-run (this is the RED→GREEN loop for a prose skill).

- [ ] **Step 6: Commit.**

```bash
( cd /Users/huangziyu/proj/video_generation__superpowers && git add bun-apps/pi-agent-ext-wayfind/skills/improve-codebase-architecture/SKILL.md && git commit -m "feat(wayfind): add improve-codebase-architecture skill (deliverable C)" )
```

## Verify

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/skills.test.ts && bun run check )
ls bun-apps/pi-agent-ext-wayfind/skills/improve-codebase-architecture/SKILL.md
```
Green test run + the file exists. No other files touched. (Memory note: `git status --porcelain` after this commit still shows the unstaged ` M .agents/memory/MEMORY.md` and untracked `brainstorm/vendor/` — both untouched, as required.)

---

### Task 2: The offline converter — vendor + `architecture-render.ts` + Tailwind build

Build the converter as a pure function plus a CLI, vendoring the static Tailwind build and Mermaid UMD into the package. TDD: a render smoke test is written first (RED), then the converter makes it GREEN.

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/src/architecture-render.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/src/architecture.css`
- Create: `bun-apps/pi-agent-ext-wayfind/vendor/tailwind.css` (built, committed)
- Create: `bun-apps/pi-agent-ext-wayfind/vendor/mermaid.min.js` (fetched, committed)
- Modify: `bun-apps/pi-agent-ext-wayfind/package.json` (deps + scripts)
- Test (write first, RED): `bun-apps/pi-agent-ext-wayfind/tests/architecture-render.test.ts` (smoke only in this task; golden + offline assertions land in Task 3)

**Interfaces:**
- Consumes: the prototype at `.planning/2026-08-08-improve-codebase-architecture/brainstorm/render-prototype.ts` (the parse/render shape to productionize); `brainstorm/sample-report.md` (the canonical input).
- Produces: `renderReport(markdown: string, css: string, mermaidSource: string, options?: { mermaid?: boolean }): string` (pure, deterministic) and `main(argv: string[]): number` (CLI: `architecture:render <report.md> [out.html]`). The CLI reads `vendor/tailwind.css` + `vendor/mermaid.min.js` relative to `import.meta.dir`, default out `$TMPDIR/architecture-review.html`.

- [ ] **Step 1: Add the dependencies.** From the workspace root (`bun-apps/`), add to the wayfind package. **Exact-pin** `marked` so the golden snapshot stays byte-stable across installs.

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun add marked@^15 )
( cd bun-apps/pi-agent-ext-wayfind && bun add -d tailwindcss@^4 @tailwindcss/cli@^4 @playwright/test@^1 )
```
Confirm `package.json` now lists `marked` under `dependencies` and the three under `devDependencies`, and `bun-apps/bun.lock` updated. (Run `bun install` from `bun-apps/` if the linker didn't resolve — never from the repo root, per CLAUDE.md.)

- [ ] **Step 2: Add the two package scripts.**

```jsonc
// in package.json "scripts", add:
"architecture:render": "bun run src/architecture-render.ts",
"architecture:css": "bunx @tailwindcss/cli -i src/architecture.css -o vendor/tailwind.css --minify"
```

- [ ] **Step 3: Vendor Mermaid (one-time fetch).** Pull the UMD build into the package (the prototype already did this into `brainstorm/vendor/`; the production copy lives in the package and is committed).

```bash
( cd bun-apps/pi-agent-ext-wayfind && mkdir -p vendor && curl -fsSL https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js -o vendor/mermaid.min.js )
( cd bun-apps/pi-agent-ext-wayfind && test "$(stat -f%z vendor/mermaid.min.js)" -gt 1000000 && echo "mermaid vendored OK" )
```
Note: this one `curl` is the vendoring step (network at *authoring* time is fine — the *rendered output* is offline). After this, no runtime network is ever needed.

- [ ] **Step 4: Write `src/architecture.css`** — the curated Tailwind v4 entry. `@source` pins the emitted utility set to the converter's own template (deterministic); the custom `@layer` holds the editorial classes.

```css
@import "tailwindcss";

/* Only emit utilities that literally appear in the converter template → deterministic build. */
@source "./architecture-render.ts";

@layer components {
  .legend { @apply flex flex-wrap gap-3.5 text-xs uppercase tracking-wider text-slate-600 border-b border-stone-200 pb-4 mb-8; }
  .card { @apply bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm; }
  .card[data-strength="emerald"] { @apply border-l-[5px] border-l-emerald-600; }
  .card[data-strength="amber"] { @apply border-l-[5px] border-l-amber-600; }
  .card[data-strength="slate"] { @apply border-l-[5px] border-l-slate-500; }
  .badge { @apply text-[0.7rem] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full whitespace-nowrap; }
  .badge\.emerald { @apply bg-emerald-50 text-emerald-600 border border-emerald-200; }
  .badge\.amber { @apply bg-amber-50 text-amber-600 border border-amber-200; }
  .badge\.slate { @apply bg-slate-50 text-slate-600 border border-stone-300; }
  .before-after { @apply grid grid-cols-2 gap-4 my-2; }
  .diagram { @apply bg-stone-50 border border-stone-200 rounded-xl p-2.5 flex flex-col min-w-0; }
  .cap { @apply text-[0.72rem] font-bold uppercase tracking-wider text-slate-600 my-1; }
  .ascii { @apply m-0 bg-transparent overflow-auto font-mono text-[0.74rem] leading-snug text-slate-800 whitespace-pre; }
  .mermaid { @apply m-0 bg-transparent text-center; }
  .adr { @apply bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 text-sm text-amber-800 mt-1.5; }
  .top { @apply mt-10 bg-slate-900 text-stone-50 rounded-2xl p-7; }
}
```

- [ ] **Step 5: Build the curated static CSS (once) and commit it.**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run architecture:css )
( cd bun-apps/pi-agent-ext-wayfind && test -s vendor/tailwind.css && echo "tailwind built OK" )
```

- [ ] **Step 6: Write the RED smoke test** in `tests/architecture-render.test.ts` (this task only — the golden + offline assertions are added in Task 3):

```ts
import { describe, expect, it } from "bun:test";
import { renderReport } from "../src/architecture-render";

describe("architecture-render smoke", () => {
  it("renders a non-empty self-contained HTML document for the sample report", () => {
    const md = "# Architecture review — x\n\n## Candidate 1: Do the thing — Strong\n\n**Files**\n`a.ts`\n";
    const html = renderReport(md, "/*css*/", "", { mermaid: false });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("Architecture review — x");
    expect(html).toContain("Candidate 1");
    expect(html).toContain("/*css*/"); // CSS inlined
  });
});
```

- [ ] **Step 7: Run the smoke test to verify it FAILS** (module not found).

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/architecture-render.test.ts )
```
Expected: FAIL — `Cannot find module "../src/architecture-render"`.

- [ ] **Step 8: Implement `src/architecture-render.ts`.** Productionize the prototype's shape using `marked.lexer()` for a robust, deterministic parse. Required behavior:

  - `import { marked } from "marked";` and walk `marked.lexer(markdown)` tokens.
  - **Mermaid fences** (`code` token, `lang === "mermaid"`) → `<pre class="mermaid">{escaped code}</pre>`. **Plain code fences** → `<pre class="ascii"><code>{escaped code}</code></pre>`.
  - **Before/after collapse:** a bold-only paragraph (`**Before**` / `**After**`) immediately followed by a code block becomes a caption on that block; two captioned code blocks in a row collapse into a `<div class="before-after">` with two `<div class="diagram">` children. Works for both Mermaid and ASCII (mirror the prototype's `withCaptions` + `renderNodes`).
  - **Candidate cards:** an H2 matching `/^Candidate\s+(\d+):\s*(.+?)\s*[—-]\s*(Strong|Worth exploring|Speculative)$/` opens an `<article class="card" data-strength="{emerald|amber|slate}">` with a `<span class="badge {cls}">{label}</span>`; the card body is the rendered inner nodes.
  - **Top recommendation:** an H2 matching `/top recommendation/i` closes the cards section and opens `<section class="top">`.
  - **Header:** the first H1 → `<header><h1>{title}</h1></header>`; emit the legend row (solid box = module / dashed line = seam / red = leakage / dark box = deep module).
  - **ADR callout:** a paragraph beginning `**ADR**` → `<div class="adr">…</div>`.
  - **Assemble (deterministic):** `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>{title}</title><style>{css}</style></head><body><main>{header}{legend}{cards}{top}</main>` + (when `options.mermaid !== false`) `<script>{mermaidSource}</script><script>if(typeof mermaid!=="undefined"){mermaid.initialize({startOnLoad:true,theme:"neutral",securityLevel:"loose"});}</script>` + `</body></html>`. **No timestamps, no random ids** — byte-stable for a fixed input.
  - **`main(argv)`:** `argv[2]` = input `.md` (required, else `console.error("usage: architecture:render <report.md> [out.html]")` + `return 1`); `argv[3]` = out path, default `path.join(process.env.TMPDIR || "/tmp", "architecture-review.html")`. Read input, read `vendor/tailwind.css` + `vendor/mermaid.min.js` via `path.join(import.meta.dir, "..", "vendor", ...)`, call `renderReport`, write out, `console.log("wrote {out} ({bytes} bytes)")`, `return 0`.
  - Use the package's house style: double quotes, semicolons, 2-space indent, trailing commas (Biome enforces these — run `bun run check`).

- [ ] **Step 9: Run the smoke test to verify it PASSES.**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/architecture-render.test.ts )
```
Expected: PASS.

- [ ] **Step 10: Exercise the CLI end-to-end on the sample report** (the real proof the converter works on a graph-shaped + ASCII report):

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run architecture:render ../.planning/2026-08-08-improve-codebase-architecture/brainstorm/sample-report.md )
```
Open the printed path mentally: it must contain two candidate cards (one Mermaid before/after, one ASCII before/after), badges, and a Top recommendation. (Full assertions land in Task 3.)

- [ ] **Step 11: Biome + typecheck.**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run build )
```
Expected: green.

- [ ] **Step 12: Commit.**

```bash
( cd /Users/huangziyu/proj/video_generation__superpowers && git add bun-apps/pi-agent-ext-wayfind/package.json bun-apps/bun.lock bun-apps/pi-agent-ext-wayfind/src/architecture-render.ts bun-apps/pi-agent-ext-wayfind/src/architecture.css bun-apps/pi-agent-ext-wayfind/vendor/tailwind.css bun-apps/pi-agent-ext-wayfind/vendor/mermaid.min.js bun-apps/pi-agent-ext-wayfind/tests/architecture-render.test.ts && git commit -m "feat(wayfind): offline architecture-report HTML converter (marked + vendored tailwind/mermaid)" )
```

## Verify

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run architecture:render ../.planning/2026-08-08-improve-codebase-architecture/brainstorm/sample-report.md )
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/architecture-render.test.ts && bun run check && bun run build )
( cd bun-apps/pi-agent-ext-wayfind && test -s vendor/tailwind.css && test -s vendor/mermaid.min.js && echo "vendors present" )
```
Converter writes a self-contained HTML to `$TMPDIR`; smoke test green; Biome + tsc green; both vendor files non-empty and committed. The emitted HTML has NO `<script src=...>` and NO `https://` link tags (asserted formally in Task 3).

---

### Task 3: Converter tests — golden snapshot + offline-assertion + Playwright paint-check

Harden the converter with the three tests the spec mandates. The golden proves determinism; the offline-assertion proves self-containment; the Playwright check proves Mermaid actually paints (the prototype's admitted gap).

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/tests/architecture-render.test.ts` (add golden + offline assertions to the smoke test from Task 2)
- Create: `bun-apps/pi-agent-ext-wayfind/tests/architecture-mermaid.test.ts` (gated Playwright paint-check)
- Create: `bun-apps/pi-agent-ext-wayfind/tests/fixtures/architecture-render.golden.html` (committed golden; mermaid stubbed)

**Interfaces:**
- Consumes: `renderReport` from Task 2; `brainstorm/sample-report.md` as the canonical deterministic input.
- Produces: a green deterministic test suite + a committed golden + a gated browser paint-check.

- [ ] **Step 1: Add the offline-assertion test** to `tests/architecture-render.test.ts`. Full render (real mermaid source simulated by a short stub string so the suite stays small + offline), then strip the mermaid `<script>` block and assert zero non-vendored external refs — mirroring the prototype's proven check.

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { renderReport } from "../src/architecture-render";

const SAMPLE = readFileSync(
  join(import.meta.dir, "..", "..", ".planning", "2026-08-08-improve-codebase-architecture", "brainstorm", "sample-report.md"),
  "utf-8",
);
const CSS = readFileSync(join(import.meta.dir, "..", "vendor", "tailwind.css"), "utf-8");

describe("architecture-render offline + determinism", () => {
  it("emits zero non-vendored external refs (no CDN, no runtime network)", () => {
    const STUB = "/* mermaid stub */"; // stands in for the vendored blob
    const html = renderReport(SAMPLE, CSS, STUB, { mermaid: true });
    // Strip the inlined mermaid <script> blob (library-internal refs are permitted);
    // the REMAINING emitted HTML must have no http(s) refs.
    const stripped = html.replace(/<script>\/\* mermaid stub \*\/<\/script>/, "");
    const external = stripped.match(/https?:\/\//g) ?? [];
    expect(external.length, `found external refs: ${external.slice(0, 5)}`).toBe(0);
  });

  it("is deterministic — same input yields byte-identical output across calls", () => {
    const a = renderReport(SAMPLE, CSS, "", { mermaid: false });
    const b = renderReport(SAMPLE, CSS, "", { mermaid: false });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Add the golden snapshot test + commit the golden.** Render the sample with mermaid stubbed (keeps the committed golden small — the 3.4 MiB mermaid blob is NOT in the golden), compare byte-for-byte to the committed fixture, and write the fixture on first run.

```ts
// append to tests/architecture-render.test.ts
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

const GOLDEN_DIR = join(import.meta.dir, "fixtures");
const GOLDEN = join(GOLDEN_DIR, "architecture-render.golden.html");

describe("architecture-render golden snapshot", () => {
  it("matches the committed golden (regenerate with UPDATE_GOLDEN=1)", () => {
    const html = renderReport(SAMPLE, CSS, "", { mermaid: false });
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(GOLDEN, html, "utf-8");
    }
    expect(html).toEqual(readFileSync(GOLDEN, "utf-8"));
  });
});
```
Generate the golden and commit it:

```bash
( cd bun-apps/pi-agent-ext-wayfind && UPDATE_GOLDEN=1 bun test tests/architecture-render.test.ts )
```

- [ ] **Step 3: Run the render suite — expect PASS.** If the golden drifts (e.g. after a `marked` bump), regenerate with `UPDATE_GOLDEN=1` and re-commit; otherwise treat drift as a real regression to investigate.

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/architecture-render.test.ts )
```
Expected: PASS (offline-assertion + determinism + golden).

- [ ] **Step 4: Write the gated Playwright paint-check** in `tests/architecture-mermaid.test.ts`. It is **skipped by default** so `bun test` stays green offline (offline-first). It runs only under `RUN_RENDER=1`, after a one-time `bunx playwright install chromium`. This is the assertion the prototype could NOT make — call that out in a comment.

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "bun:test";
import { renderReport } from "../src/architecture-render";

const SAMPLE = await readFile(
  join(import.meta.dir, "..", "..", ".planning", "2026-08-08-improve-codebase-architecture", "brainstorm", "sample-report.md"),
  "utf-8",
);
const CSS = await readFile(join(import.meta.dir, "..", "vendor", "tailwind.css"), "utf-8");
const MERMAID = await readFile(join(import.meta.dir, "..", "vendor", "mermaid.min.js"), "utf-8");

/**
 * Paint-check the prototype could NOT make: Mermaid renders client-side on
 * `startOnLoad`; this test loads the FULL rendered HTML (real vendored mermaid)
 * in a headless browser and asserts the `<pre class="mermaid">` blocks were
 * replaced with real `<svg>` diagrams.
 *
 * Gated: needs a one-time `bunx playwright install chromium` (network). Skipped
 * by default so `bun test` stays green offline; run with RUN_RENDER=1.
 */
describe.skipIf(process.env.RUN_RENDER !== "1")("architecture-render mermaid paint", () => {
  it("paints at least one Mermaid diagram to SVG", async () => {
    const html = renderReport(SAMPLE, CSS, MERMAID, { mermaid: true });
    const file = join(process.env.TMPDIR || "/tmp", "architecture-mermaid-paintcheck.html");
    writeFileSync(file, html, "utf-8");

    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`file://${file}`);
    // Mermaid swaps <pre class="mermaid"> for a div containing an <svg>.
    await page.waitForSelector(".mermaid svg", { timeout: 10_000 });
    const count = await page.locator(".mermaid svg").count();
    await browser.close();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 5: Run the full package test suite (default = offline).** The Playwright test must be SKIP, the rest PASS.

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test )
```
Expected: the mermaid `describe` reports `skip`; `architecture-render.test.ts` is fully green; `skills.test.ts` green.

- [ ] **Step 6: Run the Playwright paint-check once (opt-in).** Install the browser, then run gated.

```bash
( cd bun-apps/pi-agent-ext-wayfind && bunx playwright install chromium )
( cd bun-apps/pi-agent-ext-wayfind && RUN_RENDER=1 bun test tests/architecture-mermaid.test.ts )
```
Expected: PASS — ≥ 1 `.mermaid svg` painted. (If it fails with a timeout, mermaid did not initialize — re-check the `startOnLoad`/`securityLevel` init script in `renderReport`.)

- [ ] **Step 7: Commit.**

```bash
( cd /Users/huangziyu/proj/video_generation__superpowers && git add bun-apps/pi-agent-ext-wayfind/tests/architecture-render.test.ts bun-apps/pi-agent-ext-wayfind/tests/architecture-mermaid.test.ts bun-apps/pi-agent-ext-wayfind/tests/fixtures/architecture-render.golden.html && git commit -m "test(wayfind): golden + offline + playwright tests for architecture converter" )
```

## Verify

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test )                                   # offline default: render suite green, paint-check skip
( cd bun-apps/pi-agent-ext-wayfind && RUN_RENDER=1 bun test tests/architecture-mermaid.test.ts )  # opt-in: mermaid paints
```
Golden committed + byte-stable; offline-assertion = 0 external refs; determinism holds; Playwright paints ≥ 1 SVG when run.

---

### Task 4: Guards — full `bun test` + `bun run check`, skill-weight relevance

Confirm the whole package stays green with the new skill + converter, and confirm `skill-weight.test.ts` is irrelevant to this change.

**Files:**
- No creates/modifies — this task is verification only (it surfaces regressions to fix back in Tasks 1–3).

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: a green full-suite + Biome run; a documented "no-op" verdict on `skill-weight.test.ts`.

- [ ] **Step 1: Run the full suite + Biome + typecheck.**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run build && bun test )
```
Expected: all green. `skills.test.ts` runs its new `skill: improve-codebase-architecture` block and passes; `architecture-render.test.ts` green; the Playwright `describe` skips; `skill-weight.test.ts` green and unchanged.

- [ ] **Step 2: Confirm `skill-weight.test.ts` relevance.** Read it: it pins the `description` length + trigger-noun for exactly THREE named skills — `domain-modeling`, `grilling`, `grill-memory` (the latter in the hermes-memory package). The new `improve-codebase-architecture` skill is NOT in its `TARGETS` array, so it is **out of scope** — no edit, no new target. The command-style skill is also deliberately excluded from the always-on weight gate (it never auto-fires, so its `description` weight is irrelevant to the on-demand loader). Record this verdict in the commit message (Step 3) — there is no code change here.

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/skill-weight.test.ts )
```
Expected: PASS (unchanged).

- [ ] **Step 3: Commit the verdict** (documentation-only; if there is nothing to stage, skip the commit and note "no changes — guards green"). If Tasks 1–3 already left the tree clean, this step is a no-op; otherwise stage any trivial guard-fix.

```bash
( cd /Users/huangziyu/proj/video_generation__superpowers && git status --porcelain )
```
If clean → done (note "guards green, no diff"). If not → fix and commit with `chore(wayfind): keep full suite + biome green for improve-codebase-architecture`.

## Verify

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run build && bun test )
```
Full suite + Biome + tsc green. `skill-weight.test.ts` untouched and green (new skill correctly excluded). Memory mod + `brainstorm/vendor/` still the only non-task changes in `git status --porcelain`.

---

### Task 5: End-to-end exercise — run the skill on a real package, commit the report, render it

The behavioral gate (mirrors A's GREEN exercise): run `improve-codebase-architecture` on a real `pi-agent-ext-*` package, produce a committed `.planning/` report, render the offline HTML, and confirm cards + vocabulary + diagrams are well-formed.

**Files:**
- Create: `.planning/2026-08-08-improve-codebase-architecture/architecture-review-<YYYY-MM-DD>.md` (the report; committed + pushed)

**Interfaces:**
- Consumes: the shipped skill (Task 1) + the converter (Task 2).
- Produces: a real architecture-review report + its offline HTML render, manually reviewed.

- [ ] **Step 1: Pick the target package.** Default: **`bun-apps/pi-agent-ext-wayfind`** (dogfood the package that hosts the skill — honest and low-risk). Fallback if it is too small/already deep: `bun-apps/pi-agent-ext-hermes-memory`. State the pick + the pinned scan base (e.g. `HEAD` on this branch) in the report header.

- [ ] **Step 2: Run the skill's Explore + Present flow** (manual orchestration, following `SKILL.md`): read the package's `CONTEXT.md` + `docs/adr/`; spawn a subagent to walk the package for friction raw; synthesize 2–4 deepening candidates in the `codebase-design` vocabulary with the deletion test; pin the scan base; cite each candidate's friction + principle. **Do NOT propose interfaces.**

- [ ] **Step 3: Write the report** to `.planning/2026-08-08-improve-codebase-architecture/architecture-review-<YYYY-MM-DD>.md` using the card schema from the skill's Present step: per candidate — Files / Problem / Solution / Wins (≤6-word glossary bullets) / strength badge / before-after diagram (Mermaid where graph-shaped, ASCII where editorial) — plus a Top recommendation. Use `CONTEXT.md` vocabulary for the domain, `codebase-design` vocabulary for the architecture.

- [ ] **Step 4: Render the offline HTML** from the committed report.

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run architecture:render ../../.planning/2026-08-08-improve-codebase-architecture/architecture-review-<YYYY-MM-DD>.md )
```

- [ ] **Step 5: Manual review of report + render.** Confirm: (a) every candidate uses only glossary terms (module/interface/seam/depth/deep/shallow/adapter/leverage/locality) — grep for forbidden substitutes and find none; (b) each candidate cites its friction + the `codebase-design` principle; (c) Mermaid before/after blocks parse (open the HTML, diagrams paint); (d) the Top recommendation names one candidate + why; (e) the report renders self-contained (no CDN refs — re-run the offline-assertion mentally: the converter guarantees it).

```bash
( cd /Users/huangziyu/proj/video_generation__superpowers && grep -nE '\b(component|service|unit|API|signature|boundary)\b' .planning/2026-08-08-improve-codebase-architecture/architecture-review-*.md || echo "no forbidden vocabulary substitutes" )
```
Expected: "no forbidden vocabulary substitutes" (or only legitimate occurrences in quoted file paths/names — judge each hit).

- [ ] **Step 6: Commit + push the report** (planning-artifacts standing rule).

```bash
( cd /Users/huangziyu/proj/video_generation__superpowers && git add .planning/2026-08-08-improve-codebase-architecture/architecture-review-<YYYY-MM-DD>.md && git commit -m "docs(architecture): e2e exercise report for improve-codebase-architecture on pi-agent-ext-wayfind" )
( cd /Users/huangziyu/proj/video_generation__superpowers && git push )
```

## Verify

```bash
( cd /Users/huangziyu/proj/video_generation__superpowers && ls .planning/2026-08-08-improve-codebase-architecture/architecture-review-*.md )
( cd bun-apps/pi-agent-ext-wayfind && bun run architecture:render ../../.planning/2026-08-08-improve-codebase-architecture/architecture-review-*.md )
```
Report committed + pushed; offline HTML renders with painted diagrams; vocabulary clean; Top recommendation present. This is the behavioral GREEN that closes the deliverable.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

- *Problem/Solution (3-step flow)* → Task 1 (skill body: Explore/Present/Grill).
- *Implementation Decisions — Location & registration* → Task 1 Step 2 (frontmatter) + File Structure note (directory scan, no manifest).
- *Frontmatter (`name`/`description`/`disable-model-invocation`)* → Task 1 Steps 2 + 4 + 5 (CSO guard is the test).
- *Vocabulary verbatim from `codebase-design`* → Task 1 Step 3 (intro + Grill) + Global Constraints + Task 5 Step 5 grep gate.
- *Process hygiene from `code-review`* → Task 1 Step 3 (pin scan base, cite, fail-fast, separate presentation, scan-delegated/synthesis-not) + Global Constraints.
- *Explore (YAGNI scoping, package-targeting, CONTEXT.md/ADR first, subagent walks raw, skill synthesizes)* → Task 1 Step 3.
- *Present (`.planning/` Markdown report, card fields, badges, Top rec, offline HTML render)* → Task 1 Step 3 + Task 2 (converter) + Task 5 (real report).
- *Grill (delegate to `grilling` + `domain-modeling`, design-it-twice)* → Task 1 Step 3.
- *Offline converter (Bun script, CLI, marked, curated Tailwind, inlined mermaid, Mermaid fences → `<pre class=mermaid>`, ASCII → `<pre>`, deterministic)* → Task 2.
- *Testing Decisions (CSO guard, golden snapshot, offline-assertion, Playwright paint-check, e2e exercise)* → Tasks 1, 3, 5.
- *Out of Scope respected* → no superpowers edits (Global Constraints), no CDN (Task 2 + Task 3 offline-assertion), no auto-invocability (`disable-model-invocation`), no `agents/openai.yaml` port.

**2. Placeholder scan** — no TBD/TODO/"implement later"; every code step shows the actual content (frontmatter, CSS, test bodies, converter behavior spec, CLI signature). The skill body (Task 1 Step 3) is specified as concrete section-by-section deltas from the upstream source the implementer reads in Step 1 — not "write a skill."

**3. Type/name consistency** — `renderReport(markdown, css, mermaidSource, options?)` is defined in Task 2 Step 8 and consumed identically in Task 3 Steps 1–2 and Task 3 Step 4; `main(argv)` is defined once (Task 2 Step 8) and invoked via the `architecture:render` script (Task 2 Step 2, Task 5 Step 4). Vendor paths `vendor/tailwind.css` + `vendor/mermaid.min.js` are consistent across File Structure, Task 2, Task 3. The `RUN_RENDER=1` gate and `UPDATE_GOLDEN=1` regen flag are used consistently.

---

## Execution Handoff

Plan complete and saved to `.planning/2026-08-08-improve-codebase-architecture/plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

> **Notes for the executor:**
> - **PRESERVE `.agents/memory/MEMORY.md`** — it has an unstaged mod throughout; never `git add` it, never `git add -A` (every commit above uses explicit paths).
> - **`brainstorm/vendor/` stays untracked** — it is the prototype's regenerable mermaid copy (gitignored in that effort); the production vendor is `bun-apps/pi-agent-ext-wayfind/vendor/`.
> - Tasks 2 and 3 are the only ones needing `bun install` / a one-time network fetch (vendoring mermaid, Playwright browser); the rest are offline.
> - Task 5 is the behavioral GREEN — do not skip it; it is the proof the skill + converter work together on a real package.
