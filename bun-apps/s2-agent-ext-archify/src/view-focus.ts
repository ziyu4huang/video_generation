/**
 * view-focus.ts — guided views as static deck builds (effort
 * 2026-08-22-archify-deck-template-v2, ticket 03).
 *
 * `meta.views` already drives the HTML artifact's interactive view buttons.
 * The deck pipeline mirrors each view as a progressive BUILD slide: focus
 * members at full strength, everything else dimmed. The dimming is applied
 * to the parsed SVG by setting an inline `opacity` attribute — the one
 * channel `shape-ir.ts` already reads (`applyInlineAttrs`) and
 * `pptx-shapes.ts` already maps to shape/text transparency — so no renderer
 * fork and no new style vocabulary.
 *
 * The on-disk artifact is NEVER modified: D4 keeps a `diagram` slide's page
 * the untouched, interactive archify output; only the pptx projection of a
 * per-view slide is dimmed.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SvgNode } from "./svg-model.ts";

/** Mirrors `common.schema.json#/$defs/guidedViews` items. */
export interface GuidedViewMeta {
  id: string;
  label: string;
  focus: string[];
  note?: string;
}

/** The dim strength for non-focus content. 0.22 reads as "still there". */
export const DIM_OPACITY = 0.22;

/**
 * Read `meta.views` from an IR file (absolute or cwd-relative). Returns an
 * empty array when the IR has none — callers decide whether that is an error.
 */
export function readGuidedViews(irPath: string, cwd: string): GuidedViewMeta[] {
  const abs = isAbsolute(irPath) ? irPath : resolve(cwd, irPath);
  let ir: { meta?: { views?: GuidedViewMeta[] } };
  try {
    ir = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(ir.meta?.views) ? ir.meta!.views! : [];
}

/** The component ids of an IR, for focus-reference validation. */
export function readComponentIds(irPath: string, cwd: string): Set<string> {
  const abs = isAbsolute(irPath) ? irPath : resolve(cwd, irPath);
  try {
    const ir = JSON.parse(readFileSync(abs, "utf8")) as { components?: { id: string }[] };
    return new Set((ir.components ?? []).map((c) => c.id));
  } catch {
    return new Set();
  }
}

/**
 * Dim every painted element outside the focus, in place. Returns how many
 * elements were dimmed.
 *
 * Attribution walks the FLAT document-order node list with `depth`: a
 * `<g data-node-id>` opens a scope that closes at the first later node whose
 * depth is ≤ the group's. Edges carry `data-edge-from`/`data-edge-to`
 * directly (paths) or on their wrapping `<g>` (labels) — an edge is in focus
 * only when BOTH endpoints are. Unattributed chrome (grid, legend,
 * boundaries, backgrounds) stays at full strength.
 */
export function applyViewFocus(nodes: SvgNode[], focus: string[]): number {
  const focusSet = new Set(focus);
  let dimmed = 0;
  // Group scopes this element is inside: node groups (data-node-id) and edge
  // groups (data-edge-from). `inFocus` is the scope's verdict; children
  // resolve against the nearest pushed scope. Plain `<g>`s push nothing —
  // their children see the enclosing semantic scope, which is the point.
  const scopes: { depth: number; inFocus: boolean }[] = [];

  const dim = (n: SvgNode): void => {
    if (n.attrs.opacity === undefined) {
      n.attrs.opacity = String(DIM_OPACITY);
      dimmed++;
    }
  };

  const edgeInFocus = (n: SvgNode): boolean | null => {
    const from = n.attrs["data-edge-from"];
    if (!from) return null;
    const to = n.attrs["data-edge-to"] ?? from;
    return focusSet.has(from) && focusSet.has(to);
  };

  for (const n of nodes) {
    if (n.defOnly) continue;
    while (scopes.length > 0 && n.depth <= scopes[scopes.length - 1]!.depth) {
      scopes.pop();
    }

    if (n.tag === "g") {
      const nodeId = n.attrs["data-node-id"];
      const edge = edgeInFocus(n);
      if (nodeId === undefined && edge === null) continue;
      const inFocus = nodeId !== undefined ? focusSet.has(nodeId) : edge!;
      scopes.push({ depth: n.depth, inFocus });
      if (!inFocus) dim(n);
      continue;
    }

    // Standalone edge paths carry the attrs directly.
    const edge = edgeInFocus(n);
    if (edge !== null) {
      if (!edge) dim(n);
      continue;
    }
    if (scopes.length > 0 && !scopes[scopes.length - 1]!.inFocus) {
      dim(n);
    }
    // No scope and no edge attrs → chrome (grid, legend, boundaries): full.
  }
  return dimmed;
}
