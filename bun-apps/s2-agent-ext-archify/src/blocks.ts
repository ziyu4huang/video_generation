/**
 * blocks.ts — the only place a PlacedBlock is born.
 *
 * layouts.ts and layout-template.ts must produce indistinguishable blocks
 * (`formatBlocks` prints both the same way), so they share these constructors
 * rather than each hand-rolling `{ box: fromInches(...), ... }`. A drift here
 * would show up as a template block landing a fraction of an inch off the same
 * code layout's block — exactly the kind of difference formatBlocks cannot
 * forgive.
 */
import {
  fromInches,
  type BlockContent,
  type InchBox,
  type PlacedBlock,
} from "./slide-model.ts";

/** Build a block from inch coordinates — the only constructor downstream files use. */
export function at(
  box: InchBox,
  content: BlockContent,
  align?: PlacedBlock["align"],
  valign?: PlacedBlock["valign"]
): PlacedBlock {
  return {
    box: fromInches(box),
    content,
    ...(align ? { align } : {}),
    ...(valign ? { valign } : {}),
  };
}

/**
 * Text block constructor. The role is typed `string`, not `Role`: templates
 * declare their own role names and `Role` widens only at the emitter boundary
 * (effort decision §4.5). Code layouts keep their own narrow-`Role` wrapper in
 * `layouts.ts` so the six lose no type safety.
 */
export function text(box: InchBox, role: string, s: string, align?: PlacedBlock["align"], valign?: PlacedBlock["valign"]): PlacedBlock {
  return at(box, { kind: "text", role, text: s }, align, valign);
}
