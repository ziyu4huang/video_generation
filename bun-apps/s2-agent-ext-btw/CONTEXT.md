# s2-agent-ext-btw

The ubiquitous language of s2-agent-ext-btw — the BTW side-conversation channel: a focused modal for parallel Q&A without polluting the main agent context. Extracted from power-tool; adapted from pi-btw (Dan Bachelder).

## Language

**BTW** (side-conversation):
The side-conversation channel — a focused modal for parallel Q&A that runs alongside the main agent turn without polluting its context. The package's namesake concept.
_Avoid_: chat, sidebar (it is a context-isolated side-conversation, not a persistent chat)

**`/btw`**:
The command (plus keyboard shortcuts) that opens the side-conversation modal.
_Avoid_: ask, query (it is the BTW modal-opening command)

**Context filter**:
The mechanism that keeps the side-conversation out of the main agent context — side Q&A does not enter the main turn's history, so the main context stays clean.
_Avoid_: isolation, sandbox (it is a context-inclusion filter on the side-conversation)
