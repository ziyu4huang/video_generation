# examples/aspice4-alm — ASPICE 4.0 / ALM assessment deck (illustrative)

A worked ASPICE 4.0 process-assessment deck built from the archify data-driven
surfaces: the `aspice-bp` (base-practice coverage board) and `pa-rating`
(capability strip) layout templates over an 8-slide SWE.1 + HWE.2 assessment.

**All content is ILLUSTRATIVE** — BP statements are paraphrases, verdicts and
evidence references are synthetic. Structural facts follow the ASPICE 4.0 PAM
(VDA QMC, released 2023-11-29: HWE.1–4, MLE.1–4, SUP.11 new; all BPs reworked).

## The ALM workflow (why JSONL)

The AUTHORED form of this deck is `assessment.deckl` — the archify JSONL
envelope (`deck pack` format, one line per slide). That is the ALM integration
seam: an assessor (or an ALM tool export) appends/mutates one line per
assessment state change, then two commands regenerate every artifact:

```sh
# deck.config.json edited (or assessment.deckl) → repack the canonical envelope, then rebuild:
bun bun-apps/s2-agent-ext-archify/scripts/deck.ts pack examples/aspice4-alm/deck.config.json --out examples/aspice4-alm/assessment.deckl
bun bun-apps/s2-agent-ext-archify/scripts/deck.ts unpack examples/aspice4-alm/assessment.deckl --out examples/aspice4-alm
bun bun-apps/s2-agent-ext-archify/scripts/deck.ts examples/aspice4-alm/deck.config.json --output output/aspice4-alm/aspice4-alm.pptx --combine
```

Editing `assessment.deckl` directly works too (it is the authored form): skip the
pack step and go straight to `unpack`. Either way the envelope stays the
canonical bytes of the config.

**Guardrail**: the envelope header carries `slideCount` — appending a NEW slide
line requires bumping the header count to match, or `deck unpack` refuses
(naming both counts). That refusal is the format's integrity check, not a bug.

Outputs: editable `.pptx` (native shapes), per-slide interactive HTML, and a
single-file offline `deck.html` player. Deterministic — same `.deckl`, same
bytes.

## Speaker notes

`notes` on a slide reach the combined deck's presenter pane (press `n`) and the
pptx speaker notes — never the per-slide pages.

## Template reference

| Slide | Template | What it shows |
|---|---|---|
| 3, 4 | `aspice-bp` | base-practice coverage: id / practice / verdict (SAT·PART·MISS) / evidence ref |
| 5 | `pa-rating` | capability strip: GP 1.1.1–1.1.4 rated N/P/L/F |
| 6 | `table` | requirement→design→code→test→evidence traceability rows |
| 7 | `compare` | gaps vs plan-of-action |

Reading the HTML deck: `n` toggles notes, `g` the overview, `← →` pages.
