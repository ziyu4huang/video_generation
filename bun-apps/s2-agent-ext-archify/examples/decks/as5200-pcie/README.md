# as5200-pcie — automotive SoC bring-up worked-example deck

17-slide review deck: an automotive SoC (8× Cortex-A78AE + DSU-110, ASIL-D island,
three Gen4 root ports) and the five PCIe bugs that dominate its bring-up — LTSSM
RcvrLock loop, Gen4 equalization at 125 °C, completion timeout by posted-write
ordering, MSI-X CDC doorbell loss, FLR/hot-reset race. Everything is a fictional
but internally consistent worked example; the numbers are illustrative.

## Layout

- `deck.config.json` + six diagram IRs — the deck SOURCE (committed).
- Everything GENERATED lands in `<repo>/output/as5200-pcie/` — gitignored
  (repo-root `/output/`), regenerate anytime with the commands below.

Generated artifacts:

| Artifact | What it is |
| --- | --- |
| `as5200-pcie.pptx` | native vector shapes (803), fully editable — no screenshots |
| `as5200-pcie.slides/slide-N.html` | per-slide HTML; diagram slides are interactive viewers |
| `as5200-pcie-deck.html` | ONE self-contained file: all 17 slides inlined (srcdoc), offline |
| `shots/` | stage-exact review captures (`capture.ts`) |

## Regenerate

From the repo root:

```sh
# deck → <repo>/output/as5200-pcie/
bun bun-apps/s2-agent-ext-archify/scripts/deck.ts \
  bun-apps/s2-agent-ext-archify/examples/decks/as5200-pcie/deck.config.json \
  --output output/as5200-pcie/as5200-pcie.pptx

# single-file offline deck (inlines the slides dir as srcdoc iframes)
bun bun-apps/s2-agent-ext-archify/examples/decks/as5200-pcie/combine.ts

# optional: re-capture review screenshots (needs a graphics session)
bun bun-apps/s2-agent-ext-archify/examples/decks/as5200-pcie/capture.ts
```

## Reading the HTML deck

Diagram slides open in **map detail** — structure only, labels faded. Zoom inside
a slide (or the `+` control): ≥125 % reveals labels (READ), ≥175 % adds tags and
annotations (FULL). `Present` gives a clean full-bleed view; the `.pptx` carries
every label as vector text regardless.
