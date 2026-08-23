// Pure mermaid-subset → archify IR conversion.
//
// Implements the MECHANICAL subset of the vendored "Mermaid as an Input Dialect"
// mapping (vendored/SKILL.md §): grammar → structure → schema. The judgment the
// doc reserves for the human — "you choose grouping, lane order, and what
// deserves emphasis" — happens AFTER conversion, in the copy-adapt step
// (.planning/2026-08-23-archify-rich-decks spec.md §7.1, decision D7).
//
// Contract: the converter either returns a schema-shaped IR object or throws
// MermaidConvertError naming the source line. Recognized-but-unbounded syntax
// is NEVER silently dropped or guessed (a half-converted IR is valid-but-wrong,
// the worst copy-adapt outcome). Only style/config-only constructs — linkStyle,
// classDef names with no semantic signal, `%%{init}` blocks — are dropped, per
// the doc's "Drop Mermaid styling".
//
// Schema targets (spec §7.1.1): flowchart/graph → workflow (default) |
// architecture | dataflow (D8 convention: subgraph = stage); sequenceDiagram →
// sequence; stateDiagram(-v2) → lifecycle.

export type ConverterTarget = "workflow" | "architecture" | "dataflow";

export interface ConvertOptions {
  /** Forced target for flowchart input; `undefined` = auto-detect. */
  type?: ConverterTarget;
  /** meta.title override; default = the filename stem passed by the CLI. */
  title?: string;
  /** Output artifact stem — sets meta.output `<stem>.html` (schema convention). */
  outputStem?: string;
}

export class MermaidConvertError extends Error {
  readonly sourceLine: number | null;
  constructor(message: string, sourceLine: number | null = null) {
    super(sourceLine === null ? message : `line ${sourceLine}: ${message}`);
    this.name = "MermaidConvertError";
    this.sourceLine = sourceLine;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Whole-word (both-side \b) keyword tables — an embedded match on "context" →
// "ext" or "section" → "sec" silently mis-types common words, and the type
// renders in every diagram. The word lists ARE the approved §7.1.4 table.
const MESSAGE_BUS_RE = /\b(?:queue|bus|broker|kafka|pubsub|amqp|mq|sink)\b/i;
const SECURITY_RE = /\b(?:auth|security?|firewall|credential|vault|pii|permission|iam)\b/i;
const DATABASE_RE = /\b(?:db|database|store|cache|postgres|redis|sql|mongo|lake)\b/i;
const FRONTEND_RE = /\b(?:ui|web|frontend|browser|gateway|edge|dashboard)\b/i;
const EXTERNAL_RE = /\b(?:user|client|customer|external|ext|partner)\b/i;

// State stems with common suffix forms (started / waiting / dropped …) — but
// always word-bounded: "restart"/"second" never match.
const STATE_TYPE_RE: Array<[string, RegExp]> = [
  ["start", /\b(?:start|planned|scheduled|init|begin)(?:ed|ing|s)?\b/i],
  ["waiting", /\b(?:wait|canary|review|pending|staged|queue|hold|gate)(?:ing|ed|s)?\b/i],
  ["success", /\b(?:success|live|done|pass|complete|ship|release|deploy)(?:ed|ing|s|ped)?\b/i],
  ["failure", /\b(?:fail|error|abort|drop|reject|rollback|stop|dead|deny)(?:ed|ing|s|ure|ped)?\b/i],
  ["neutral", /\b(?:neutral|manual|unknown)\b/i],
  ["external", /\b(?:external|partner|customer|third)\b/i],
];

/**
 * Shared semantic-typing scan (§7.1.4): classDef class names, node labels,
 * participant/state names → componentType / lifecycle type. Precedence is
 * specific-before-general (messagebus → security → database → frontend →
 * external); anything else defaults to backend (or `active` for lifecycles).
 * The word lists ARE the documented table — keep in sync with --help.
 */
export function semanticComponentType(text: string): string {
  if (MESSAGE_BUS_RE.test(text)) return "messagebus";
  if (SECURITY_RE.test(text)) return "security";
  if (DATABASE_RE.test(text)) return "database";
  if (FRONTEND_RE.test(text)) return "frontend";
  if (EXTERNAL_RE.test(text)) return "external";
  return "backend";
}

export function semanticStateType(text: string): string {
  for (const [type, re] of STATE_TYPE_RE) {
    if (re.test(text)) return type;
  }
  return "active";
}

/**
 * Text width in "units" the vendored checker measures (~6.8px per unit, CJK
 * and fullwidth ×2). Mirrors vendored/renderers/shared/utils.mjs FULLWIDTH_RE —
 * full-width punctuation/letters, Hangul, Jamo, emoji, CJK ext B all count 2,
 * so a label the converter thinks fits does not silently pass the checker.
 */
const FULLWIDTH_RE = new RegExp(
  "[ᄀ-ᅟ〈-〉⺀-꓏가-힣豈-﫿" +
    "︐-︙︰-﹯！-｠￠-￦\u{16FE0}-\u{18DFF}" +
    "\u{1AFF0}-\u{1AFFF}\u{1B000}-\u{1B2FF}\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]",
  "u",
);
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += FULLWIDTH_RE.test(ch) ? 2 : 1;
  return units;
}

/**
 * A label too wide for its default box (the vendored checkers error on it):
 * lift the full text into `sublabel` and keep the first word as the label —
 * the checker's own "shorten it or move detail to sublabel" made deterministic.
 * A single long word cannot be shortened → error (the bound says so).
 */
function splitLongLabel(
  label: string,
  maxPx: number,
  what: string,
  lineNo: number | null,
): { label: string; sublabel?: string } {
  if (textUnits(label) * 6.8 <= maxPx) return { label };
  const words = label.split(/\s+/);
  if (words.length < 2) {
    throw new MermaidConvertError(`label "${label}" is too wide for a ${what} box (max ${Math.round(maxPx / 6.8)} chars) — shorten it in the mermaid source`, lineNo);
  }
  return { label: words[0]!, sublabel: label };
}

/** mermaid id → schema-safe id: `^[a-zA-Z][a-zA-Z0-9_-]*$`, deduped. */
function sanitizeId(id: string, used: Set<string>): string {
  let out = id.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!/^[a-zA-Z]/.test(out)) out = `n${out}`;
  let candidate = out;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${out}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Strip `%%…` comments (outside quotes). `%%{init}` blocks are config-only and
 * dropped per the doc's "Drop Mermaid styling". */
function stripComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "`") {
      inQuote = ch;
      continue;
    }
    if (ch === "%" && line[i + 1] === "%") return line.slice(0, i);
  }
  return line;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "`") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\`/g, "`");
  }
  return t;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

/** Y-axis y for sequence message index i (schema floor 160, 40 px per row). */
function messageY(i: number): number {
  return 160 + 40 * i;
}

// ---------------------------------------------------------------------------
// Intermediate model
// ---------------------------------------------------------------------------

interface FlowNode {
  id: string;
  label: string | null; // null = id serves as the label
  shape: "box" | "round" | "diamond" | "stadium" | null;
  classes: string[];
  subgraph: number | null; // index into subgraphs, or null
}

interface FlowSubgraph {
  id: string | null;
  label: string | null;
  nodeIds: string[];
}

interface FlowEdge {
  from: string;
  to: string;
  label: string | null;
  variant: "default" | "dashed" | "emphasis";
}

interface FlowchartAst {
  direction: "LR" | "TB";
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
  subgraphs: FlowSubgraph[];
  classHints: Map<string, string>; // node id → class name (last wins)
  classDefs: Map<string, string>; // class name → def text (semantic scan)
}

interface SeqParticipant {
  id: string;
  label: string;
}

interface SeqMessage {
  from: string;
  to: string;
  label: string;
  variant: "default" | "return";
  note: string | null;
}

interface SequenceAst {
  participants: SeqParticipant[];
  messages: SeqMessage[];
  /** rect blocks → message-index ranges (from/to inclusive on indexes). */
  rects: Array<{ label: string; fromMsg: number; toMsg: number }>;
  activations: Array<{ participant: string; fromMsg: number; toMsg: number }>;
}

interface StateDecl {
  id: string;
  label: string;
}

interface LifecycleAst {
  states: Map<string, StateDecl>;
  transitions: Array<{ from: string; to: string; label: string | null }>;
  startEntries: Set<string>; // `[*] --> X`
  startExits: Set<string>; // `X --> [*]`
  /** `[*] --> X: label` — the label explains the entry; carried to sublabel. */
  entryLabels: Map<string, string>;
  /** `X --> [*]: label` — same for exits. */
  exitLabels: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Parser: flowchart / graph
// ---------------------------------------------------------------------------

const FLOW_SOLID = "-->";
const FLOW_DOTTED = "-.->";
const FLOW_THICK = "==>";

/**
 * Find the closing index of a shape block opened at `open` — quote-aware: a
 * `"…"`/backtick label containing the closer (`A["has ] bracket"]`) is not
 * truncated; shapes close on the closing bracket OUTSIDE any quoted run.
 */
function findShapeClose(source: string, openIndex: number, close: string, lineNo: number): { content: string; end: number } {
  let j = openIndex + 1;
  let content = "";
  let inQuote: string | null = null;
  while (j < source.length) {
    const ch = source[j]!;
    if (inQuote) {
      content += ch;
      if (ch === "\\") {
        content += source[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      j += 1;
      continue;
    }
    if (ch === '"' || ch === "`") {
      inQuote = ch;
      content += ch;
      j += 1;
      continue;
    }
    if (ch === close) {
      return { content, end: j + 1 };
    }
    content += ch;
    j += 1;
  }
  throw new MermaidConvertError(`unterminated ${source[openIndex]}…${close} shape`, lineNo);
}

/** Read a node token at i: id [+ shape-block] [+ :::class]. */
function readFlowNodeToken(source: string, start: number, lineNo: number): [FlowNode, number] {
  let i = start;
  let id = "";
  while (i < source.length && isWordChar(source[i]!)) {
    id += source[i]!;
    i += 1;
  }
  if (id === "") throw new MermaidConvertError(`expected a node id at "${source.slice(start)}"`, lineNo);

  let shape: FlowNode["shape"] = null;
  let label: string | null = null;
  if (source.startsWith("([", i)) {
    // Stadium `A([text])` (mermaid 11) — checked FIRST: `(` alone is a round
    // node otherwise. The closing pair is `]` then `)`.
    const { content, end } = findShapeClose(source, i + 1, "]", lineNo);
    if (source[end] !== ")") throw new MermaidConvertError("unterminated ([…]) stadium shape (expected `])`)", lineNo);
    i = end + 1;
    shape = "stadium";
    label = unquote(content);
  } else {
    const open = source[i];
    if (open === "[" || open === "(" || open === "{") {
      const close = open === "[" ? "]" : open === "(" ? ")" : "}";
      const { content, end } = findShapeClose(source, i, close, lineNo);
      i = end;
      shape = open === "{" ? "diamond" : open === "[" ? "box" : "round";
      label = unquote(content);
    }
  }

  const classes: string[] = [];
  if (source.startsWith(":::", i)) {
    let j = i + 3;
    let cls = "";
    while (j < source.length && isWordChar(source[j]!)) {
      cls += source[j]!;
      j += 1;
    }
    if (cls === "") throw new MermaidConvertError("`:::` needs a class name", lineNo);
    classes.push(cls);
    i = j;
  }

  return [{ id, label, shape, classes, subgraph: null }, i];
}

/** Read a link operator at i; returns [variant, label|null, endPos]. */
function readFlowOp(source: string, start: number, lineNo: number): [string, string | null, number] {
  const s = source.slice(start);
  if (s.startsWith(FLOW_SOLID) || s.startsWith(FLOW_DOTTED) || s.startsWith(FLOW_THICK)) {
    // Longest-marker check drives the variant; all three take `|label|`
    // (quote-aware: a `|` inside a quoted label is not a terminator).
    const variant = s.startsWith(FLOW_DOTTED) ? "dashed" : s.startsWith(FLOW_THICK) ? "emphasis" : "default";
    const len = s.startsWith(FLOW_DOTTED) ? FLOW_DOTTED.length : s.startsWith(FLOW_THICK) ? FLOW_THICK.length : FLOW_SOLID.length;
    let end = start + len;
    let label: string | null = null;
    if (source[end] === "|") {
      let pipeEnd = -1;
      let inQuote: string | null = null;
      for (let j = end + 1; j < source.length; j++) {
        const ch = source[j]!;
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
          continue;
        }
        if (ch === '"' || ch === "`") {
          inQuote = ch;
          continue;
        }
        if (ch === "|") {
          pipeEnd = j;
          break;
        }
      }
      if (pipeEnd === -1) throw new MermaidConvertError("unterminated |label|", lineNo);
      label = source.slice(end + 1, pipeEnd);
      end = pipeEnd + 1;
    }
    return [variant, label, end];
  }
  if (s.startsWith("--")) {
    const closer = source.indexOf(FLOW_SOLID, start + 2);
    if (closer === -1) throw new MermaidConvertError("unterminated `-- text -->` link", lineNo);
    const label = source.slice(start + 2, closer).trim();
    return ["default", label === "" ? null : label, closer + FLOW_SOLID.length];
  }
  if (s.startsWith("-.")) {
    // The text form closes with `.->` (short), not `-.->`.
    const closer = source.indexOf(".->", start + 2);
    if (closer === -1) throw new MermaidConvertError("unterminated `-. text .->` link", lineNo);
    const label = source.slice(start + 2, closer).trim();
    return ["dashed", label === "" ? null : label, closer + 3];
  }
  if (s.startsWith("==")) {
    const closer = source.indexOf(FLOW_THICK, start + 2);
    if (closer === -1) throw new MermaidConvertError("unterminated `== text ==>` link", lineNo);
    const label = source.slice(start + 2, closer).trim();
    return ["emphasis", label === "" ? null : label, closer + FLOW_THICK.length];
  }
  throw new MermaidConvertError(`expected a link, got "${s.slice(0, 4)}"`, lineNo);
}

function parseFlowchart(source: string): FlowchartAst {
  const ast: FlowchartAst = {
    direction: "LR",
    nodes: new Map(),
    edges: [],
    subgraphs: [],
    classHints: new Map(),
    classDefs: new Map(),
  };
  const lines = source.split("\n");
  const subgraphStack: number[] = [];

  for (let l = 0; l < lines.length; l++) {
    const line = stripComment(lines[l]!).trim();
    if (line === "") continue;

    // The dialect header (`flowchart LR`, `graph TD`, …) is handled by
    // detectMermaidDialect — as a statement it would parse as two phantom nodes.
    if (/^flowchart\b|^graph\b/i.test(line)) continue;
    const dirMatch = /^direction\s+(TB|TD|LR|RL|BT)\b/i.exec(line);
    if (dirMatch) {
      const d = dirMatch[1]!.toUpperCase();
      // All directions are accepted; the converter always lays out left-to-
      // right (workflowLevels cols = depth). Per the vendored doc the layering
      // judgment ("you choose grouping, lane order") belongs to the copy-adapt
      // step AFTER conversion (D7) — a TB mermaid's IR keeps its topology and
      // the layering choice is the copy-adapt judgment, exactly as the doc
      // prescribes for the human-conversion path.
      ast.direction = d === "TB" || d === "TD" || d === "BT" ? "TB" : "LR";
      continue;
    }
    if (/^subgraph\b/i.test(line)) {
      if (subgraphStack.length >= 1) {
        throw new MermaidConvertError("nested subgraphs are unbounded (1 level supported)", l + 1);
      }
      const rest = line.slice("subgraph".length).trim();
      let subId: string | null = null;
      let subLabel: string | null = null;
      if (rest.startsWith('"') || rest.startsWith("`")) {
        subLabel = unquote(rest);
      } else {
        const idMatch = /^([A-Za-z0-9_-]+)/.exec(rest);
        if (idMatch) {
          subId = idMatch[1]!;
          subLabel = subId;
          const after = rest.slice(idMatch[0].length).trim();
          if (after.startsWith("[")) {
            const closeIdx = after.lastIndexOf("]");
            subLabel = closeIdx > 1 ? unquote(after.slice(1, closeIdx)) : null;
          } else if (after !== "") {
            subLabel = unquote(after);
          }
        }
      }
      subgraphStack.push(ast.subgraphs.length);
      ast.subgraphs.push({ id: subId, label: subLabel ?? null, nodeIds: [] });
      continue;
    }
    if (line === "end") {
      if (subgraphStack.pop() === undefined) {
        throw new MermaidConvertError("stray `end` (no open subgraph)", l + 1);
      }
      continue;
    }
    if (/^classDef\s/i.test(line)) {
      const m = /^classDef\s+([A-Za-z0-9_-]+)\s+([\s\S]*)$/.exec(line);
      if (m) ast.classDefs.set(m[1]!, m[2]!);
      continue;
    }
    if (/^style\s/i.test(line) || /^linkStyle/i.test(line)) continue; // styling, dropped
    if (/^class\s/i.test(line)) {
      // `class A,B className` and `class className A,B` (v11 alias form);
      // disambiguated by which side is a declared classDef. Id lists are
      // comma-joined (mermaid's `class A,B,C name` syntax).
      const parts = line
        .slice("class".length)
        .trim()
        .split(/\s+/)
        .flatMap((t) => t.split(","))
        .filter((t) => t !== "");
      if (parts.length < 2) throw new MermaidConvertError("`class` needs ids and a class name", l + 1);
      if (ast.classDefs.has(parts[0]!)) {
        for (const id of parts.slice(1)) ast.classHints.set(id, parts[0]!);
      } else {
        const cls = parts[parts.length - 1]!;
        for (const id of parts.slice(0, -1)) ast.classHints.set(id, cls);
      }
      continue;
    }

    // Statement: node defs and links, e.g. `A["A"] --> B --> C` or just `A["A"]`.
    let i = 0;
    let pendingFrom: FlowNode | null = null;
    let pendingEdge: { from: string; variant: string; label: string | null } | null = null;
    while (i < line.length) {
      const ch = line[i]!;
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      // A node id starts with [A-Za-z0-9_] (or a quoted/backtick label anchor).
      // A leading `-`/`.`/`=` is a link (`-->`, `-.->`, `==>`), `:::` is a class
      // suffix handled inside readFlowNodeToken.
      if (/[A-Za-z0-9_"]/.test(ch) || ch === "`") {
        const [node, next] = readFlowNodeToken(line, i, l + 1);
        i = next;
        const key = node.id;
        const existing = ast.nodes.get(key);
        if (existing) {
          if (node.label !== null && existing.label === null) existing.label = node.label;
          if (node.shape) existing.shape = node.shape;
          existing.classes.push(...node.classes);
        } else {
          node.subgraph = subgraphStack.length > 0 ? subgraphStack[subgraphStack.length - 1]! : null;
          ast.nodes.set(key, node);
          if (node.subgraph !== null) ast.subgraphs[node.subgraph]!.nodeIds.push(key);
        }
        if (pendingEdge) {
          if (!ast.nodes.has(node.id)) {
            throw new MermaidConvertError(`link target "${node.id}" resolves to no node`, l + 1);
          }
          ast.edges.push({ from: pendingEdge.from, to: node.id, label: pendingEdge.label, variant: pendingEdge.variant as FlowEdge["variant"] });
          pendingEdge = null;
        }
        pendingFrom = ast.nodes.get(key)!;
        continue;
      }
      const [variant, label, end] = readFlowOp(line, i, l + 1);
      i = end;
      if (pendingFrom === null) throw new MermaidConvertError("link with no source node", l + 1);
      pendingEdge = { from: pendingFrom.id, variant, label };
      pendingFrom = null;
    }
    if (pendingEdge) throw new MermaidConvertError("dangling link with no target node", l + 1);
  }
  if (subgraphStack.length > 0) throw new MermaidConvertError("unclosed subgraph", lines.length);
  return ast;
}

// ---------------------------------------------------------------------------
// Parser: sequenceDiagram
// ---------------------------------------------------------------------------

// ids may carry hyphens (`my-service`) but a `-` must be followed by an id char
// — otherwise the greedy id eats a `-` of `-->`/`-->>` and mis-splits the line.
const SEQ_ID = "[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*";
// Activation shorthand: `A->>+B` (activate B on arrival) / `A->>-B` (deactivate).
const SEQ_RE = new RegExp(`^(${SEQ_ID})\\s*(-->>|->>|--x|->)\\s*([+-]?)\\s*(${SEQ_ID})\\s*:?\\s*(.*)$`);

function parseSequence(source: string): SequenceAst {
  const ast: SequenceAst = { participants: [], messages: [], rects: [], activations: [] };
  const lines = source.split("\n");
  const participantIndex = new Map<string, number>();

  const ensureParticipant = (id: string, label?: string): void => {
    if (!participantIndex.has(id)) {
      participantIndex.set(id, ast.participants.length);
      ast.participants.push({ id, label: label ?? id });
    } else if (label !== undefined) {
      ast.participants[participantIndex.get(id)!]!.label = label;
    }
  };

  let openRect: { label: string; fromMsg: number } | null = null;
  let pendingNote: string | null = null;

  for (let l = 0; l < lines.length; l++) {
    const line = stripComment(lines[l]!).trim();
    if (line === "") continue;

    if (/^sequenceDiagram\b/i.test(line)) continue; // dialect header (detected in convertMermaid)
    if (/^participant\s|^actor\s/i.test(line)) {
      const m = /^(?:participant|actor)\s+([A-Za-z0-9_-]+)(?:\s+as\s+(.+))?/i.exec(line);
      if (!m) throw new MermaidConvertError("`participant` needs an id", l + 1);
      ensureParticipant(m[1]!, m[2] ? unquote(m[2]) : undefined);
      continue;
    }
    if (/^note\s/i.test(line)) {
      // `Note over A, B: text` — spaces after commas are standard mermaid.
      const m = /^note(?:\s+(?:right\s+of|left\s+of|over))?\s+([A-Za-z0-9_]+(?:,\s*[A-Za-z0-9_]+)*)\s*:\s*(.*)$/i.exec(line);
      if (!m) throw new MermaidConvertError("`Note` needs `Note over A: text` / `Note right of A:`", l + 1);
      pendingNote = m[2]!.trim();
      continue;
    }
    if (/^rect\b/i.test(line)) {
      if (openRect) throw new MermaidConvertError("nested `rect` blocks are unbounded", l + 1);
      // mermaid's `rect rgb(200,200,255)` is a color argument, not a title.
      const rest = line.slice("rect".length).trim();
      const label = /^rgb\s*\(/i.test(rest) ? null : unquote(rest);
      openRect = { label: label || `Stage ${ast.rects.length + 1}`, fromMsg: ast.messages.length };
      continue;
    }
    if (line === "end") {
      if (openRect) {
        if (ast.messages.length - 1 < openRect.fromMsg) {
          throw new MermaidConvertError("an empty `rect` block yields an invalid segment — put at least one message inside", l + 1);
        }
        ast.rects.push({ label: openRect.label, fromMsg: openRect.fromMsg, toMsg: ast.messages.length - 1 });
        openRect = null;
        continue;
      }
      throw new MermaidConvertError("stray `end` (no open rect)", l + 1);
    }
    if (/^(?:alt|else|loop|opt|par|break)\b/i.test(line)) {
      throw new MermaidConvertError(
        "sequence `alt/loop/opt/par/break` blocks are unbounded — the dialect table covers participant / message / note / rect / activate only",
        l + 1,
      );
    }
    if (/^activate\s|^deactivate\s/i.test(line)) {
      const m = /^(activate|deactivate)\s+([A-Za-z0-9_-]+)/i.exec(line);
      if (!m) throw new MermaidConvertError("`activate` needs a participant id", l + 1);
      const pid = m[2]!;
      ensureParticipant(pid);
      if (m[1]!.toLowerCase() === "activate") {
        ast.activations.push({ participant: pid, fromMsg: ast.messages.length - 1, toMsg: ast.messages.length - 1 });
      } else {
        for (let k = ast.activations.length - 1; k >= 0; k--) {
          if (ast.activations[k]!.participant === pid) {
            ast.activations[k]!.toMsg = ast.messages.length - 1;
            break;
          }
        }
      }
      continue;
    }

    const m = SEQ_RE.exec(line);
    if (!m) throw new MermaidConvertError(`unrecognized sequence syntax near "${line}"`, l + 1);
    const fromId = m[1]!;
    const op = m[2]!;
    const actArg = m[3]!;
    const toId = m[4]!;
    const text = m[5]!;
    if (op === "--x" || op === "->") {
      throw new MermaidConvertError(`sequence variant "${op}" is unbounded — supported: ->> (message), -->> (return)`, l + 1);
    }
    if (fromId === toId) {
      throw new MermaidConvertError(`self-message "${fromId}->>${fromId}" spans 0px — the sequence grammar needs two participants`, l + 1);
    }
    ensureParticipant(fromId);
    ensureParticipant(toId);
    // In mermaid the message reads left-to-right: A->>B means A sends to B.
    const idx = ast.messages.length;
    const label = text.trim();
    ast.messages.push({
      from: fromId,
      to: toId,
      label: label === "" ? `<message ${idx + 1}>` : label,
      variant: op === "-->>" ? "return" : "default",
      note: pendingNote,
    });
    pendingNote = null;
    if (actArg === "+") {
      ast.activations.push({ participant: toId, fromMsg: idx, toMsg: idx });
    } else if (actArg === "-") {
      for (let k = ast.activations.length - 1; k >= 0; k--) {
        if (ast.activations[k]!.participant === toId) {
          ast.activations[k]!.toMsg = idx;
          break;
        }
      }
    }
  }
  if (openRect) throw new MermaidConvertError("unclosed `rect` block", lines.length);
  if (pendingNote) throw new MermaidConvertError("a `Note` must precede a message (no message follows it)", lines.length);
  return ast;
}

// ---------------------------------------------------------------------------
// Parser: stateDiagram(-v2)
// ---------------------------------------------------------------------------

const STATE_DECL_RE = /^state\s+(?:"(.+?)"\s+as\s+)?([A-Za-z0-9_-]+)\s*$/;
const STATE_TRANS_RE = /^(\[\]|\*)\s*(?:\[\*\]\s*-->\s*([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+)\s*-->\s*\[(\*)\])(?:\s*:?\s*(.*))?$/;
const STATE_PLAIN_TRANS_RE = /^([A-Za-z0-9_-]+)\s*-->\s*([A-Za-z0-9_-]+)\s*:?\s*(.*)$/;

function parseLifecycle(source: string): LifecycleAst {
  const ast: LifecycleAst = {
    states: new Map(),
    transitions: [],
    startEntries: new Set(),
    startExits: new Set(),
    entryLabels: new Map(),
    exitLabels: new Map(),
  };
  const lines = source.split("\n");

  for (let l = 0; l < lines.length; l++) {
    const line = stripComment(lines[l]!).trim();
    if (line === "") continue;
    if (/^stateDiagram(-v2)?\b/i.test(line)) continue; // dialect header (detected in convertMermaid)
    if (/^(?:direction|note)\b/i.test(line)) {
      if (/^direction\b/i.test(line)) continue; // state direction is a no-op for the IR layout
      throw new MermaidConvertError("`note` is unbounded in stateDiagram", l + 1);
    }
    const decl = STATE_DECL_RE.exec(line);
    if (decl) {
      const id = decl[2]!;
      ast.states.set(id, { id, label: decl[1] ?? id });
      continue;
    }
    // `[*] --> X` entry (label carried), `X --> [*]` exit (label carried).
    const bracket = /^\[\*\]\s*-->\s*([A-Za-z0-9_-]+)\s*:?\s*(.*)$/.exec(line);
    if (bracket) {
      const id = bracket[1]!;
      if (!ast.states.has(id)) ast.states.set(id, { id, label: id });
      ast.startEntries.add(id);
      const tLabel = bracket[2]!.trim();
      if (tLabel !== "") ast.entryLabels.set(id, tLabel);
      continue;
    }
    const bracketExit = /^([A-Za-z0-9_-]+)\s*-->\s*\[\*\]\s*:?\s*(.*)$/.exec(line);
    if (bracketExit) {
      const id = bracketExit[1]!;
      if (!ast.states.has(id)) ast.states.set(id, { id, label: id });
      ast.startExits.add(id);
      const tLabel = bracketExit[2]!.trim();
      if (tLabel !== "") ast.exitLabels.set(id, tLabel);
      continue;
    }
    const trans = STATE_TRANS_RE.exec(line);
    if (trans) throw new MermaidConvertError("unrecognized state transition syntax", l + 1);
    const plain = STATE_PLAIN_TRANS_RE.exec(line);
    if (plain) {
      const from = plain[1]!;
      const to = plain[2]!;
      const label = plain[3]!;
      if (!ast.states.has(from)) ast.states.set(from, { id: from, label: from });
      if (!ast.states.has(to)) ast.states.set(to, { id: to, label: to });
      const tLabel = label.trim();
      ast.transitions.push({ from, to, label: tLabel === "" ? null : tLabel });
      continue;
    }
    throw new MermaidConvertError(`unrecognized stateDiagram syntax near "${line}"`, l + 1);
  }
  return ast;
}

// ---------------------------------------------------------------------------
// Mappers: AST → schema-shaped IR objects
// ---------------------------------------------------------------------------

function flowNodeType(node: FlowNode, classHints: Map<string, string>, classDefs: Map<string, string>): string {
  const cls = classHints.get(node.id) ?? node.classes[0];
  const defText = cls ? (classDefs.get(cls) ?? "") : "";
  const text = `${defText} ${cls ?? ""} ${node.label ?? ""} ${node.id}`;
  return semanticComponentType(text);
}

/** Cycle-forming back edges (e.g. an exception loop back to the author, like
 * the library's change-approval) — deterministic DFS, declaration order. Their
 * semantics stay in the edge list (a literal loop is a workflow feature); they
 * are excluded from layering and source-detection only. */
function findBackEdges(ast: FlowchartAst): Set<string> {
  const back = new Set<string>();
  const color = new Map<string, number>();
  for (const id of ast.nodes.keys()) color.set(id, 0);
  const visit = (u: string): void => {
    color.set(u, 1);
    for (const e of ast.edges) {
      if (e.from !== u || !ast.nodes.has(e.to)) continue;
      const c = color.get(e.to)!;
      if (c === 1) back.add(`${e.from}->${e.to}`);
      if (c === 0) visit(e.to);
    }
    color.set(u, 2);
  };
  for (const id of ast.nodes.keys()) {
    if (color.get(id) === 0) visit(id);
  }
  return back;
}

function workflowLevels(ast: FlowchartAst, back: Set<string>): Map<string, number> {
  // Longest-path layering over the back-edge-free DAG; iterative relaxation
  // (Bellman-Ford flavor, bounded by node count), converging or erroring.
  const depth = new Map<string, number>();
  for (const id of ast.nodes.keys()) depth.set(id, 0);
  const preds = new Map<string, string[]>();
  for (const id of ast.nodes.keys()) preds.set(id, []);
  for (const e of ast.edges) {
    if (back.has(`${e.from}->${e.to}`) || !preds.has(e.to) || !ast.nodes.has(e.from)) continue;
    preds.get(e.to)!.push(e.from);
  }
  const ids = [...ast.nodes.keys()];
  for (let iter = 0; iter <= ids.length; iter++) {
    let changed = false;
    for (const id of ids) {
      const best = preds.get(id)!.reduce((m, p) => Math.max(m, depth.get(p)! + 1), 0);
      if (best > depth.get(id)!) {
        depth.set(id, best);
        changed = true;
      }
    }
    if (!changed) return depth;
  }
  throw new MermaidConvertError("cycle detected in flowchart — a workflow cannot loop (use a lifecycle instead)");
}

function workflowMainPath(ast: FlowchartAst, back: Set<string>): string[] {
  // Walk the happy path: start at the first source (no non-back incoming edge,
  // declaration order), follow each node's first outgoing edge (declaration
  // order) until a sink — then STOP. Branches and exception lanes stay out of
  // mainPath, like the copied library's change-approval.
  const outs = new Map<string, string[]>();
  for (const id of ast.nodes.keys()) outs.set(id, []);
  for (const e of ast.edges) outs.get(e.from)?.push(e.to);
  const ins = new Map<string, number>();
  for (const id of ast.nodes.keys()) ins.set(id, 0);
  for (const e of ast.edges) {
    if (back.has(`${e.from}->${e.to}`) || !ast.nodes.has(e.to) || !ast.nodes.has(e.from)) continue;
    ins.set(e.to, (ins.get(e.to) ?? 0) + 1);
  }
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = [...ast.nodes.keys()].find((id) => (ins.get(id) ?? 0) === 0) ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    cursor = outs.get(cursor)!.find((t) => !seen.has(t)) ?? null;
  }
  return path;
}

function buildMeta(title: string, outputStem?: string): Record<string, unknown> {
  return { title, ...(outputStem ? { output: `${outputStem}.html` } : {}) };
}

function toWorkflowIr(ast: FlowchartAst, options: ConvertOptions, title: string): Record<string, unknown> {
  const used = new Set<string>();
  const laneIds = new Map<string, string>();
  const lanes: Array<{ id: string; label: string }> = [];
  const hasUngrouped = [...ast.nodes.values()].some((n) => n.subgraph === null);
  // Ungrouped nodes land in a `main` lane (exemplar order: it comes first).
  if (hasUngrouped) {
    laneIds.set("main", "main");
    lanes.push({ id: "main", label: "Main" });
  }
  for (let s = 0; s < ast.subgraphs.length; s++) {
    const sub = ast.subgraphs[s]!;
    const id = sanitizeId(sub.id ?? `lane-${s + 1}`, used);
    laneIds.set(s.toString(), id);
    lanes.push({ id, label: sub.label ?? sub.id ?? `Lane ${s + 1}` });
  }
  if (lanes.length === 0) {
    laneIds.set("main", "main");
    lanes.push({ id: "main", label: "Main" });
  }

  const back = findBackEdges(ast);
  // Columns by diagram-wide longest-path level, mapped through the well-spaced
  // subset [0, 1, 3, 5]: the vendored grid colXs are [88, 220, 300, 430, 500,
  // 625] for 92px nodes, so adjacent same-lane columns 1↔2 and 3↔4 overlap
  // (70-80px) while 0↔1, 1↔3, 3↔5 stay ≥100px; the skipped middle columns are
  // the routing channels. This reproduces the library's change-approval column
  // pattern: open 0, both reviewers 1, security gate 3, ship 5.
  const COL_SLOTS = [0, 1, 3, 5];
  const level = workflowLevels(ast, back);
  const maxLevel = Math.max(...[...level.values()], 0);
  if (maxLevel > COL_SLOTS.length - 1) {
    throw new MermaidConvertError(`workflow depth ${maxLevel + 1} exceeds the ${COL_SLOTS.length} well-spaced columns (${COL_SLOTS.join("/")}) — shorten the chain or use a lifecycle`);
  }
  const colOf = new Map<string, number>();
  for (const [id, lv] of level) colOf.set(id, COL_SLOTS[Math.min(lv, COL_SLOTS.length - 1)]!);
  // Two nodes in the SAME lane at the SAME column would stack in the 8px-apart
  // checker — bound that shape explicitly (parallel steps need own lanes).
  const slotByLane = new Map<string, string>();
  for (const [id, node] of ast.nodes) {
    const lane = node.subgraph !== null ? `s${node.subgraph}` : "main";
    const key = `${lane}#${colOf.get(id)}`;
    const owner = slotByLane.get(key);
    if (owner !== undefined) {
      throw new MermaidConvertError(`nodes "${owner}" and "${id}" land in the same lane+column — parallel steps need their own lanes (subgraphs)`);
    }
    slotByLane.set(key, id);
  }

  const nodeIds = new Map<string, string>();
  const nodes: Array<Record<string, unknown>> = [];
  for (const [id, node] of ast.nodes) {
    const sid = sanitizeId(id, used);
    nodeIds.set(id, sid);
    const lane = node.subgraph !== null ? laneIds.get(node.subgraph.toString())! : laneIds.get("main")!;
    const entry: Record<string, unknown> = {
      id: sid,
      lane,
      col: colOf.get(id) ?? 0,
      type: flowNodeType(node, ast.classHints, ast.classDefs),
      ...splitLongLabel(node.label ?? id, 92, "node", null),
    };
    if (node.shape === "diamond") {
      entry.type = "security";
      entry.tag = "decision";
    }
    nodes.push(entry);
  }

  // Deterministic routing trims — bounded to shapes they provably survive the
  // checker's clean-flow/legend checks; anything beyond is a convert-time error
  // (M2: the auto router slices through nodes on branched shapes):
  // - a node's 2nd+ outgoing edge: ADJACENT-lane target → `drop` (the mid-gap,
  //   clean); deeper target → `bottom-channel` only when the run's x-window
  //   misses the legend text (x ~140–210), else error;
  // - a back edge → `return-left` like the library's `reject-open`;
  // - same-lane skip edge (topology jumps over an intermediate same-lane node)
  //   → error (no automatic route clears it);
  // - cross-lane edge whose from/to share a column while an intermediate lane
  //   holds a node at that column → error.
  const laneIndexOf = new Map<string, number>();
  lanes.forEach((l, i) => laneIndexOf.set(l.id, i));
  const laneOfNode = new Map<string, string>();
  for (const [id, node] of ast.nodes) {
    laneOfNode.set(id, node.subgraph !== null ? laneIds.get(node.subgraph.toString())! : laneIds.get("main")!);
  }
  const colXs = [88, 220, 300, 430, 500, 625]; // vendored render layout, ported for bound checks
  const laneIndexList = [...laneIndexOf.entries()];
  const outIndex = new Map<string, number>();
  const edges = ast.edges.map((e, i) => {
    const entry: Record<string, unknown> = { id: `e${i + 1}`, from: nodeIds.get(e.from) ?? e.from, to: nodeIds.get(e.to) ?? e.to };
    if (e.label) entry.label = e.label;
    if (e.variant !== "default") entry.variant = e.variant;
    const fromLane = laneOfNode.get(e.from)!;
    const toLane = laneOfNode.get(e.to)!;
    const laneIdx = (id: string): number => laneIndexOf.get(id) ?? 0;
    const lo = Math.min(laneIdx(fromLane), laneIdx(toLane));
    const hi = Math.max(laneIdx(fromLane), laneIdx(toLane));
    if (back.has(`${e.from}->${e.to}`)) {
      // The from-side horizontal runs at the source row's y through its own
      // lane; a shared row would slice same-lane siblings (M2c).
      const siblings = [...ast.nodes.values()].filter(
        (n) => laneOfNode.get(n.id) === fromLane && n.id !== e.from && n.id !== e.to,
      );
      if (siblings.length > 0) {
        throw new MermaidConvertError(
          `back edge "${e.from}" -> "${e.to}" would slice same-lane nodes — put the loop source alone in its own subgraph (exception lane)`,
        );
      }
      entry.route = "return-left";
      entry.fromSide = "left";
      entry.toSide = "left";
    } else if (fromLane === toLane) {
      // Same-lane skip: another node's column strictly between the endpoints.
      const cFrom = colOf.get(e.from) ?? 0;
      const cTo = colOf.get(e.to) ?? 0;
      const between = [...ast.nodes.values()].some((n) => {
        if (laneOfNode.get(n.id) !== fromLane || n.id === e.from || n.id === e.to) return false;
        const c = colOf.get(n.id) ?? 0;
        return (c > cFrom && c < cTo) || (c < cFrom && c > cTo);
      });
      if (between) {
        throw new MermaidConvertError(
          `edge "${e.from}" -> "${e.to}" skips an intermediate node in the same lane — an automatic route cannot clear it; insert the intermediate step or split lanes`,
        );
      }
    } else {
      const idx = outIndex.get(e.from) ?? 0;
      outIndex.set(e.from, idx + 1);
      if (idx >= 1) {
        // 2nd+ outgoing edge: the auto mid-gap route would slice intermediate
        // lanes, so route explicitly — adjacent target: the mid-gap `drop` is
        // clean; deeper target: `bottom-channel` (only when the run misses the
        // legend text band, else error).
        if (lo + 1 === hi) {
          entry.route = "drop";
        } else {
          // Legend text band measured at lastLaneBottom+14..34, x ~140–210 —
          // constants are the vendored render geometry (laneY 52, laneH 104,
          // laneGap 20, nodeH 52, nodeY = laneTop + 30 + 11, colXs above).
          const laneTopC = (i: number): number => 52 + i * 124;
          const nodeBottomC = (i: number): number => laneTopC(i) + 30 + 11 + 52;
          const channelY = Math.max(nodeBottomC(laneIdx(fromLane)), nodeBottomC(laneIdx(toLane))) + 32;
          const lastLaneBottom = 32 + lanes.length * 124;
          const inLegendBand = channelY > lastLaneBottom + 12 && channelY < lastLaneBottom + 36;
          const cxLo = Math.min(colXs[colOf.get(e.from) ?? 0]!, colXs[colOf.get(e.to) ?? 0]!);
          const cxHi = Math.max(colXs[colOf.get(e.from) ?? 0]!, colXs[colOf.get(e.to) ?? 0]!);
          if (inLegendBand && cxLo < 210 && cxHi > 140) {
            throw new MermaidConvertError(
              `edge "${e.from}" -> "${e.to}" cannot be routed (2nd fan-out across ${hi - lo} lanes; the bottom channel would cross the legend) — split the branches into adjacent lanes or add an intermediate step`,
            );
          }
          entry.route = "bottom-channel";
        }
      } else if (hi - lo >= 2) {
        // First-out edge keeps the checker's auto mid-gap route — its
        // horizontal runs inside the intermediate lanes' y-bands, so ANY node
        // there whose column rect overlaps the run's x-window gets sliced
        // (M2-reviewer shapes; the checker rejects post hoc, we bound eagerly).
        const cxOf = (id: string): number => colXs[colOf.get(id) ?? 0]!;
        const runLo = Math.min(cxOf(e.from), cxOf(e.to)) - 46;
        const runHi = Math.max(cxOf(e.from), cxOf(e.to)) + 46;
        const hit = [...ast.nodes.values()].some((n) => {
          const ni = laneIndexOf.get(laneOfNode.get(n.id) ?? "") ?? 0;
          if (ni <= lo || ni >= hi) return false;
          const nc = cxOf(n.id);
          return nc - 46 < runHi && nc + 46 > runLo;
        });
        if (hit) {
          throw new MermaidConvertError(
            `edge "${e.from}" -> "${e.to}" runs through a node in an intermediate lane — shift an endpoint's column or split the diagram into adjacent lanes`,
          );
        }
      }
    }
    return entry;
  });

  const mainPath = workflowMainPath(ast, back).map((id) => nodeIds.get(id) ?? id);
  if (mainPath.length < 2) {
    throw new MermaidConvertError("a workflow needs ≥2 nodes on a coherent path (mainPath)");
  }

  return {
    schema_version: 1,
    diagram_type: "workflow",
    meta: buildMeta(title, options.outputStem),
    lanes,
    mainPath,
    nodes,
    edges,
  };
}

function toArchitectureIr(ast: FlowchartAst, options: ConvertOptions, title: string): Record<string, unknown> {
  const used = new Set<string>();
  const nodeIds = new Map<string, string>();
  // Grid mode requires row/col per component — grid placement is the renderer's
  // answer to "no coordinates" (free placement would need hand-authored pos).
  // Cols by the same longest-path layering as workflows (shape order); rows by
  // declaration order within a column. The vendored grid DEFAULT_GRID cols=4
  // (col 0..3) — deeper chains are a convert-time bound error (M3b).
  const back = findBackEdges(ast);
  const level = workflowLevels(ast, back);
  const maxCol = Math.max(...[...level.values()], 0);
  if (maxCol > 3) {
    throw new MermaidConvertError(`architecture flow depth ${maxCol + 1} exceeds the vendored grid's 4 columns (0–3) — shorten the chain`);
  }
  const rowByCol = new Map<number, number>();
  const components = [...ast.nodes.values()].map((node) => {
    const id = sanitizeId(node.id, used);
    nodeIds.set(node.id, id);
    const col = level.get(node.id) ?? 0;
    const row = rowByCol.get(col) ?? 0;
    rowByCol.set(col, row + 1);
    return { id, type: flowNodeType(node, ast.classHints, ast.classDefs), label: node.label ?? node.id, row, col };
  });
  const boundaries = ast.subgraphs
    .filter((sub) => sub.nodeIds.length > 0)
    .map((sub) => ({
      kind: "region",
      label: sub.label ?? sub.id ?? "Region",
      wraps: sub.nodeIds.map((id) => nodeIds.get(id) ?? id),
    }));
  const connections = ast.edges.map((e, i) => {
    const entry: Record<string, unknown> = { id: `c${i + 1}`, from: nodeIds.get(e.from) ?? e.from, to: nodeIds.get(e.to) ?? e.to };
    if (e.label) entry.label = e.label;
    if (e.variant !== "default") entry.variant = e.variant;
    return entry;
  });
  return {
    schema_version: 1,
    diagram_type: "architecture",
    meta: buildMeta(title, options.outputStem),
    // Grid mode = the renderer places components; free placement (mode
    // omitted) REQUIRES explicit pos, which a converter cannot author well.
    layout: { mode: "grid" },
    components,
    ...(boundaries.length > 0 ? { boundaries } : {}),
    connections,
  };
}

function toDataflowIr(ast: FlowchartAst, options: ConvertOptions, title: string): Record<string, unknown> {
  // D8 convention: subgraph → stage. Every node must carry a stage.
  if (ast.subgraphs.length < 2) {
    throw new MermaidConvertError("dataflow needs ≥2 subgraph stages (convention: subgraph → stage)");
  }
  // The vendored renderer's default viewBox fits 4 stages; the schema's 5 max
  // is not reachable without hand-set viewBox (M3a).
  if (ast.subgraphs.length > 4) throw new MermaidConvertError(`dataflow conversion supports 4 stages (the vendored default viewBox fits 4), got ${ast.subgraphs.length}`);
  const stageOfNode = new Map<string, number>();
  const rowOfNode = new Map<string, number>();
  ast.subgraphs.forEach((sub, s) => {
    sub.nodeIds.forEach((id, r) => {
      stageOfNode.set(id, s);
      rowOfNode.set(id, r);
    });
  });
  const offStage = [...ast.nodes.keys()].find((id) => !stageOfNode.has(id));
  if (offStage) {
    throw new MermaidConvertError(`node "${offStage}" is outside every subgraph — a dataflow needs each node in a stage`);
  }
  const labelOf = new Map<string, string>();
  const used = new Set<string>();
  const nodeIds = new Map<string, string>();
  const nodes = [...ast.nodes.values()].map((node) => {
    const id = sanitizeId(node.id, used);
    nodeIds.set(node.id, id);
    const label = node.label ?? node.id;
    labelOf.set(id, label);
    return {
      id,
      type: flowNodeType(node, ast.classHints, ast.classDefs),
      label,
      stage: stageOfNode.get(node.id) ?? 0,
      row: rowOfNode.get(node.id) ?? 0,
    };
  });
  const flows = ast.edges.map((e, i) => {
    const target = nodeIds.get(e.to) ?? e.to;
    const entry: Record<string, unknown> = {
      id: `f${i + 1}`,
      from: nodeIds.get(e.from) ?? e.from,
      to: target,
      // Schema-required flow label: edge label, else "to <target LABEL>" (the
      // readable name, not the sanitized id — m9).
      label: e.label ?? `to ${labelOf.get(e.to) ?? target}`,
    };
    if (e.variant !== "default") entry.variant = e.variant;
    return entry;
  });
  return {
    schema_version: 1,
    diagram_type: "dataflow",
    meta: buildMeta(title, options.outputStem),
    stages: ast.subgraphs.map((sub) => ({ label: sub.label ?? sub.id ?? "Stage" })),
    nodes,
    flows,
  };
}

function toSequenceIr(ast: SequenceAst, options: ConvertOptions, title: string): Record<string, unknown> {
  const used = new Set<string>();
  const participantIds = new Map<string, string>();
  const participants = ast.participants.map((p) => {
    const id = sanitizeId(p.id, used);
    participantIds.set(p.id, id);
    return { id, type: semanticComponentType(p.label), ...splitLongLabel(p.label, 92, "participant", null) };
  });
  // meta.viewBox must satisfy the renderer's own checks (default [920, 760] is
  // a floor, not a bound): computed from the renderer geometry below and the
  // last message y (the timeline band scales with viewBox height).
  const lastY = ast.messages.length > 0 ? messageY(ast.messages.length - 1) : 160;
  const viewBox = [
    Math.max(480, 62 + (participants.length - 1) * 108 + 43 + 40),
    Math.max(480, lastY + 103),
  ];
  const messages = ast.messages.map((m, i) => {
    const entry: Record<string, unknown> = {
      id: `m${i + 1}`,
      from: participantIds.get(m.from) ?? m.from,
      to: participantIds.get(m.to) ?? m.to,
      y: messageY(i),
      label: m.label,
    };
    if (m.variant !== "default") entry.variant = m.variant;
    if (m.note !== null) entry.note = m.note;
    return entry;
  });
  const segments = ast.rects.map((r) => {
    const firstY = messageY(r.fromMsg);
    const lastY = messageY(r.toMsg);
    return { from: Math.max(160, firstY - 40), to: lastY + 20, label: r.label };
  });
  const activations = ast.activations.map((a) => ({
    participant: participantIds.get(a.participant) ?? a.participant,
    from: Math.max(160, messageY(a.fromMsg) + 20),
    to: Math.max(200, messageY(a.toMsg) + 40),
  }));
  return {
    schema_version: 1,
    diagram_type: "sequence",
    meta: { ...buildMeta(title, options.outputStem), viewBox },
    participants,
    messages,
    ...(segments.length > 0 ? { segments } : {}),
    ...(activations.length > 0 ? { activations } : {}),
  };
}

function toLifecycleIr(ast: LifecycleAst, options: ConvertOptions, title: string): Record<string, unknown> {
  const stateIds = new Map<string, string>();
  const laneOf = new Map<string, string>();
  const colOf = new Map<string, number>();
  const laneCounters = new Map<string, number>();
  const used = new Set<string>();

  const laneFor = (id: string): string => {
    if (ast.startExits.has(id)) return "terminal";
    if (ast.startEntries.has(id)) return "main";
    return semanticStateType(ast.states.get(id)!.label) === "waiting" ? "waiting" : "main";
  };

  for (const id of ast.states.keys()) {
    const sid = sanitizeId(id, used);
    stateIds.set(id, sid);
    const lane = laneFor(id);
    laneOf.set(id, lane);
    const counter = laneCounters.get(lane) ?? 0;
    laneCounters.set(lane, counter + 1);
    colOf.set(id, counter);
  }
  // The renderer event band holds 3 columns (col 0–2) — the exemplar uses 0/2
  // for rooms; a 4th state in a lane clamps and fails confusingly (M3c).
  for (const [lane, count] of laneCounters) {
    if (count > 3) throw new MermaidConvertError(`lifecycle lane "${lane}" holds ${count} states — the renderer band caps at 3 columns`);
  }

  const lanes: Array<{ id: string; label: string }> = [{ id: "main", label: "Lifecycle phases" }];
  if (laneCounters.has("waiting")) lanes.push({ id: "waiting", label: "Interruptions" });
  if (laneCounters.has("terminal")) lanes.push({ id: "terminal", label: "Terminal exits" });

  const states = [...ast.states.keys()].map((id) => {
    const decl = ast.states.get(id)!;
    const t = ast.startEntries.has(id)
      ? "start"
      : ast.startExits.has(id)
        ? (semanticStateType(decl.label) === "failure" ? "failure" : "success")
        : semanticStateType(decl.label);
    // Entry/exit transition labels explain the boundary — carried to sublabel
    // (the transitions themselves have no [*] endpoint to label).
    const carried = ast.startEntries.has(id)
      ? ast.entryLabels.get(id)
      : ast.startExits.has(id)
        ? ast.exitLabels.get(id)
        : undefined;
    return {
      id: stateIds.get(id)!,
      type: t,
      label: decl.label,
      lane: laneOf.get(id)!,
      col: colOf.get(id)!,
      ...(carried ? { sublabel: carried } : {}),
    };
  });
  const transitions = ast.transitions.map((tr, i) => {
    const entry: Record<string, unknown> = { id: `t${i + 1}`, from: stateIds.get(tr.from) ?? tr.from, to: stateIds.get(tr.to) ?? tr.to };
    if (tr.label !== null) entry.label = tr.label;
    return entry;
  });
  return {
    schema_version: 1,
    diagram_type: "lifecycle",
    meta: buildMeta(title, options.outputStem),
    lanes,
    states,
    transitions,
  };
}

// ---------------------------------------------------------------------------
// Entry: detect dialect + convert
// ---------------------------------------------------------------------------

export type MermaidDialect = "flowchart" | "sequence" | "state";

export function detectMermaidDialect(source: string): MermaidDialect {
  for (const line of source.split("\n")) {
    const l = stripComment(line).trim();
    if (l === "") continue;
    if (/^flowchart\b|^graph\b/i.test(l)) return "flowchart";
    if (/^sequenceDiagram\b/i.test(l)) return "sequence";
    if (/^stateDiagram(-v2)?\b/i.test(l)) return "state";
    if (/^classDiagram\b|^erDiagram\b|^gantt\b|^pie\b|^xychart\b|^journey\b|^mindmap\b|^timeline\b/i.test(l)) {
      throw new MermaidConvertError(`mermaid dialect "${l.split(/\s+/)[0]}" is not supported (flowchart / sequenceDiagram / stateDiagram only)`);
    }
    throw new MermaidConvertError(`expected a mermaid dialect header (flowchart / sequenceDiagram / stateDiagram), got "${l}"`);
  }
  throw new MermaidConvertError("empty mermaid input");
}

/**
 * Apply the validator's own suggested label placements (labelAt fixes for
 * layout/constraint label overlaps). Deterministic: the suggestion coordinates
 * come from the checker's geometry. A fix maps to AT MOST one relationship by
 * its label text — ambiguous or unknown labels stay untouched so the caller
 * fails loudly instead of guessing.
 */
export function applyLabelFixes(
  ir: Record<string, unknown>,
  fixes: Array<{ label: string; at: [number, number] }>,
): Record<string, unknown> {
  let out: Record<string, unknown> = ir;
  let applied = 0;
  const sheets: Array<Record<string, unknown>[]> = [];
  for (const key of ["edges", "flows", "transitions", "connections"]) {
    const list = ir[key];
    if (Array.isArray(list)) sheets.push(list as Record<string, unknown>[]);
  }
  for (const fix of fixes) {
    let matches: Array<Record<string, unknown>> = [];
    for (const sheet of sheets) {
      for (const item of sheet) {
        if (item.label === fix.label) matches.push(item);
      }
    }
    if (matches.length === 1) {
      // Clone on first mutation only — never mutate the caller's IR.
      if (applied === 0) {
        out = structuredClone(ir);
      }
      // Re-derive the sheets against the clone so the fix lands there.
      const clonedSheets: Array<Record<string, unknown>[]> = [];
      for (const key of ["edges", "flows", "transitions", "connections"]) {
        const list = out[key];
        if (Array.isArray(list)) clonedSheets.push(list as Record<string, unknown>[]);
      }
      for (const sheet of clonedSheets) {
        for (const item of sheet) {
          if (item.label === fix.label) {
            item.labelAt = fix.at;
            break;
          }
        }
      }
      applied += 1;
    }
  }
  return out;
}

/**
 * Pull the checker's own labelAt suggestions out of a failing diagnostics set:
 * `Label "X" overlaps …` + `Suggested fix: labelAt [x, y] …`. Only suggestions
 * with an absolute labelAt apply; the coordinates ARE the checker's geometry,
 * so re-validating converges (bounded in validateWithLabelFixes).
 */
export function parseLabelFixSuggestions(diagnostics: Array<{ message?: string } | undefined>): Array<{ label: string; at: [number, number] }> {
  const fixes: Array<{ label: string; at: [number, number] }> = [];
  for (const d of diagnostics) {
    const msg = d?.message ?? "";
    const at = /labelAt\s*\[(\d+),\s*(\d+)\]/.exec(msg);
    const label = /Label "([^"]+)"/.exec(msg);
    if (at && label) fixes.push({ label: label[1]!, at: [Number(at[1]), Number(at[2])] });
  }
  return fixes;
}

export interface ValidateVerdict {
  ok: boolean;
  text: string;
  /** Diagnostics from a failing run (empty on success) — feeds the fix loop. */
  diagnostics: Array<{ message?: string }>;
}

/**
 * The convert + validate one-call core: run the caller's validate, and while
 * the ONLY failures are label overlaps with checker-suggested labelAt positions,
 * apply them and re-validate. Anything else — or more than maxRounds — fails
 * openly with the diagnostics text. Deterministic: all coordinates come from
 * the checker itself.
 */
export async function validateWithLabelFixes(
  ir: Record<string, unknown>,
  validate: (ir: Record<string, unknown>) => Promise<ValidateVerdict>,
  maxRounds = 3,
): Promise<{ ir: Record<string, unknown>; verdict: ValidateVerdict }> {
  let current = ir;
  for (let round = 0; ; round++) {
    const verdict = await validate(current);
    if (verdict.ok || round >= maxRounds) return { ir: current, verdict };
    const fixes = parseLabelFixSuggestions(verdict.diagnostics);
    if (fixes.length === 0) return { ir: current, verdict };
    current = applyLabelFixes(current, fixes);
  }
}

export function convertMermaid(source: string, options: ConvertOptions = {}): Record<string, unknown> {
  const cleanSource = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const dialect = detectMermaidDialect(cleanSource);
  const title = options.title ?? "Converted mermaid";

  switch (dialect) {
    case "flowchart": {
      const ast = parseFlowchart(cleanSource);
      const target = options.type ?? "workflow";
      if (target === "workflow") return toWorkflowIr(ast, options, title);
      if (target === "architecture") return toArchitectureIr(ast, options, title);
      return toDataflowIr(ast, options, title);
    }
    case "sequence": {
      if (options.type) {
        throw new MermaidConvertError("sequenceDiagram auto-converts to `sequence`; drop `--type`");
      }
      return toSequenceIr(parseSequence(cleanSource), options, title);
    }
    case "state": {
      if (options.type) {
        throw new MermaidConvertError("stateDiagram auto-converts to `lifecycle`; drop `--type`");
      }
      return toLifecycleIr(parseLifecycle(cleanSource), options, title);
    }
  }
}
