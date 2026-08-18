# webui-readability spec — 2026-08-18 (user-approved order G1>G2>G4; G3 deferred)

Doctrine: the webui is the human-readability bonus lane (catalog P4). All
three items reuse existing pipelines; no new transports, no new stores.

## G1 — markdown in the chat feed
- The Inbox feed shows assistant text as plain lines today. Final assistant
  messages (message_end) re-render through the EXISTING server markdown
  pipeline: POST /api/markdown {text} -> {html} (renderMarkdown, the same
  marked config the Report tab uses). Display in a sandboxed iframe (the
  shell's established security boundary — agent text never runs in page
  origin). Streaming message_update lines stay plain (fast path); message_end
  swaps the accumulated block for the rendered one.
- Tests: route unit test (markdown -> html, empty body 400, size cap), shell
  literal tests (fetch /api/markdown, sandbox attr on the chat frame).

## G2 — mobile responsive pass
- viewport meta; narrow-width media query (tabs wrap, feed/composer full
  width, composer sticky above keyboard); larger touch hit targets. Pure CSS
  + meta; literal tests.

## G3 — DEFERRED (multi-session index; needs architecture decision)

## G4 — transcript search/filter
- A filter input on the Inbox pane: substring match over feed items (client
  hides non-matching rows); frame-type chips (all/text/cards/tools). Pure
  shell JS; literal tests.
