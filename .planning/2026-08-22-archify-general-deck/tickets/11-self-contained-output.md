# Ticket 11 — Self-contained output folder

**Phase:** 2.5 — output packaging (added 2026-08-23, from the ~/proj/output audit)
**Status:** open
**Blocks:** none. **Blocked by:** none (independent of the template seam).
**Builds-on decision:** D9.

## Problem (measured 2026-08-23, ~/proj/output)

One deck's artifacts smear across three sibling entries of the parent dir:

```
~/proj/output/
  archify-aspice4-v3/           ← manifest + IRs + rendered diagram HTML
  aspice4-chip-v3.pptx          ← escaped to parent
  aspice4-chip-v3.slides/       ← escaped to parent
```

Same shape for archify-self-explainer and both other decks. The requirement:
ONE self-contained folder per deliverable — manifest, IRs, `.pptx`, slide HTML,
and diagram artifacts all inside a single named project folder.

## Root cause — the tools are NOT the leak

- `resolveDeckOutput` (deck-build.ts:524) resolves manifest-relative `output`
  INTO the manifest dir; both shipped examples write beside their manifest.
- `defaultSlidesDir` (deck-build.ts:542) puts slides adjacent to the `.pptx`.

The escape happened at AUTHORING time: the driving prompt passed an absolute,
top-level `outputPath` while the manifest stayed in a subfolder. Nothing in the
tool surface or the skill says otherwise, so the agent had no signal it was
breaking the one-folder property.

## Fix (three parts, all additive)

1. **SKILL.md contract** — new "Output layout" rule: one deliverable = one
   folder. Manifest, `ir/`, the `.pptx`, `*.slides/`, and rendered diagram HTML
   live under a single named project folder; `outputPath`, when given, points
   INSIDE it (or is omitted so `manifest.output` decides).
2. **Export-time spread advisory** — in `export-pptx.ts`, after resolving
   `outputPath`: if `dirname(outputPath) !== manifestDir`, attach an advisory
   note (`details.spread = { outputPath, manifestDir }` + a text line) telling
   the agent the deliverable is leaving the manifest folder and how to fix it.
   Advisory only — never fails an export, same channel as `lintDeck` notes.
3. **Example** — the composed example gains a comment-free demonstration of the
   layout (it already conforms; assert it in a test so the convention is pinned).

## Acceptance

- [ ] Export with `outputPath` outside `manifestDir` produces the advisory in
      `content` text and `details.spread`; exit still success.
- [ ] Export with output beside the manifest produces no advisory.
- [ ] SKILL.md carries the Output layout rule (grep-able heading).
- [ ] Canonical `bun run test` green; D3 byte-identity untouched (no XML path
      changes — advisories ride the tool result only).
