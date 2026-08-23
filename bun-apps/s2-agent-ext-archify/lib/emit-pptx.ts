/**
 * emit-pptx.ts — `PlacedBlock[]` → native PowerPoint shapes and REAL text boxes.
 *
 * The difference from `pptx-shapes.ts` matters and is easy to miss: that module
 * replays a diagram whose line breaks the renderer already decided, so it places
 * each `<text>` at fixed coordinates with `wrap: false`. This module lays out
 * prose, so every text block is a genuine PowerPoint text box that WRAPS inside
 * its declared area — which is the whole reason a CJK deck is usable at all.
 * No text is measured here; PowerPoint does that.
 *
 * `fit: "shrink"` is applied to the content roles only. Chrome — tag chip,
 * action title, footer, page number — keeps the pre-composition builder's exact
 * options, which is what makes a `diagram` slide's XML byte-identical to what
 * that builder produced (effort decision D3). Title overflow is caught ahead of
 * the build by `deck-lint.ts`'s wrap budget instead of by silently shrinking
 * type: a title that quietly gets smaller is a defect the author never sees.
 */
import {
  bulletSizePt,
  builtinRoleOf,
  TYPE_SCALE,
  type Palette,
  type Role,
  type Theme,
  type TypeSpec,
} from "./deck-theme.ts";
import { addShapeIrToSlide, type Box, type SlideLike } from "./pptx-shapes.ts";
import type { ShapeIR } from "./shape-ir.ts";
import { toInches, type PlacedBlock } from "./slide-model.ts";

export type { SlideLike };

export interface EmitPptxCtx {
  palette: Palette;
  theme: Theme;
  font: string;
  /**
   * Diagrams already rendered to ShapeIR, keyed by the block's `ir` path.
   * Resolved by the orchestrator so this module stays synchronous and testable
   * against a spy slide.
   */
  diagrams: Map<string, ShapeIR>;
  /**
   * Role → type spec, `{ ...TYPE_SCALE, ...template.roles }` when the slide's
   * layout is a template. Omitted ⇒ the builtin scale, which is what keeps
   * code-layout output unchanged (§4.5).
   */
  roleOf?: (role: string) => TypeSpec;
}

export interface EmitResult {
  shapes: number;
  texts: number;
}

/**
 * Roles whose text can genuinely run long. Everything else is a fixed, short
 * label where shrinking would be a defect rather than a rescue.
 */
const AUTOFIT_ROLES: ReadonlySet<Role> = new Set<Role>([
  "coverTitle",
  "coverSubtitle",
  "sectionTitle",
  "takeaway",
  "body",
  "bullet",
  "statement",
]);

function textOptions(role: string, ctx: EmitPptxCtx): Record<string, unknown> {
  const spec = ctx.roleOf ? ctx.roleOf(role) : builtinRoleOf(role);
  return {
    fontFace: ctx.font,
    fontSize: spec.sizePt,
    color: ctx.palette[spec.color],
    ...(spec.bold ? { bold: true } : {}),
    ...(spec.tracking !== undefined ? { charSpacing: spec.tracking } : {}),
    ...(spec.lineSpacing !== undefined ? { lineSpacingMultiple: spec.lineSpacing } : {}),
    ...((spec.autofit ?? AUTOFIT_ROLES.has(role as Role)) ? { fit: "shrink" } : {}),
  };
}

/** Draw one slide's blocks. Returns the shape / text-run counts for reporting. */
export function emitPptxSlide(
  slide: SlideLike,
  blocks: PlacedBlock[],
  ctx: EmitPptxCtx
): EmitResult {
  const p = ctx.palette;
  let shapes = 0;
  let texts = 0;

  for (const block of blocks) {
    const box: Box = toInches(block.box);
    const content = block.content;

    switch (content.kind) {
      case "panel": {
        if (content.tone === "tag") {
          slide.addShape("roundRect", {
            ...box,
            fill: { color: p.tagBg },
            line: { color: p.tagBorder, width: 0.5 },
          });
        } else {
          slide.addShape("rect", {
            ...box,
            fill: { color: p.sectionBg },
            line: { type: "none" },
          });
        }
        shapes++;
        break;
      }

      case "rule": {
        slide.addShape("rect", {
          ...box,
          fill: { color: p.accent },
          line: { type: "none" },
        });
        shapes++;
        break;
      }

      case "text": {
        slide.addText(content.text, {
          ...box,
          ...textOptions(content.role, ctx),
          // "left" is the OOXML default (`algn` omitted). Spelling it out would
          // change nothing visually but would put `algn="l"` in every paragraph
          // — and the D3 lock compares a `diagram` slide's XML byte for byte.
          ...(block.align && block.align !== "left" ? { align: block.align } : {}),
          ...(block.valign ? { valign: block.valign } : {}),
        });
        texts++;
        break;
      }

      case "bullets": {
        if (content.items.length === 0) break;
        // ONE addText with a run per item: PowerPoint then treats them as one
        // list, so indent levels nest and the box autofits as a whole.
        const runs = content.items.map((item, i) => {
          const level = item.level ?? 0;
          return {
            text: item.text,
            options: {
              bullet: { indent: 18 },
              indentLevel: level,
              fontSize: bulletSizePt(level),
              color: level > 0 ? p.muted : p.body,
              breakLine: true,
              ...(i > 0 ? { paraSpaceBefore: 6 } : {}),
            },
          };
        });
        slide.addText(runs, {
          ...box,
          fontFace: ctx.font,
          lineSpacingMultiple: TYPE_SCALE.bullet.lineSpacing ?? 1.3,
          fit: "shrink",
          ...(block.valign ? { valign: block.valign } : {}),
        });
        texts++;
        break;
      }

      case "diagram": {
        const ir = ctx.diagrams.get(content.ir);
        if (!ir) {
          throw new Error(
            `emit-pptx: no rendered diagram for ${JSON.stringify(content.ir)} — ` +
              "the orchestrator must resolve every diagram block before emitting."
          );
        }
        // The existing ShapeIR path. Confining a diagram to a 60 % column is a
        // different `box`, not different code; `fit: "content"` (P4) is the
        // layout opting out of canvas fit — the `diagram` layout never does.
        const placed = addShapeIrToSlide(slide, ir, box, {
          fontFace: ctx.font,
          ...(content.fit === "content" ? { fitContent: true } : {}),
        });
        shapes += placed.shapes;
        texts += placed.texts;
        break;
      }
    }
  }

  return { shapes, texts };
}
