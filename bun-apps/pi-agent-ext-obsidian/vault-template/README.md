---
created: {{date}}
tags: [meta, readme]
---

# 📓 Project Vault

This is the project-local Obsidian knowledge base, managed by the `pi-obsidian`
extension. It lives at `<repo>/vault/` and is writable by the pi agent.

## Structure

```
vault/
├── README.md            ← you are here
├── Inbox/               ← quick capture, unsorted
├── Daily/               ← daily notes
├── Design/              ← design docs
├── Zettelkasten/        ← atomic idea cards (one thought per note)
├── Templates/           ← note templates
└── Tags/
    └── Index.md         ← Map of Content (MOC)
```

## Agent hint

> When the user says "note this down" / "record to Obsidian", default to writing
> into `Inbox/` and link related notes with wiki-links `[[Target]]`.
>
> When the user wants to "settle a single idea / viewpoint", create an atomic
> note in `Zettelkasten/` from `Templates/Zettelkasten Note`. Always include
> at least one wiki-link in its `## 連結` section.

## Links

- [[Templates/Daily Note]]
- [[Tags/Index]]
