# Spec — archify: deck visual fidelity

> STATUS: drafted 2026-08-21, immediately after #1769 (`archify-slide-composition`) merged
> as `130eb2edb`. Every claim in §2 was **probed on this machine** (bun 1.4.0,
> pptxgenjs 4.0.1, macOS 25.5.0) against
> `bun-apps/s2-agent-ext-archify/examples/deck-composed/` at commit `130eb2edb`.
> Where something was not probed, §2 says so instead of estimating.

## §1 Goal

Round 1 proved the `.pptx` is **structurally valid**. It never asked whether the slide
**looks right**. Rendering it once answered that: four defects, none of which 401 passing
tests, a 0-diagnostic OOXML gate and a passing content lint could see.

1. Fix P1–P4.
2. Give each a **renderer-free** structural assertion, so the guard runs on any platform.
3. Make rendering a **portable, on-demand** tool behind one `pptx → N images` seam, plus a
   one-off committed receipt.

**Non-goals** (explicit): golden-pixel baselines in git (§3 D3 — rejected, not deferred);
any CI gate that requires a rendering engine (§3 D1); the `kpi` / `timeline` / `matrix` /
`comparison` layouts (still round 3, still needing no seam change); `pptx-automizer`;
editing `vendored/`.

## §2 Background (measured, not quoted)

### 2.0 How the defects were found

```
deck.config.json                     six one-slide configs, ir paths absolutised
   └─ scripts/deck.ts ──────────────→ slide-{1..6}.pptx
        └─ qlmanage -t -s 1600 ─────→ slide-{1..6}.pptx.png     0.24 s, all six
```

Quick Look renders a thumbnail of the **first slide only**, which is why the deck is split
first. The full procedure is reproducible from §6.

Cross-checked against the HTML twin by screenshotting
`composed.slides/slide-4.html` in `Bun.WebView` at 1600×900. That A/B is what establishes
attribution for P1: same source IR, two emitters, only one of them wrong.

### 2.1 P1 — stroke-only icons fill in

`ppt/slides/slide1.xml` of the one-slide slide-4 deck has 75 `<p:sp>`, 13 with `custGeom`.
Five of them are icons at 57 609 EMU ≈ 0.063 in. Shape 36, verbatim:

```xml
<a:pathLst><a:path w="57609" h="57609">
  <a:moveTo><a:pt x="17283" y="0"/></a:moveTo>
  <a:lnTo><a:pt x="0" y="28805"/></a:lnTo>
  <a:lnTo><a:pt x="17283" y="57609"/></a:lnTo>
  <a:moveTo><a:pt x="40327" y="0"/></a:moveTo>
  <a:lnTo><a:pt x="57609" y="28805"/></a:lnTo>
  <a:lnTo><a:pt x="40327" y="57609"/></a:lnTo>
</a:path></a:pathLst>
```

That is lucide `code` — two chevrons, two subpaths, **geometrically correct**. Shape 48 is
`database` (a cylinder: two subpaths, four cubics), also correct. The path parser and
`arcToCubics` are not implicated.

The `<p:spPr>` for shape 36, in full, is:

```xml
<p:spPr>
  <a:xfrm>…</a:xfrm><a:custGeom>…</a:custGeom>
  <a:ln w="11303"><a:solidFill><a:srgbClr val="41AF8D"/></a:solidFill>
    <a:prstDash val="solid"/></a:ln>
</p:spPr>
```

**There is no fill element of any kind.** Two independent consequences, both of which must
be fixed for the icon to render as an outline:

1. **Shape level.** DrawingML treats an absent fill as *inherit from the shape style*, not
   *no fill*. The required element is an explicit `<a:noFill/>`.
2. **Path level.** `<a:path>` defaults to `fill="norm"` (ECMA-376 `ST_PathFillMode`). Even
   on a `<a:noFill/>` shape, each subpath is filled, and two open chevrons that get closed
   and filled produce exactly the criss-cross burst the render shows. The required
   attribute is `<a:path fill="none" …>`.

`lib/pptx-shapes.ts:85` already reads `if (!style.fill) return { fill: { type: "none" } };`
— the model knows the icon has no fill and says so. The information is lost between that
line and the XML. **Which side loses it is not established**: `pptxgenjs` is not installed
in this worktree (isolated linker + globalStore per `bun-apps/bunfig.toml`), so neither the
option name nor the library's handling of it was inspected. Ticket 01 resolves that first.

### 2.2 P2 — the action title overflows the chrome

Composed slide 4's title, `整顆 SoC 怎麼切、誰接誰——這是 SAS 層要回答的唯一問題`, wraps to
two lines in the rendered `.pptx`. The chrome's rule is drawn at a fixed y, so the second
line is **struck through by the rule and clipped** by the content well below it.

`deck-lint` passed this deck. Its title rule is a length check, and the prior effort chose
it deliberately over autofit, reasoning that "a title that silently shrinks is worse than
one a linter complains about" (`archify-slide-composition/map.md`, Fog of war). The
reasoning stands; the **calibration does not** — a length threshold tuned without knowing
the box width and font size cannot predict a wrap.

### 2.3 P3 — SVG node text clips and wraps wrongly

Visible in the same render: `SYS.1/2 需求來源` inside the MRD node renders clipped, and the
connector label `系統需求` breaks as `系統需 / 求`. Both come from the documented estimate
in `lib/pptx-shapes.ts`, `node.fontSize * 0.62 * text.length * 1.35` with `wrap: false` —
a Latin advance guess applied to full-width CJK, where the true advance is ≈ 1.0 em.
The prior effort documented this as a known limitation of the diagram path; this effort has
the picture that shows it is not merely theoretical.

### 2.4 P4 — the split slide's diagram is small and low

On composed slide 3 the diagram occupies roughly the lower half of its column with a large
empty band above. `addShapeIrToSlide` is documented to scale uniformly and centre, so this
is **either** a centring defect **or** correct behaviour applied to an artifact bounding box
that itself contains the legend row and empty canvas. Not established. Ticket 04 measures
the artifact's own bbox against the emitted `<a:off>`/`<a:ext>` before anything is changed.

### 2.5 Renderers — what is available and what is not

| backend | platform | route to N images | measured |
| --- | --- | --- | --- |
| `quicklook` | darwin | split deck → N one-slide `.pptx` → `qlmanage -t` | **0.24 s / 6 slides**, zero install |
| `libreoffice` | darwin, linux, windows | `soffice --headless --convert-to pdf` → rasterize pages | **not installed here — unmeasured** |
| `none` | any | refuse loudly with the reason | — |

`no-browser-deps.test.ts` bans only packages that bundle a browser **download**
(`playwright`, `@playwright/test`, `puppeteer`); `playwright-core`, `puppeteer-core`,
`Bun.WebView` and system binaries are explicitly allowed. `qlmanage` and `soffice` are
system binaries and sit outside that guard entirely.

The same file records why this matters: CI skip-gates "made the old mermaid paint-check dead
for months". That is the reason for D1.

## §3 Decisions

- **D1 — the renderer sees, it never gates.** Every permanent assertion added by this effort
  is computed from emitted OOXML or from the slide model, with no engine involved. Rendering
  is an on-demand command plus a one-off committed receipt. *Why:* a renderer-gated check
  degrades to a dead gate wherever no renderer exists, which this repo has already paid for
  once.
- **D2 — the seam is `pptx → N images`.** Quick Look yields slide 1 only and needs the deck
  split; LibreOffice converts the whole file to a PDF and rasterizes. Interfacing below that
  difference would leak it to callers. `renderSlides(pptx, outDir) → string[]` with a
  stable `slide-N.png` naming contract is the whole surface.
- **D3 — no golden-pixel baselines in git.** Renderer-version and font dependent,
  unreviewable in a PR diff, churns on every legitimate change. Rejected outright, not
  deferred, so a later reader does not mistake it for unfinished work.
- **D4 — fix before instrument.** P1–P4 are confirmed now; deferring them behind harness
  work trades known defects for infrastructure. User's choice, 2026-08-21.
- **D5 — attribution before repair.** P4 ships a measurement first and a change only if the
  measurement says there is one to make. P1 and P2 already have their attribution (§2.1,
  §2.2); P4 does not, and the spec does not pretend otherwise.

## §4 Acceptance

- P1: on both example decks, every `<p:sp>` whose ShapeIR node has a stroke and no fill
  emits `<a:noFill/>`, and every `<a:path>` within it carries `fill="none"`. Asserted
  structurally, no renderer.
- P2: a composed deck whose action title would wrap past the chrome band **fails** a gate,
  and the six-layout example deck passes it. The budget is derived from the title box width
  and font size, and counts full-width characters as ≈ 1 em.
- P3: node and connector text that fits in the HTML twin is not clipped in the `.pptx`.
  Asserted as a width contract on the emitted text box, no renderer.
- P4: either a measurement showing the current placement is correct — recorded and closed —
  or a fit change with an assertion pinning it.
- Seam: `renderSlides` returns N images on darwin via `quicklook`, refuses with a named
  reason where no backend exists, and never throws into a caller's build.
- Backwards compatibility: the legacy `examples/deck/` manifest keeps building, and the
  five legacy slide XML parts stay **byte-identical** to the round-1 capture except where
  P1's fill elements are legitimately added. Any byte that moves is explained in the PR.
- Suite: 401 → higher, 0 failing. `local_ci` green.

## §5 Risks

- **P1's fix may not be expressible through `pptxgenjs`.** If the library cannot emit
  `<a:noFill/>` or a per-path `fill` attribute, the emitter needs an XML post-process step,
  which is a materially larger change and touches the byte-identity claim above. Ticket 01
  answers this before any code is written.
- **The byte-identity lock and P1 are in tension.** Adding `<a:noFill/>` changes bytes in
  the legacy deck's slides if those slides contain stroke-only paths. That is a *correct*
  change, but it must be shown to be the only one, the way round 1 caught the stray
  `algn="l"` by comparing bytes rather than counts.
- **LibreOffice may disagree with Apple's importer** about what a slide looks like. Nothing
  gates on either, so this cannot turn CI red — but it can make two receipts from two
  machines incomparable, which is worth knowing before anyone trusts a Linux receipt.

## §6 Reproducing the probe

```bash
cd bun-apps/s2-agent-ext-archify
# 1. split the composed example into one-slide decks, absolutising `ir` paths
#    (relative paths break once the config moves out of examples/deck-composed/)
# 2. build each:      bun scripts/deck.ts <cfg-N.json>
# 3. render all six:  qlmanage -t -s 1600 -o <outdir> <dir>/slide-*.pptx
# 4. HTML twin:       Bun.WebView 1600x900 over file://…/composed.slides/slide-4.html
```

Ticket 05 turns steps 1–3 into `deck render` so this stops being a hand-rolled recipe.
