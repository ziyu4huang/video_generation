# spec — webui-tab-views

Frame additions: `report` outbound only {id, title, markdown?, html?, source, ts} — exactly one of markdown|html non-empty. Store: report frames append + cap-exempt. Shell: tabs [Transcript][Report][Ask][Events][Data]; routing — txApply card: id startsWith "ask-" → Ask pane; kind === "viewer" → Data pane (row entry); else Events pane. card_done routes to the pane owning the card id. report frame → Report pane (md renderer: h1-h3/p/ul/li/code/pre/strong/em via createElement+textContent; html → iframe sandbox allow-scripts srcdoc). Ask pane: pending interactive forms top, answered (card_done w/ answers) collapsible review below — reuse cards-ux2 04 review rendering. Data pane: row per viewer card (title+ts); click → full-pane iframe (same srcdoc build incl. bridge shim); back row visible. Hash routing: #card-<id> finds the pane containing the article (search all card panes) → activate its tab → scrollIntoView + flash. innerHTML count stays ≤ 8 (md renderer is DOM-built; srcdoc via property assignment). Out of scope: producers beyond the helper, Data editing, report persistence to disk (session store only).

Contracts unchanged: card frame, card_done (answers), card_answer/ask_user_answer/card_send appexec guards, bell, JSONL decision log.

Tests per ticket in tickets/*.md. Baseline: webui 482/0, innerHTML 8.
