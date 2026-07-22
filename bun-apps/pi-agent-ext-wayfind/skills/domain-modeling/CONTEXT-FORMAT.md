# CONTEXT.md Format

## Structure

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction
_Source_: `src/orders/order.ts#Order`   ← optional, one per term

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.
- **`_Source_:` anchor — optional, the *one* sanctioned implementation detail.** A per-term locator in `file#symbol` form (e.g. `lib/bilibili.ts#searchVideos`) linking the term to where it lives in code. This is the only implementation detail allowed in CONTEXT.md. The **root** CONTEXT.md carries none (pure glossary); a **per-package** CONTEXT.md may add a single `_Source_:` line per term. Every `_Source_:` must be **verified live** (file exists + symbol defined in it) — a stale anchor is worse than no anchor, so refresh or remove it when code moves. See the skill's "Verify `_Source_:` anchors" step.
