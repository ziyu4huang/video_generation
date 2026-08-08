---
type: task
status: open
---

# 01 — Obtain GLM Pro (coding plan) rate-limit numbers

## Question

What are the actual rate limits for the GLM/Zhipu "coding plan" Pro tier (the active `zai` provider)? Needed to size the concurrency cap (ticket 03) and populate the config (ticket 02). Not found anywhere in the repo or ~/.pi.

Specifically:
- Requests per minute (RPM)?
- Tokens per minute (TPM), if enforced?
- Max concurrent requests/connections, if any?
- Is it per-API-key (so multiple worktrees/sessions share one budget)?

## Resolution path

You're the account holder on the Pro tier — check the Z.ai dashboard / plan docs / your plan's rate-limit page and report the numbers. (If publicly documented, a web_search pass can gather them — but account-tier specifics are usually behind the dashboard.) Also note the limit's SHAPE (RPM-only? RPM+TPM? concurrent?) — it determines whether v1's concurrency-cap proxy suffices or a token-bucket is needed sooner.

Record the numbers here on resolution; they get set into `~/.pi/workflows/settings.json -> rateLimits.zai.maxConcurrent` (ticket 02's schema).
