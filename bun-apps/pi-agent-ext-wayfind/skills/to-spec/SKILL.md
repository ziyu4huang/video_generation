---
name: to-spec
description: Use when synthesizing an already-decided conversation into a spec (PRD) — but ONLY after a Wayfind decide-phase (grilling/wayfinder) has settled the decisions; no interview, just synthesis of what's on the table. If the decisions aren't settled yet, use brainstorming or grilling first. Invocation via `/wayfind spec` (or load the skill directly).
disable-model-invocation: true
---

# To Spec

This skill takes the current conversation context and codebase understanding and produces a spec (you may know this document as a PRD). Do **not** interview the user — just synthesize what you already know. Use the project's domain glossary (`CONTEXT.md`) vocabulary throughout, and respect any ADRs in the area you're touching.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already.

2. Sketch out the **seams** at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better — the ideal number is one. Check with the user that these seams match their expectations.

3. Write the spec using the template below, then write it to a local file — `.planning/<effort>/spec.md`. Tell the user the path. (Superpowers' `brainstorming` converges on the same `.planning/` home — its no-effort specs land in the flat `.planning/specs/` — but they are separate entry paths, not a shared artifact. Do not offer `docs/specs/` or any other location.)

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each in the format:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions: modules to build/modify, their interfaces, technical clarifications, architectural decisions, schema changes, API contracts, specific interactions.

Do NOT include specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note it came from a prototype.

## Testing Decisions

What makes a good test here (test external behavior, not implementation details), which modules will be tested, and prior art for the tests (similar tests in the codebase).

## Out of Scope

What is out of scope for this spec.

## Further Notes

Anything else worth recording.

</spec-template>

Once the spec is written, the natural next step is `to-tickets` (slice it into tracer-bullet tickets) and from there into the plan coordinator's execution substrate.
