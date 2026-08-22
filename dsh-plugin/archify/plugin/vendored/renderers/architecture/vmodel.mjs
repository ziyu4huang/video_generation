/**
 * vmodel.mjs — the `v-model` geometry archetype (effort
 * 2026-08-22-archify-deck-template-v2, ticket 02).
 *
 * A V-model diagram (ASPICE PAM Figure C.1 shape): an ordered left arm that
 * derives the spec downward to an apex, and an ordered right arm that
 * verifies the implementation back up. Authors declare the ARMS, not the
 * coordinates — this pre-pass fills `pos`/`size` for arm components that
 * lack them. Explicit positions are never overridden, so an author can pin
 * any node and let the archetype place the rest.
 *
 * Crossbars (verify pairings) are NOT payload here — they are ordinary
 * connections; author them as `{ "route": "straight", "variant": "dashed",
 * "role": "verify" }` between arm nodes and the default side-anchors produce
 * the horizontal pairing arrows.
 */

const DEFAULTS = {
  width: 150,
  height: 64,
  gap: 60, // horizontal distance between the two apex nodes
  marginX: 40,
  topY: 40,
  stepY: 96, // vertical pitch between arm levels
  bottomPad: 68, // breathing room + the legend row
  minCanvasW: 920,
};

/**
 * Expand `meta.archetype: { kind: "v-model", ... }` into component
 * pos/size. Pushes actionable problems (unknown ids, arm overlap) into
 * `problems`; geometry is only applied when the payload is coherent.
 * Mutates and returns `arch`.
 */
export function expandVModelArchetype(arch, problems) {
  const payload = arch.meta?.archetype;
  if (!payload || payload.kind !== 'v-model') return arch;

  const byId = new Map((arch.components ?? []).map((c) => [c.id, c]));
  const left = payload.leftArm ?? [];
  const right = payload.rightArm ?? [];
  if (left.length < 2) problems.push('archetype.leftArm needs at least 2 component ids (top → apex).');
  if (right.length < 2) problems.push('archetype.rightArm needs at least 2 component ids (apex → top).');

  const seen = new Map();
  for (const id of [...left, ...right]) {
    if (!byId.has(id)) {
      problems.push(`archetype arm references unknown component "${id}".`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`Component "${id}" appears in archetype.${seen.get(id)} — a node sits on one arm only.`);
    } else {
      seen.set(id, left.includes(id) ? 'leftArm' : 'rightArm');
    }
  }

  const w = Array.isArray(payload.size) ? payload.size[0] : DEFAULTS.width;
  const h = Array.isArray(payload.size) ? payload.size[1] : DEFAULTS.height;
  const gap = typeof payload.gap === 'number' ? payload.gap : DEFAULTS.gap;

  const rows = Math.max(left.length, right.length);
  const canvasW = arch.meta?.viewBox
    ? arch.meta.viewBox[0]
    : Math.max(DEFAULTS.minCanvasW, DEFAULTS.marginX * 2 + w * 2 + (rows - 1) * 110 + gap);
  const canvasH = DEFAULTS.topY + h + (rows - 1) * DEFAULTS.stepY + DEFAULTS.bottomPad;

  const lerp = (a, b, t) => a + (b - a) * t;
  // Left arm: arm[0] top-left → arm[last] apex (bottom, left of centre).
  // Right arm: arm[0] apex-mate (bottom, right of centre) → arm[last] top-right.
  // A shorter arm starts proportionally lower — a true V.
  const cxOf = (i, armLen, arm) => {
    const t = armLen <= 1 ? 0 : i / (armLen - 1);
    // `gap` is the EDGE CLEARANCE between the two apex nodes, not the
    // centre distance — a 150px node pair 60px apart centre-to-centre
    // overlaps by 90px, which the layout gate correctly rejects.
    if (arm === 'left') {
      return lerp(DEFAULTS.marginX + w / 2, canvasW / 2 - gap / 2 - w / 2, t);
    }
    return lerp(canvasW / 2 + gap / 2 + w / 2, canvasW - DEFAULTS.marginX - w / 2, t);
  };

  const place = (ids, arm) => {
    ids.forEach((id, i) => {
      const c = byId.get(id);
      if (!c) return;
      const row = arm === 'left' ? i : rows - 1 - i;
      const cy = DEFAULTS.topY + h / 2 + row * DEFAULTS.stepY;
      const cx = cxOf(i, ids.length, arm);
      if (!Array.isArray(c.pos)) c.pos = [Math.round(cx - w / 2), Math.round(cy - h / 2)];
      if (!Array.isArray(c.size)) c.size = [w, h];
    });
  };

  place(left, 'left');
  place(right, 'right');

  if (!arch.meta.viewBox) arch.meta.viewBox = [Math.round(canvasW), Math.round(canvasH)];
  return arch;
}
