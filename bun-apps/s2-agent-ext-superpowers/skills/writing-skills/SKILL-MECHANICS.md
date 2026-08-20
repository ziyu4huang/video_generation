# Skill mechanics

The skill-specific branch of [`writing-skills`](SKILL.md): what changes when the document is a skill — frontmatter, the invocation choice, and router skills. Everything else about writing it is the universal reference in `SKILL.md`.

## How pi loads a skill

Every skill is a folder with a `SKILL.md`; the extension registers the skills directory once (`"pi": { "skills": ["./skills"] }`). pi surfaces each skill's frontmatter `name` + `description` in the agent's **available_skills** list on every turn — that description is the skill's always-loaded context pointer. The agent **reaches** a skill by reading its `SKILL.md` (a single `read` call), then runs it. So "model-reachable" just means: the skill sits in `available_skills`, and the agent will read its `SKILL.md` when the description's wording fires.

## Invocation

Two choices, trading the two loads:

- A **model-reachable** skill keeps a trigger-rich `description` ("Use when…"), so the agent can fire it autonomously — and other skills can point at it. You can still name it by hand: model-reach always _includes_ human reach; a description only ever adds agent discovery, never removes the human's. The description is the skill's top-level context pointer, forced to stay loaded at all times — permanent context load in exchange for discoverability. A model-reachable skill whose content is all reference is also one home for shared reference: another skill can reach it, so reference needed by several skills lives in one place. Mechanics: omit `disable-model-invocation`, and write a model-facing description carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full).
- A **user-invoked** skill sets `disable-model-invocation: true`, so only the human asking for it by name pulls it in. Zero context load beyond the description line, but it spends cognitive load — you are the index that must remember it exists. The `description` becomes human-facing: a one-line summary of when to reach for it, trigger lists stripped.

Pick model-reach only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load.

Shared reference that two user-invoked skills both need can live in neither — with neither model-reachable, neither can fire the other. Push it to a plain file outside the skill system: external reference any skill can point at.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-reachable skill when you have a distinct leading word that should trigger it on its own — a trigger word you actually use in your prompts — or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only hint, never fire them: user-invoked skills aren't model-reachable, so nothing but the human can reach them. The `ask-matt` skill in the wayfind extension is exactly that router.
