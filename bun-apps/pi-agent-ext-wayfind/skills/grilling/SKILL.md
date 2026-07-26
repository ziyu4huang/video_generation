---
name: grilling
description: Use when the user wants to grill a decision or idea — a relentless one-question-at-a-time interview, each with a recommended answer.
---

# Grilling

Interview the user relentlessly about the plan, decision, or idea until you reach shared understanding — **one question at a time**, waiting for feedback before continuing. Asking multiple at once is bewildering: it forces the user to hold several open threads and produces shallow answers instead of resolved decisions. For each question, provide your recommended answer.

## Facts vs decisions

If a *fact* can be found by exploring the environment (filesystem, tools, code, docs), **look it up rather than asking**. Read the file, grep the codebase, check the config — do not make the user transcribe what the repo already states. But the environment reflects the *current branch*, which may lag the line of development — before treating gathered facts as ground truth for a decision, confirm the branch is current (`/wayfind` checks this; otherwise `git rev-list --count HEAD..origin/<default>`); if behind, say so and prefer rebasing.

The *decisions*, though, are the user's — put each one to them and wait for their answer. Even when you have a strong recommendation, the call is theirs; offer the recommendation, then stop.

## The discipline

- **One question at a time.** Never a questionnaire dump.
- **Recommended answer for every question.** Don't just probe — propose. The user confirms, rejects, or refines; they rarely have to originate from a blank page.
- **Resolve dependencies in order.** If decision B depends on A, settle A first. Don't ask about storage before you've agreed what's being stored.
- **Stay in the decision tree.** Each answer opens new branches and closes others. Follow the ones that matter; note (don't chase) the ones that don't.
- **Reach for the environment for facts.** A question whose answer lives in the codebase is a research task, not a grill question — see **Facts vs decisions** above for the branch-currency check before trusting what you find.

Do not act on anything until the user confirms you have reached a shared understanding. Grilling produces alignment; acting on it is a separate step the user must approve.

## When to stop

You're done grilling when the decision tree is resolved — every branch the plan depends on has a settled answer, and the remaining unknowns are execution details, not decisions. At that point, say so explicitly: "I think we've reached shared understanding — here's what I believe we agreed." Let the user correct any last mismatches before any handoff.
