---
name: btw
description: Helps you use the /btw side-conversation workflow effectively. Use when you want to think in parallel, ask side questions without interrupting ongoing work, or inject a side thread back into the main agent.
---

# BTW

Use this skill when the user wants to work in parallel with the main agent instead of derailing the current turn.

## When to use BTW

Prefer the BTW workflow when the user wants to:

- ask a side question while the main agent keeps working
- brainstorm or compare options without interrupting the current run
- prepare a plan or summary before handing it back to the main agent
- keep exploratory discussion out of the main transcript/context

## Commands

```text
/btw <question>
/btw --save <question>
/btw:new [question]
/btw:tangent <question>
/btw:tangent --save <question>
/btw:clear
/btw:model [<provider> <model> <api> | clear]
/btw:thinking [<level> | clear]
/btw:inject [instructions]
/btw:summarize [instructions]
```

## How to guide the user

### Quick side question

Recommend:

```text
/btw <question>
```

### Saved one-off note

```text
/btw --save <question>
```

### Fresh side thread

```text
/btw:new [question]
```

### Contextless tangent

```text
/btw:tangent <question>
```

### Hand full thread back

```text
/btw:inject <instructions>
```

### Hand condensed summary back

```text
/btw:summarize <instructions>
```

### Cheaper/faster BTW model

```text
/btw:model <provider> <model> <api>
/btw:thinking <level>
```

## Recommendation rules

- Prefer `/btw` over normal chat when the user explicitly wants a side conversation.
- Prefer `/btw:tangent` when the user wants that side conversation to be contextless.
- Prefer `/btw:summarize` over `/btw:inject` for long exploratory threads.
- Prefer `/btw:inject` when precise wording, detailed tradeoffs, or a full plan matters.
- Suggest `/btw:model` or `/btw:thinking` when the user wants BTW to be cheaper, faster, or less deliberative than the main thread.

## Response style

When helping the user use BTW: give the exact slash command to run, explain briefly why that command fits, and keep the guidance short and operational.
