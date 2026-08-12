import { WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-ext-core-runtime";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { WorkflowMeta, WorkflowMetaPhase } from "./workflow.js";

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Describes the offending first statement for the "meta must be first" error, so
 * the message is self-diagnosing instead of a bare "must be the first statement".
 * Returns a short noun phrase + a quoted source snippet, e.g.
 *   "a `const` declaration: `const helper = makeHelper()`"
 *   "an `import` statement (imports are not allowed — workflows must be self-contained): `import fs from 'fs'`"
 * Comments/blank lines never reach here (acorn excludes them from `body`).
 */
function describeLeadingStatement(node: AnyNode | undefined, script: string): string {
  if (!node) return "an empty script (no statements at all)";
  const snippet = script.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  const preview = snippet.length > 80 ? `${snippet.slice(0, 79)}…` : snippet;
  const quoted = preview ? `: \`${preview}\`` : "";
  switch (node.type) {
    case "VariableDeclaration":
      return `a \`${node.kind}\` declaration${quoted}`;
    case "ImportDeclaration":
      return `an \`import\` statement (imports are not allowed — workflows must be self-contained)${quoted}`;
    case "ExportDefaultDeclaration":
      return `an \`export default\` statement${quoted}`;
    case "ExpressionStatement":
      return `an expression statement${quoted}`;
    case "FunctionDeclaration":
      return `a \`function\` declaration${quoted}`;
    case "ClassDeclaration":
      return `a \`class\` declaration${quoted}`;
    case "ReturnStatement":
      return `a \`return\` statement${quoted}`;
    case "IfStatement":
      return `an \`if\` statement${quoted}`;
    default:
      return `a \`${node.type}\` statement${quoted}`;
  }
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string; defaultExport?: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      [
        "`export const meta = { name, description, phases }` must be the first statement in the script,",
        `but the script starts with ${describeLeadingStatement(first, script)}.`,
        "Move any code below the `export const meta` line.",
        "Note: leading `//` line comments, `/* block */` comments, blank lines, and a leading BOM are NOT",
        "statements and never trigger this error — only real code (a declaration, import, expression, etc.)",
        "before the meta export does.",
      ].join(" "),
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  // Detect an optional `export default <fn>` entry point (the pack form). When
  // present, runWorkflow CALLS the entry with the vm context object instead of
  // running it as a bare top-level statement (which would SyntaxError — `export`
  // is illegal inside the IIFE wrap, and the function expects {agent,...} as a
  // parameter, not as globals).
  const defaultNode = ast.body.find((n: AnyNode) => n.type === "ExportDefaultDeclaration") as AnyNode | undefined;
  const defaultExport = defaultNode?.declaration
    ? script.slice((defaultNode.declaration as AnyNode).start, (defaultNode.declaration as AnyNode).end)
    : undefined;
  // Body = source with BOTH the meta export and (if present) the default export
  // removed; any other top-level statements (helpers, consts, etc.) are preserved
  // and run before the entry is called.
  const removals = [first, defaultNode].filter(Boolean) as AnyNode[];
  removals.sort((a, b) => a.start - b.start);
  let reconstructed = "";
  let cursor = 0;
  for (const r of removals) {
    reconstructed += script.slice(cursor, r.start);
    cursor = r.end;
  }
  reconstructed += script.slice(cursor);
  return { meta, body: reconstructed, defaultExport };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}
