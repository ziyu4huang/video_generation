---
name: domain-modeling
description: Use when sharpening a domain model — pinning ubiquitous language, keeping the glossary, and writing CONTEXT.md + ADRs as decisions land.
---

# Domain Modeling

Build and sharpen the domain model as you design — the *active* discipline of **changing** it: challenging terms, inventing edge-case scenarios, writing decisions down the moment they crystallise. Merely *reading* `CONTEXT.md` for vocabulary is not this skill (any skill can do that); this fires when you're changing the model, not consuming it.

## File structure

Most repos have a single context:

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives. Create files lazily — only when you have something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` is a glossary — definitions, not a spec or scratch pad. Keep it **devoid of implementation details** (file paths, config keys, code) with **one sanctioned exception**: a per-term `_Source_:` anchor in `file#symbol` form. The **root** `CONTEXT.md` stays a pure glossary (no anchors); a **per-package** `CONTEXT.md` may add a single `_Source_:` line per term. This exception exists so a behavior named in the glossary can be traced to its code in one hop — but only if the anchor stays live (see next section).

### Verify `_Source_:` anchors stay live

Whenever you add or edit a `_Source_:` anchor — or finish a session that touched code any anchor points at — verify every anchor **resolves against the current repo**: the file exists and the symbol is actually defined in it. A stale anchor actively misleads; refresh it to the new location or remove it. Do not leave it broken.

Quick check (run from the package root that owns the CONTEXT.md; matches `.ts` and `.py`):

```bash
python3 - <<'PY'
import re, os, sys
pat = re.compile(r'`([A-Za-z0-9_./-]+\.(?:ts|py))#([A-Za-z0-9_]+)`')
fail = 0
for f in ("CONTEXT.md",):
    if not os.path.exists(f):
        continue
    for path, sym in pat.findall(open(f).read()):
        ok = os.path.exists(path) and bool(
            re.search(rf'\b(def|export\s+(?:async\s+)?(?:function|const)|const)\s+{re.escape(sym)}\b',
                      open(path).read()))
        if not ok:
            fail += 1
            print(f"❌ {path}#{sym}")
print(f"{fail} stale anchor(s)" if fail else "all anchors live")
sys.exit(1 if fail else 0)
PY
```

(For a multi-file sweep, point the loop at every `**/CONTEXT.md` under the repo.)

### Offer ADRs sparingly

Only offer to create an ADR when **all three** are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).
