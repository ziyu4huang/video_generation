## Question
Can this repo owner-declare `gating:{ core: true }` on pi-coding-agent's built-in tools `read`, `write`, `edit`, `bash`? They live in `@earendil-works/pi-coding-agent` (upstream — `dist/core/tools/{read,write,edit,bash}.js`), NOT in this repo, so the in-repo tool-def augmentation pattern can't reach them directly. Determine: (a) is pi-coding-agent an editable sibling repo or an immutable npm dependency? (b) does its tool-def type already accept `gating` (is the global `Gating` augmentation in `types/tool-gating.d.ts` visible to pi-coding-agent's tool defs)? (c) what's the viable mechanism to get `core:true` onto the 4 built-ins — a sibling-repo edit, an in-repo registration-time augmentation hook, or a cross-repo PR? This fact gates the destination (full CORE_TOOLS deletion) and the shape of ticket 03.

type: research
blocked by:
status: open
