/**
 * No-bash-skills guard — the portable-bun migration's seal (effort
 * .planning/2026-08-23-portable-bun-scripts/, Task 12).
 *
 * THE PATTERN THIS EXISTS TO BREAK
 *   Waves 1-3 converted every skill-facing bash script to a plain Bun (.ts)
 *   twin and DELETED the .sh: dedup.sh, run-test.sh, ci-local.sh, smoke.sh,
 *   find-polluter.sh (plus smoke-e2e.sh / update-superpowers.sh / the template).
 *   A reference to a deleted .sh has no executor inside a DOC — nothing imports
 *   a SKILL.md, nothing executes a comment — and inside CODE the failure mode
 *   is nasty precisely because it compiles: a spawn/`existsSync` probe pointing
 *   at `run-test.sh` is type-correct TS and just returns null / ENOENT at
 *   runtime (deploy-run.ts probes the pair src/deploy/run.ts + scripts/run-test.ts
 *   exactly to keep that class out; Task 8's reviewer flagged it). Task 11
 *   repointed every consumer; this guard pins the surface so it can neither
 *   regrow nor quietly regress in a future rename.
 *
 * WHAT IS ASSERTED — docs surface (active SKILL.md)
 *   1. No SKILL.md inside bun-apps/s2-agent-ext-* /skills/ (one dir deep,
 *      the per-skill dir) mentions any of the five deleted tools by name.
 *      Allowed exceptions, by design (spec.md D6):
 *      `wizard/template.sh` (human-run artifact — Bun not guaranteed on the
 *      human's machine) and `dsh-plugin/sv-analyzer/build.sh` (external cargo+
 *      zig build, not Bun) — each cited as D6 below.
 *   2. Every OTHER `.sh` mention in an active SKILL.md is a documented
 *      exception too — the plan's "final grep must return only documented
 *      exceptions" as a standing check: the mention must be (a) a D6 exception,
 *      (b) a D7 core-s2-agent script (bare `run.sh` → bun-apps/s2-agent/run.sh),
 *      (c) a live script that exists on disk, or (d) explicitly history-labeled
 *      on the same line ("old", "used to", "retired", …). A new SKILL.md
 *      pointing at a script that does not exist fails here instead of on the
 *      first agent that follows the doc.
 *
 * WHAT IS ASSERTED — code surface
 *   3. No literal of the five deleted tools remains in:
 *        bun-apps/s2-agent-ext-devops/src/**        (deploy probes, raises)
 *        bun-apps/tests/ci-workflow-references.test.ts
 *        bun-apps/s2-agent/src/doctor.ts            (hint text spawns/verifies)
 *        bun-apps/s2-agent-ext-devops/extensions/devops.ts
 *                                                    (tool-registration surface —
 *                                                    what agents READ for a tool's
 *                                                    description)
 *        bun-apps/s2-agent-ext-devops/CONTEXT.md    (agent-loaded context)
 *      A mention on a CODE line (or an unlabeled comment) is a violation: that
 *      is the deploy-probe/verify-tool-spawn class. In the two agent-facing
 *      surfaces above, devops.ts code lines (incl. tool-description strings)
 *      follow that same rule (its comments keep the history-label relief),
 *      while devops' CONTEXT.md is scanned STRICT — there even a
 *      history-labeled mention is a violation: prose has no comment-vs-code
 *      distinction, a labeled alias still seeds agent lookups, and the
 *      `**Term**` glossary shape collides with the comment heuristic anyway.
 *
 * THE HISTORY EXEMPTION (comments only), and its one documented relaxation
 *   A comment line that mentions a deleted name is allowed ONLY inside a
 *   comment block that explicitly labels the mention as history — the block
 *   must contain one of: "history", "old", "used to", "retired", "pre-Bun-port"
 *   / "pre-port". Two surviving mentions are exactly this class and are the REASON
 *   the rule exists:
 *     - s2-agent-ext-devops/src/deploy-run.ts:12-14 — "It used to be
 *       scripts/deploy.ts + run-test.sh (the pre-Bun-port name)".
 *     - tests/ci-workflow-references.test.ts:239-240 — "run-test.sh used to be
 *       pinned here (the pre-Bun-port name)… no workflow job references it".
 *   Relaxation vs the brief's per-line framing: the label is required for the
 *   WHOLE contiguous comment block, not the single line. Per-line would fail
 *   on ci-workflow-references.test.ts:240, whose label sits on the line above
 *   ("used to be pinned" on 239, the continuation "which ran run-test.sh's" on
 *   240). The block is one thought; the label must be inside it. Blank lines
 *   inside a block (JSDoc gutters) do not split it.
 *
 * WHY SOME SURFACES ARE EXCLUDED (deliberately, and pinned by other tests)
 *   - s2-agent-ext-devops/scripts/run-test.ts + ci-local.ts PRINT "run-test.sh"
 *     in their banner / `--list` help / "try: ./run-test.sh --list" hint. That
 *     text is the OUTPUT CONTRACT — the .ts twin must byte-match the .sh's
 *     output (D3/D4), so the old name is frozen inside the live twin by the
 *     parity tests (run-test-parity.test.ts, ci-local-parity.test.ts), not by
 *     this guard.
 *   - tests/{goldens,run-test-launchers-parity.test.ts,helpers/bash-parity.test.ts,
 *     verify-tool,ci-local-parity,run-test-parity,package-scripts-runnable,
 *     changed-packages-cli}.test.ts etc. carry "captured from <name>.sh@<sha>"
 *     provenance and golden text that VERBATIM contains the old names — that is
 *     the .sh→.ts parity evidence (D3), frozen by design.
 *   - README.md / CONTEXT.md history prose of OTHER packages (outside devops,
 *     whose own CONTEXT.md + extensions/devops.ts ARE sealed above — they are
 *     agent-facing: the tool description is what agents read and CONTEXT.md is
 *     loaded into agent context, so a deleted name there rots exactly like a
 *     SKILL.md mention). Each remaining mention labels itself retired.
 *
 * The guard is a static read of the repo tree (no spawn, no env) — fully
 * portable, still meaningful in CI. Its real-assertion integrity is proven by
 * the negative-control suite below, which feeds the SAME scanners virtual
 * content and asserts detection.
 *
 * PORTABILITY-GUARDED: the only spawnSync token in this file lives INSIDE a
 * planted string fed to the negative-control scanner as virtual content — the
 * scanner never spawns anything; this suite only readFileSync/readdirSyncs the
 * committed tree, so it is CI-safe by construction and must run there (it is
 * the portable-bun seal and a regression-gates step).
 *
 * Run: bun run test:no-bash-skills   (from bun-apps/)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BUN_APPS = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(BUN_APPS, "..");

/** One scanned code-surface file. `strict` = prose surface (CONTEXT.md):
 * no comment-vs-code detection — ANY mention is a violation, because prose
 * lines ``**Term**``-style collide with the JSDoc-bullet heuristic and the
 * reader cannot see whether a label was "comment history" or agent context. */
interface CodeSurfaceFile {
  path: string;
  content: string;
  strict?: boolean;
}

/** The five skill tools whose .sh was deleted after its .ts twin shipped. */
const BANNED_TOOLS = ["dedup.sh", "run-test.sh", "ci-local.sh", "smoke.sh", "find-polluter.sh"] as const;

/**
 * History labels that make a comment mention of a deleted name legitimate.
 * Kept tight per the brief (history/old/used to/retired) plus the two
 * pre-port forms the surviving mentions actually use.
 */
const HISTORY_RE = /\b(history|old|used to|retired|pre-[Bb]un-port|pre-port)\b/;

/** D6 by-design-bash exceptions (spec.md D6): wizard template + external sv-analyzer build. */
const D6_EXCEPTIONS = ["wizard/template.sh", "dsh-plugin/sv-analyzer/build.sh"] as const;

/** A SKILL.md under bun-apps/<pkg>/skills/<skill>/ (the active-skill surface). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function activeSkillDocs(): { path: string; content: string }[] {
  const docs: { path: string; content: string }[] = [];
  for (const pkg of readdirSync(BUN_APPS)) {
    if (!pkg.startsWith("s2-agent-ext-")) continue;
    const skillsDir = join(BUN_APPS, pkg, "skills");
    if (!isDir(skillsDir)) continue;
    for (const skill of readdirSync(skillsDir)) {
      if (!isDir(join(skillsDir, skill))) continue;
      const p = join(skillsDir, skill, "SKILL.md");
      if (existsSync(p)) docs.push({ path: p, content: readFileSync(p, "utf8") });
    }
  }
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every .ts file under a dir, recursively (devops src/**). */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFilesUnder(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The code surfaces the guard seals — the deploy-probe/verify-spawn class lives here. */
function codeSurfaceFiles(): { path: string; content: string }[] {
  const files = [
    ...tsFilesUnder(join(BUN_APPS, "s2-agent-ext-devops", "src")),
    join(BUN_APPS, "tests", "ci-workflow-references.test.ts"),
    join(BUN_APPS, "s2-agent", "src", "doctor.ts"),
    // Agent-facing surfaces (w3 final review): the tool-registration surface is
    // what agents actually READ for a tool's description, and devops' CONTEXT.md
    // is agent-loaded context (and its glossary _Avoid_ lines name aliases) — a
    // deleted name in either has the same ENOENT-following risk as a SKILL.md
    // mention, unlike src/** comments that merely tell the story. Both are
    // mention-free today; a bare mention in the agent-read TEXT (description
    // strings, glossary prose) is a violation regardless of history labeling —
    // a labeled alias still seeds tool lookups in agent context.
    join(BUN_APPS, "s2-agent-ext-devops", "extensions", "devops.ts"),
    { path: join(BUN_APPS, "s2-agent-ext-devops", "CONTEXT.md"), strict: true },
  ];
  return files.map((path) => {
    if (typeof path === "string") return { path, content: readFileSync(path, "utf8") };
    return { ...path, content: readFileSync(path.path, "utf8") };
  });
}

interface Hit {
  file: string;
  line: number;
  term: string;
  note: string;
}

function hitText(hits: Hit[]): string {
  return hits.map((h) => `${h.file}:${h.line}: ${h.term} — ${h.note}`).join("; ");
}

// ── docs-surface scan engine ────────────────────────────────────────────────

/** Every `<...>.sh` token in a doc (path fragments; `.sha`-style suffixes excluded). */
function shTokens(content: string, path: string): { term: string; line: number }[] {
  const out: { term: string; line: number }[] = [];
  content.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[^\w./-])([A-Za-z0-9./_-]+\.sh)(?![A-Za-z0-9-])/g)) {
      out.push({ term: m[1], line: i + 1 });
    }
  });
  return out;
}

/** Live-script resolution: repo-root/bun-apps-relative, plus the D7 core run.sh. */
function resolvesOnDisk(token: string): boolean {
  if (token.includes("/")) return existsSync(resolve(REPO_ROOT, token)) || existsSync(resolve(BUN_APPS, token));
  // Bare token: a top-level launcher (s2-agent.sh — a tracked repo-root symlink
  // kept live by the deploy effort) resolves against the repo root, so
  // existence is the test. D7 (spec.md) remains: `run.sh` is the s2-agent core
  // bootstrap and only exists at bun-apps/s2-agent/run.sh, not at the root.
  return existsSync(resolve(REPO_ROOT, token)) || (token === "run.sh" && existsSync(join(BUN_APPS, "s2-agent", "run.sh")));
}

function isD6(token: string, docPath: string): boolean {
  for (const d6 of D6_EXCEPTIONS) if (token === d6) return true;
  // The wizard SKILL.md links its template package-relatively: [template.sh](template.sh).
  return token === "template.sh" && docPath.includes(`${sepFrom(docPath)}wizard${sepFrom(docPath)}`);
}
function sepFrom(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

/**
 * Full docs-surface rule set (assertions 1+2 of the header). A mention is a
 * violation unless it is a D6 exception, a D7/live script, or a same-line
 * history label.
 */
export function scanDocsSurface(docs: { path: string; content: string }[]): Hit[] {
  const hits: Hit[] = [];
  for (const doc of docs) {
    const lines = doc.content.split("\n");
    for (const { term, line } of shTokens(doc.content, doc.path)) {
      const banned = (BANNED_TOOLS as readonly string[]).includes(term);
      if (banned) {
        hits.push({
          file: doc.path,
          line,
          term,
          note: `a deleted bash tool name — its Bun twin replaced it; delete the mention or move it into the .ts docs`,
        });
        continue;
      }
      if (isD6(term, doc.path) || resolvesOnDisk(term)) continue;
      const lineText = lines[line - 1] ?? "";
      if (HISTORY_RE.test(lineText)) continue;
      hits.push({
        file: doc.path,
        line,
        term,
        note: `.sh mention that is neither a D6 exception, a live script, nor history-labeled — the docs surface must reference only documented exceptions`,
      });
    }
  }
  return hits;
}

// ── code-surface scan engine ────────────────────────────────────────────────

/** Is the line a comment line (full-line or trailing `//`), and what is the comment text? */
function commentPart(line: string): { isComment: boolean; text: string } {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) {
    return { isComment: true, text: line };
  }
  const idx = t.indexOf("//");
  // A trailing `//` comment — but not one sitting inside a string literal in
  // the prefix (`"a//b"` / 'a//b' / `a//b`).
  if (idx > 0 && !/["'`]/.test(t.slice(0, idx))) return { isComment: true, text: t.slice(idx) };
  return { isComment: false, text: "" };
}

/**
 * Split lines into contiguous comment blocks. Blank lines (JSDoc gutters) do
 * not split a block; a block always contains at least one comment line.
 */
function commentBlocks(lines: string[]): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let open: { start: number; lines: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const { isComment } = commentPart(lines[i]);
    const blank = lines[i].trim() === "";
    if (isComment) {
      if (open === null) open = { start: i + 1, lines: [] };
      open.lines.push(lines[i]);
    } else if (!blank && open !== null) {
      out.push({ start: open.start, text: open.lines.join("\n") });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open.start, text: open.lines.join("\n") });
  return out;
}

/**
 * Code-surface rule (assertion 3): a banned name on a code line is always a
 * violation; on a comment line it is allowed only inside a history-labeled
 * comment block. A `strict` file (CONTEXT.md — prose, no comment-vs-code
 * distinction) treats EVERY line as code: any mention is a violation.
 */
export function scanCodeSurface(files: CodeSurfaceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    const blocks = commentBlocks(lines);
    lines.forEach((line, i) => {
      if (!BANNED_TOOLS.some((b) => line.includes(b))) return;
      const { isComment } = file.strict ? { isComment: false } : commentPart(line);
      if (!isComment) {
        hits.push({
          file: file.path,
          line: i + 1,
          term: BANNED_TOOLS.find((b) => line.includes(b))!,
          note: "a CODE line references a deleted bash tool — this is the spawn/probe class; point it at the .ts twin",
        });
        return;
      }
      const block = blocks.find((b) => i + 1 >= b.start && i + 1 <= b.start + b.text.split("\n").length - 1);
      const labeled = block !== undefined && HISTORY_RE.test(block.text);
      if (!labeled) {
        hits.push({
          file: file.path,
          line: i + 1,
          term: BANNED_TOOLS.find((b) => line.includes(b))!,
          note: "a comment without a history label (need: history/old/used to/retired/pre-Bun-port/pre-port)",
        });
      }
    });
  }
  return hits;
}

// ── the real assertions ─────────────────────────────────────────────────────

describe("active SKILL.md — the deleted bash tools stay deleted", () => {
  const docs = activeSkillDocs();

  test("there ARE active skills to scan (vacuity floor)", () => {
    expect(docs.length).toBeGreaterThanOrEqual(20);
  });

  test("no active SKILL.md mentions dedup.sh/run-test.sh/ci-local.sh/smoke.sh/find-polluter.sh (the seal)", () => {
    const hits = scanDocsSurface(docs);
    expect(
      hits,
      `BASH TOOL NAME RESURFACED IN A SKILL DOC: ${hitText(hits)} — the five skill tools were ` +
        "converted to Bun twins and their .sh deleted; a doc reference has no executor, so it rots " +
        "until an agent follows it into an ENOENT. Repoint the doc at the .ts twin, or argue a D6 " +
        "exception explicitly (spec.md D6: wizard/template.sh, dsh-plugin/sv-analyzer/build.sh).",
    ).toEqual([]);
  });
});

describe("code surface — no live reference to a deleted launcher", () => {
  const files = codeSurfaceFiles();

  test("the scanner sees the surfaces (vacuity floor)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.path.endsWith("src/deploy-run.ts"))).toBe(true);
    expect(files.some((f) => f.path.endsWith("src/doctor.ts"))).toBe(true);
    expect(files.some((f) => f.path.endsWith("extensions/devops.ts"))).toBe(true);
    expect(files.some((f) => f.path.endsWith("s2-agent-ext-devops/CONTEXT.md"))).toBe(true);
  });

  test("no deleted bash name outside a history-labeled comment (deploy-probe class)", () => {
    const hits = scanCodeSurface(files);
    expect(
      hits,
      `DELETED BASH NAME IN CODE: ${hitText(hits)} — a spawn/existsSync probe or a hint pointing ` +
        "at a deleted .sh compiles clean and returns null/ENOENT at runtime (deploy-run probes the " +
        "pair src/deploy/run.ts + scripts/run-test.ts for exactly this class). Point the code at " +
        "the twin; if the mention is genuinely history, keep the history label",
    ).toEqual([]);
  });
});

// ── negative controls — the scanners must detect, not sleep ─────────────────

describe("negative controls — the scanners detect what they must", () => {
  const VIRTUAL_DOC = { path: "/virtual/skills/example/SKILL.md", content: "" };
  const VIRTUAL_CODE = { path: "/virtual/src/example.ts", content: "" };

  test("a planted mention of EACH banned tool in a virtual SKILL.md is detected", () => {
    for (const tool of BANNED_TOOLS) {
      const hits = scanDocsSurface([{ ...VIRTUAL_DOC, content: `# Example\n\nRun ${tool} on the fixture.\n` }]);
      expect(hits, tool).toHaveLength(1);
      expect(hits[0]!.term).toBe(tool);
    }
  });

  test("a planted run-test.sh in a virtual code line is detected (the probe class)", () => {
    const hits = scanCodeSurface([{ ...VIRTUAL_CODE, content: `spawnSync("bun", ["y", "run-test.sh", "high"]);\n` }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.term).toBe("run-test.sh");
    expect(hits[0]!.note).toContain("CODE line");
  });

  test("a planted run-test.sh in a virtual devops tool description is detected (agent-read surface)", () => {
    const hits = scanCodeSurface([
      {
        path: "/virtual/s2-agent-ext-devops/extensions/devops.ts",
        content: `description: "Run run-test.sh medium to verify what the tiers do.",\n`,
      },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.term).toBe("run-test.sh");
    expect(hits[0]!.note).toContain("CODE line");
  });

  test("a planted run-test.sh in a virtual devops CONTEXT.md glossary is detected (agent-loaded surface, strict)", () => {
    const hits = scanCodeSurface([
      { path: "/virtual/s2-agent-ext-devops/CONTEXT.md", strict: true, content: "**run-test.sh**: the deleted bash tool.\n" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.term).toBe("run-test.sh");
    expect(hits[0]!.note).toContain("CODE line");
    // Strict also kills the label escape hatch — a labeled mention is still
    // agent-loaded context a reader acts on.
    const labeled = scanCodeSurface([
      { path: "/virtual/s2-agent-ext-devops/CONTEXT.md", strict: true, content: "run-test.sh used to be the launcher (retired).\n" },
    ]);
    expect(labeled, "strict CONTEXT.md must catch even a history-labeled mention").toHaveLength(1);
  });

  test("a planted UNLABELED comment mention is detected", () => {
    const hits = scanCodeSurface([{ ...VIRTUAL_CODE, content: `// run-test.sh is how we verify\n` }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.note).toContain("history label");
  });

  test("a planted HISTORY-LABELED comment block is accepted (the migration note class)", () => {
    const hits = scanCodeSurface([
      {
        ...VIRTUAL_CODE,
        content: "/**\n * The probe pair used to be run-test.sh (the pre-Bun-port\n * name) before the port.\n */\n",
      },
    ]);
    expect(hits).toEqual([]);
  });

  test("a planted comment block whose label line sits ABOVE the mention is still history (block rule)", () => {
    const hits = scanCodeSurface([
      { ...VIRTUAL_CODE, content: `// run-test.sh used to be pinned here; its only\n// reference was the deploy-verify job, which ran run-test.sh's high tier.\n` },
    ]);
    expect(hits).toEqual([]);
  });

  test("a D6-allowlisted doc mention is accepted", () => {
    const hits = scanDocsSurface([
      { path: "/virtual/skills/wizard/SKILL.md", content: "# Wizard\n\nCopy `template.sh` per the STAGES marker.\n" },
    ]);
    expect(hits).toEqual([]);
  });

  test("a non-D6, non-live doc mention is detected", () => {
    const hits = scanDocsSurface([
      { ...VIRTUAL_DOC, content: "# Example\n\nRun scripts/some-deleted.sh for cleanup.\n" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.note).toContain("neither a D6 exception");
  });

  test("a live-script doc mention is accepted", () => {
    const hits = scanDocsSurface([
      { ...VIRTUAL_DOC, content: "# Example\n\nUse `scripts/ci-file-size-guard.sh`…\n" },
    ]);
    expect(hits).toEqual([]);
  });

  test("a bare root launcher (s2-agent.sh) doc mention is accepted", () => {
    const hits = scanDocsSurface([
      { ...VIRTUAL_DOC, content: "# Example\n\n`current` points at — s2-agent.sh --help boot…\n" },
    ]);
    expect(hits).toEqual([]);
  });
});
