# Ticket 03 — guided views into pptx

**Effort:** 2026-08-22-archify-deck-template-v2 · **Status:** closed

Diagram/split slide accepts `"views": "expand"`: deck pipeline expands meta.views into 1 overview + N build slides (title=view label, takeaway=view note, focus full color, rest dimmed via pptx transparency). deck-lint diagnostic on view refs to unknown ids. Tests: expansion count/order, dimming applied, no-views manifest unchanged.
