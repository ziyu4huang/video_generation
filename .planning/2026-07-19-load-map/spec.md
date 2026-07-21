# Spec: Hand off wayfind to superpowers

## Problem Statement

Pi 生態中有兩個 extension 提供了 agent workflow 技能：
`pi-agent-ext-wayfind`（grilling + wayfinder 系列 7 個技能）和 `pi-agent-ext-superpowers`（brainstorming → writing-plans → executing-plans 等 14 個技能）。

兩者目前是完全獨立的 package，沒有任何關聯標示。使用者（agent）需要知道 wayfind 的技能是 superpowers 方法論的一部分 — 但它們的程式碼維持分離，不整合。

## Solution

建立純概念性的依賴關係：在文件上標明 wayfind 是 superpowers 生態的一部分。不修改任何 runtime 程式碼、不建立 npm 相依、不搬移 skills。

## User Stories

1. As an agent loading superpowers, I want to know that wayfind skills are conceptually part of the ecosystem, so that I can discover and use them in the right workflow order.
2. As a developer maintaining the monorepo, I want the two packages to remain independently deployable, so that I don't create runtime coupling between them.
3. As someone reading the wayfind README, I want to see a clear "belongs to" relationship, so that I understand how it relates to the broader methodology.

## Implementation Decisions

1. **README cross-reference** — Add a "Part of the Superpowers ecosystem" badge/section to `pi-agent-ext-wayfind/README.md`, linking to superpowers as the umbrella methodology. Add a corresponding "Related packages: wayfind" section to `pi-agent-ext-superpowers/README.md`.
2. **No code changes** — Zero changes to `src/`, `extensions/`, or `skills/` content. No npm dependency added. No coordination seam.
3. **No CONTEXT.md merge** — Each package keeps its own domain glossary. No cross-package vocabulary alignment needed (they serve different phases of the workflow).
4. **Out of scope**: Moving skills, merging packages, adding runtime dependencies, creating composite slash commands, or any form of code integration.

## Testing Decisions

Verification is manual: read the updated README files and confirm the cross-reference is present and accurate. No automated tests needed — this is documentation-only.

## Out of Scope

- Code integration or runtime coupling
- Moving skills between packages
- Merging packages
- Creating superpowers→wayfind npm dependency
- Updating any `src/` or `extensions/` files
- Adding cross-package tests

## Further Notes

The wayfinder skill itself (`bun-apps/pi-agent-ext-wayfind/skills/wayfinder/SKILL.md`) already references superpowers' `writing-plans` skill as the next step after charting. The spec formalises what is already implicit in the workflow chain.
