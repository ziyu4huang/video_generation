# Interactive-Result UIs — Prior-Art Synthesis (zk-spawn)

Research goal: how rich AI results are presented inline AND let the human react
(edit, regenerate-tweak, accept/reject, approve-media). Read-only survey of five
products, then transferability to a **loopback-only, media-first pi-agent webui**
whose rendered HTML views are sandboxed iframes (no scripts).

All URLs below were fetched live (HTTP 200) or via the Wayback Machine during this
research; mechanism lines are grounded in the fetched text.

---

## Per-product: named interaction pattern + mechanism + URL

### 1. ChatGPT Canvas — "Side-by-side co-edit document/code panel"
- **Pattern**: A dedicated **Canvas window** opens beside chat for writing/code that
  needs revision. You can **directly edit** text/code; you **highlight a span to
  target** the model; a **shortcuts menu** issues structured tweaks (adjust length,
  suggest edits, review code, add logs, fix bugs, port to a language). A **back
  button restores previous versions**. Model is trained to do **targeted edits when
  you select text, else full rewrites**.
- **Round-trip**: edits + the current selection are sent as context to the next
  generation (no separate "save"; the document IS the shared state).
- URL: <https://openai.com/index/introducing-canvas/> (primary; archived copy used:
  <https://web.archive.org/web/20260730180932/https://openai.com/index/introducing-canvas/>)

### 2. Claude Artifacts — "Dedicated rendered panel + fork-from-message + publish"
- **Pattern**: Artifacts (code/docs/SVG/HTML/React) render in a **dedicated panel next
  to the chat**, viewable/editable/interactive in real time. Iterate via **follow-up
  prompts** ("make the buttons bigger"). **Fork**: go back to any prior message →
  click **Edit → new conversation branch** (original preserved). **Publish** →
  shareable link; viewers **Remix & customize** into their own copy.
- **Round-trip**: the rendered artifact is regenerated from chat context; editing a
  prior message re-runs the tail of the conversation. Artifacts also expose a **code
  view you can hand-edit**, then continue from; code is copy-out-able to a real editor.
- URLs (live 200, redirected from support articles 11649427 / 11649438):
  - <https://claude.com/resources/tutorials/use-artifacts-to-visualize-and-create-ai-apps-without-ever-writing-a-line-of-code>
  - <https://claude.com/resources/tutorials/prototype-ai-powered-apps-with-claude-artifacts>

### 3. Cursor — "Live diff view + Stop/revert + (PR) review"
- **Pattern**: As the agent edits, a **diff view shows changes as they happen**; click
  **Stop** (⌘⇧⌫) to cancel mid-run, or **revert** and refine the plan. **Agent Review**
  runs a dedicated review over local/branch changes (`/agent-review`, Source-Control
  tab, or auto-after-commit). The **Agents Window** ships a **"new diffs view: review
  and commit changes"** without leaving Cursor. **Design Mode** adds **visual direct
  manipulation** over a *running* app preview: click an element / draw a box / narrate,
  and the agent edits the code (hot-reloads in-place).
- **Round-trip**: the editor is the source of truth; agent writes diffs into files,
  human reviews in-diff and keeps/reverts.
- URLs (live 200):
  - <https://cursor.com/learn/reviewing-testing> (diff-as-it-happens, Stop, revert, @Branch self-review)
  - <https://cursor.com/docs/agent/agent-review> (Agent Review)
  - <https://cursor.com/docs/agent/agents-window> (diffs view, review & commit)
  - <https://cursor.com/docs/agent/design-mode> (visual prompting over a live preview — Q5)

### 4. Devin — "PR-centric review + code-changes-from-chat + session insights"
- **Pattern**: **Devin Review** is a standalone diff surface for PRs/MRs: **smart-diff
  grouping, copy/move detection, bug-catcher + security scanning**, and GitHub-native
  **approve / request-changes / comment**. **"Code changes from chat"**: ask the chat
  agent for an edit, review the suggested change, **apply as a commit** to the PR
  branch without leaving. PR-workflow actions (merge/close/draft) inline. **Session
  Insights** is a post-hoc analytics modal (ACU usage, size, category, issue timeline).
- **Round-trip**: changes are proposed as commits/diffs; human approves/applies at the
  PR granularity.
- URLs (live 200):
  - <https://docs.devin.ai/work-with-devin/devin-review>
  - <https://docs.devin.ai/product-guides/session-insights>

### 5. v0 — "Preview ↔ Code dual panes + diff view + follow-up iteration"
- **Pattern**: The result is a **live rendered app (Preview)** with a **Code tab**
  beside it housing a **full editor** (syntax highlighting, global search, file tree).
  You **edit v0's output directly in the browser**; an **"Unsaved Changes" banner**
  offers **save / reset** (⌘S). A **Toggle Diff View** shows what each generation
  changed; **Split view** puts diff + editor side-by-side. Iterate with **follow-up
  prompts** that build on prior versions; **voice input** supported.
- **Round-trip**: human edits become the new source; next generation/regeneration
  builds on the edited files; diff view makes the delta legible.
- URLs (live 200):
  - <https://v0.app/docs/code-editing> (Code tab, diff view, save/reset)
  - <https://v0.app/docs/text-prompting> (iteration workflow)
  - <https://v0.app/docs> (overview)

---

## Answers to the five specific questions

**Q1 — INLINE EDIT of a presented result → round-trip to the model.**
Two viable shapes in the wild:
- **State-is-the-document** (Canvas, v0): the panel content IS shared state; you edit
  in place and the model consumes the current buffer as context next turn. No explicit
  "push back."
- **Edit-message / fork** (Claude Artifacts): edit a prior message to spawn a new
  branch; the conversation tail re-runs, regenerating the artifact from the fork.
- **Hand-edit code then continue** (v0 save/reset, Cursor inline-edit): human edits the
  generated source; subsequent agent turns diff against the edited file.
Refs: Canvas (openai.com/index/introducing-canvas), v0 code-editing (v0.app/docs/code-editing),
Artifacts tutorials (claude.com/resources/tutorials/…artifacts…).

**Q2 — REGENERATE-WITH-TWEAK UX ("redo with this change").**
No product diffs the *prompt*. They all use one or more of:
- a **free-text follow-up** that the model applies incrementally (Artifacts "make the
  buttons bigger"; v0 "add search + pagination"; Canvas highlight-then-ask);
- a **structured shortcuts/menu** (Canvas: adjust length / fix bugs / port to language);
- a **tweak field over the rendered result** + branch/fork for variants (Artifacts
  Edit-message; v0 save/reset on the editor).
Refs: same as Q1 + Canvas shortcuts list.

**Q3 — ACCEPT/REJECT UX for code/diffs.**
- **Cursor**: live diff-as-it-happens + **Stop** + **revert** + checkpoint/restore;
  Agent Review + the Agents-Window "diffs view: review & commit"; classic per-hunk
  accept/reject lives in inline-edit/Composer.
- **Devin**: PR-level **approve / request-changes / comment**, plus **code-changes-from-
  chat → apply as commit**.
- **v0**: **Diff View** to read changes; **save/reset** the Unsaved-Changes banner is
  the accept/reject at the file level.
Refs: cursor.com/learn/reviewing-testing, cursor.com/docs/agent/agent-review,
docs.devin.ai/work-with-devin/devin-review, v0.app/docs/code-editing.

**Q4 — IMAGE/MEDIA result display + feedback (the priority).**
None of these five is image-generation-first, so the direct prior art is thin — they
treat media as a *rendered artifact*, not a generated asset to grade:
- **Artifacts** render SVG/images/React in the side panel; feedback = follow-up prompt
  or fork; **Publish** shares the rendered media (closest analogue to "approve an image
  by sharing it").
- **Cursor Design Mode** is the strongest media-feedback transfer: you point at a
  rendered visual (element select / box-draw on a **frozen screenshot frame**) and the
  agent gets **element identity (xpath/fiber) + a screenshot** as spatial context — i.e.
  **annotate-the-pixel → reprompt**. This is the most relevant pattern for image-gen
  approval ("change *this* region").
- **Canvas** back-button version restore is the cheap "regenerate/undo" model.
Takeaway for media-first: the field uses **(a) follow-up-prompt-with-region-context**
(Cursor Design Mode) and **(b) approve-by-publish/share + branch** (Artifacts) — there
is no standard "thumbs + per-region mask" accept/reject among these five.
Refs: cursor.com/docs/agent/design-mode; claude.com/resources/tutorials/…artifacts…

**Q5 — The SANDBOXED-VIEW problem (safe render + interactive controls).**
This is the crux, and the products split cleanly into two architectures:
- **Shell-hosted controls + sandboxed render** (Artifacts, and Cursor's preview browser).
  The *rendered content* lives in a sandboxed iframe (scripts run so React/HTML can be
  interactive, but network/storage are restricted; Artifacts notably can't interleave
  arbitrary scripts with the host). The **meta-controls** — Publish, Edit, version nav
  (< >), fork, regenerate, Stop, accept/reject — live in the **surrounding shell**, NOT
  in the iframe. The iframe only emits the artifact; the shell wraps it with buttons.
- **Same-origin editor + preview** (Canvas, v0, Devin Review). Here the editable surface
  and controls are **same-origin** (v0's Code tab and the Preview are both part of the
  app; Cursor Design Mode drives a same-origin preview it can inspect). No hard sandbox
  wall between control and content — so they can do tight things like select-an-element
  → read the fiber tree.
The reconciliation rule: **if you must sandbox the render, push ALL interactive affordances
into the shell and communicate via postMessage / events; if you can keep it same-origin,
the control surface can overlay the content directly.**
Refs: cursor.com/docs/agent/design-mode (frozen-frame annotation, fiber read),
claude.com/resources/tutorials/…artifacts… (panel + Publish/Edit + "lack of interleaved
scripts"), v0.app/docs/code-editing (Preview/Code same-origin panes).

---

## Transferability → pi-agent webui (loopback-only, media-first, sandboxed-iframe renders)

Constraints of the target:
- **Media-first**: primary results are generated **images/videos**, not code/docs.
- **Loopback-only**: the webui talks to a local agent over loopback; no external network
  egress from the rendered view.
- **Rendered HTML views are sandboxed iframes with no scripts** → the iframe cannot host
  approve/regenerate buttons; interactive controls must live in the **shell** or a new
  **non-sandboxed surface**.

**Best fit: the "Shell-hosted controls + sandboxed render" architecture (Artifacts +
Cursor Design Mode), adapted for media.**

Recommended pattern:
1. **Sandboxed iframe = pure media render** (the generated image/video, optionally inside
   a safe HTML chrome). It emits nothing but pixels / standard media events. This matches
   the current sandboxing and keeps loopback-only hygiene (no script egress).
2. **All reaction affordances live in the shell**, directly adjacent to the iframe — a
   thin toolbar per result: **Approve** (→ publish/share/commit, à la Artifacts Publish),
   **Regenerate** (reprompt; loopback round-trip), **Regenerate-with-tweak** (a small
   follow-up field → Canvas/Artifacts incremental reprompt), **Variants/Fork** (Artifacts
   Edit-message branching), **Undo/restore** (Canvas back-button). None of these need to
   run inside the iframe.
3. **For image-specific feedback, borrow Cursor Design Mode's region idea** at the
   *shell* level: overlay a **region-select / annotation layer** (drawn by shell-side JS,
   not the iframe) → capture the bounding box + the frozen frame → feed it into the
   reprompt as spatial context. This is the closest existing prior art to "approve/
   regenerate-this-part" for a generated image, and it keeps the pixel annotation in the
   trusted shell while the media stays sandboxed.
4. **Bridge via postMessage** (iframe → shell) only for inert signals (e.g., "image
   loaded", click coords) — never execute logic in the iframe. This is exactly how
   Artifacts-style "safe render + interactive shell" is reconciled.

**Why not Canvas/v0/Devin patterns as the base?** They assume a **same-origin editable
surface** (you edit the document/code that IS the result). For a media-first product the
result is a binary the human cannot meaningfully "edit in place" — they can only
**approve or reprompt**. That makes the **Artifacts "render panel + shell toolbar +
fork/branch"** model the correct skeleton, with **Cursor Design Mode's region annotation**
grafted on for spatial feedback.

**Smallest viable loop** (concrete): shell renders media in a sandboxed iframe; shell
toolbar = `[Approve] [Regenerate] [Tweak… ▾ (style/seed/aspect/region)] [Variants] [⟲]`;
Tweak/Regenerate send a structured reprompt to the loopback agent; Variants forks a branch
(Artifacts-style); region-select overlay produces a crop+prompt (Design-Mode-style). All
trusted, all in the shell, iframe stays script-free.

Cited: openai.com/index/introducing-canvas (Canvas back-button + shortcuts + targeted-edit-on-select);
claude.com/resources/tutorials/use-artifacts-to-visualize-and-create-ai-apps-without-ever-writing-a-line-of-code
+ …/prototype-ai-powered-apps-with-claude-artifacts (panel, Edit-fork, Publish, sandbox/interleaved-scripts note);
cursor.com/docs/agent/design-mode (frozen-frame region annotation, element+screenshot context);
cursor.com/learn/reviewing-testing + cursor.com/docs/agent/agent-review + cursor.com/docs/agent/agents-window
(diff-as-it-happens, Stop/revert, review & commit); v0.app/docs/code-editing (Preview/Code panes, diff view, save/reset);
docs.devin.ai/work-with-devin/devin-review (approve/request-changes, code-changes-from-chat).
