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

const MESSAGE_BUS_RE = /queue|bus|broker|kafka|pubsub|amqp|mq\b|sink/i;
const SECURITY_RE = /auth|secu?|firewall|credential|vault|pii|permission|iam\b/i;
const DATABASE_RE = /db\b|database|store|cache|postgres|redis|sql|mongo|lake/i;
const FRONTEND_RE = /ui\b|web\b|front|browser|gateway|edge|dashboard/i;
const EXTERNAL_RE = /user|client|customer|ext\b|partner/i;

const STATE_TYPE_RE: Array<[string, RegExp]> = [
  ["start", /start$|planned|scheduled|init|begin/i],
  ["waiting", /wait|canary|review|pending|staged|queue|hold|gate/i],
  ["success", /success|live|done|pass|complete|shipped|released|deployed/i],
  ["failure", /fail|error|abort|drop|reject|rollback|stopped|dead|denied/i],
  ["neutral", /neutral|manual|unknown/i],
  ["external", /external|partner|customer|third/i],
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

/** Rough text width the vendored checker uses: ~6.8px per unit (CJK ×2). */
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += /[⺀-鿿豈-﫿]/.test(ch) ? 2 : 1;
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
}

// ---------------------------------------------------------------------------
// Parser: flowchart / graph
// ---------------------------------------------------------------------------

const FLOW_SOLID = "-->";
const FLOW_DOTTED = "-.->";
const FLOW_THICK = "==>";

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
  const open = source[i];
  if (open === "[" || open === "(" || open === "{") {
    const close = open === "[" ? "]" : open === "(" ? ")" : "}";
    let content = "";
    let j = i + 1;
    while (j < source.length && source[j] !== close) {
      content += source[j]!;
      j += 1;
    }
    if (j >= source.length) throw new MermaidConvertError(`unterminated ${open}…${close} shape`, lineNo);
    i = j + 1;
    shape = open === "{" ? "diamond" : open === "[" ? "box" : "round";
    label = unquote(content);
  } else if (source.startsWith("[(", i)) {
    let j = i + 2;
    let content = "";
    while (j < source.length && !(source[j] === ")" && source[j + 1] === "]")) {
      content += source[j]!;
      j += 1;
    }
    if (j >= source.length) throw new MermaidConvertError("unterminated [(`…`)] stadium shape", lineNo);
    i = j + 2;
    shape = "stadium";
    label = unquote(content);
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
    // Longest-marker check drives the variant; all three take `|label|`.
    const variant = s.startsWith(FLOW_DOTTED) ? "dashed" : s.startsWith(FLOW_THICK) ? "emphasis" : "default";
    const len = s.startsWith(FLOW_DOTTED) ? FLOW_DOTTED.length : s.startsWith(FLOW_THICK) ? FLOW_THICK.length : FLOW_SOLID.length;
    let end = start + len;
    let label: string | null = null;
    if (source[end] === "|") {
      const pipeEnd = source.indexOf("|", end + 1);
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
      const m = /^note(?:\s+(?:right\s+of|left\s+of|over))?\s+([A-Za-z0-9_,]+)\s*:\s*(.*)$/i.exec(line);
      if (!m) throw new MermaidConvertError("`Note` needs `Note over A: text` / `Note right of A:`", l + 1);
      pendingNote = m[2]!.trim();
      continue;
    }
    if (/^rect\b/i.test(line)) {
      if (openRect) throw new MermaidConvertError("nested `rect` blocks are unbounded", l + 1);
      const label = unquote(line.slice("rect".length).trim());
      openRect = { label: label || `Stage ${ast.rects.length + 1}`, fromMsg: ast.messages.length };
      continue;
    }
    if (line === "end") {
      if (openRect) {
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
  const ast: LifecycleAst = { states: new Map(), transitions: [], startEntries: new Set(), startExits: new Set() };
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
    // `[*] --> X` entry, `X --> [*]` exit.
    const bracket = /^\[\*\]\s*-->\s*([A-Za-z0-9_-]+)\s*:?\s*(.*)$/.exec(line);
    if (bracket) {
      const id = bracket[1]!;
      if (!ast.states.has(id)) ast.states.set(id, { id, label: id });
      ast.startEntries.add(id);
      continue;
    }
    const bracketExit = /^([A-Za-z0-9_-]+)\s*-->\s*\[\*\]\s*:?\s*(.*)$/.exec(line);
    if (bracketExit) {
      const id = bracketExit[1]!;
      if (!ast.states.has(id)) ast.states.set(id, { id, label: id });
      ast.startExits.add(id);
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

  // Deterministic routing trims (the vendored auto router cannot be trusted to
  // clear its own clean-flow checks on branched shapes):
  // - a node's 2nd+ outgoing edge → `bottom-channel` (runs below every lane,
  //   so it cannot slice through intermediate-lane nodes);
  // - a back edge → `return-left` around the margin, like the library's
  //   change-approval `reject-open`.
  const outIndex = new Map<string, number>();
  const edges = ast.edges.map((e, i) => {
    const entry: Record<string, unknown> = { id: `e${i + 1}`, from: nodeIds.get(e.from) ?? e.from, to: nodeIds.get(e.to) ?? e.to };
    if (e.label) entry.label = e.label;
    if (e.variant !== "default") entry.variant = e.variant;
    if (back.has(`${e.from}->${e.to}`)) {
      entry.route = "return-left";
      entry.fromSide = "left";
      entry.toSide = "left";
    } else {
      const idx = outIndex.get(e.from) ?? 0;
      outIndex.set(e.from, idx + 1);
      if (idx >= 1) entry.route = "bottom-channel";
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
  // declaration order within a column.
  const back = findBackEdges(ast);
  const level = workflowLevels(ast, back);
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
  if (ast.subgraphs.length > 5) throw new MermaidConvertError(`dataflow supports 5 stages max, got ${ast.subgraphs.length}`);
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
  const used = new Set<string>();
  const nodeIds = new Map<string, string>();
  const nodes = [...ast.nodes.values()].map((node) => {
    const id = sanitizeId(node.id, used);
    nodeIds.set(node.id, id);
    return {
      id,
      type: flowNodeType(node, ast.classHints, ast.classDefs),
      label: node.label ?? node.id,
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
      label: e.label ?? `to ${target}`,
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
    const decl = ast.states.get(id)!;
    if (ast.startExits.has(id)) {
      const t = semanticStateType(decl.label);
      return t === "failure" || t === "dropped" ? "terminal" : "terminal";
    }
    if (ast.startEntries.has(id)) return "main";
    const t = semanticStateType(decl.label);
    if (t === "waiting") return "waiting";
    return "main";
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
  for (const [lane, count] of laneCounters) {
    if (count > 5) throw new MermaidConvertError(`lifecycle lane "${lane}" holds ${count} states, schema caps at 5 (col 0–4)`);
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
    return { id: stateIds.get(id)!, type: t, label: decl.label, lane: laneOf.get(id)!, col: colOf.get(id)! };
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
  const sheets: Array<Record<string, unknown>[]> = [];
  for (const key of ["edges", "flows", "transitions", "connections"]) {
    const list = ir[key];
    if (Array.isArray(list)) sheets.push(list as Record<string, unknown>[]);
  }
  let applied = 0;
  for (const fix of fixes) {
    let matches: Array<Record<string, unknown>> = [];
    for (const sheet of sheets) {
      for (const item of sheet) {
        if (item.label === fix.label) matches.push(item);
      }
    }
    if (matches.length === 1) {
      matches[0]!.labelAt = fix.at;
      applied += 1;
    }
  }
  return applied > 0 ? structuredClone(ir) : ir;
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
