---
name: test-driven-development
description: Use when implementing any feature, fixing any bug, refactoring, or changing behavior — before writing any implementation code. Enforces the red-green-refactor cycle (write a failing test, watch it fail for the right reason, write minimal code to pass, refactor with tests green). No production code without a failing test; code-first-then-test must be deleted and restarted.
---

# Test-Driven Development (TDD)

## Overview

Write the test first. Watch it fail. Write the least code that makes it pass.

**Core principle: if you haven't seen the test fail, you don't know whether it tests
the right thing.**

> **Position in the chain:** this is the foundation the `writing-plans` step structure
> and `systematic-debugging`'s "failing test first" both assume. writing-plans uses TDD
> steps inside each task; this skill teaches the cycle itself. Verify every "green"
> with `verification-before-completion`.

Violating the letter of this rule violates its spirit.

## When to use

**Always:**
- new features
- bug fixes
- refactors
- behavior changes

**Exceptions (ask your partner first):**
- one-off prototypes
- generated code
- config files

Thinking "skip TDD just this once"? Stop. That's rationalizing.

## The Iron Rule

```
No production code without a failing test.
```

Wrote code first, then the test? Delete it. Start over.

**No exceptions:**
- don't keep it "as reference"
- don't "adapt" it while writing the test
- don't look at it
- delete means delete

Re-implement from the test. Period.

## Red-Green-Refactor

### Red — write the failing test

Write a minimal test showing the expected behavior.

```typescript
import { test, expect } from "bun:test";

test("retries failed operations 3 times", async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error("fail");
    return "success";
  };

  const result = await retryOperation(operation);

  expect(result).toBe("success");
  expect(attempts).toBe(3);
});
```

Clear name, tests real behavior, tests one thing. Use real code, not mocks, unless
unavoidable.

### Verify red — watch it fail

**Mandatory. Never skip.**

```bash
bun test path/to/file.test.ts
```

Confirm:
- the test FAILS (not errors out)
- the failure message matches expectations
- the failure cause is the missing feature (not a typo)

**Test passed?** You're testing existing behavior. Change the test.
**Test errored?** Fix the error, re-run until it fails correctly.

### Green — minimal code

Write the simplest code that passes.

```typescript
async function retryOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  throw new Error("unreachable");
}
```

Just enough to pass. Don't add features, refactor unrelated code, or make
"improvements" beyond what the test requires. YAGNI.

### Verify green — watch it pass

**Mandatory.**

```bash
bun test path/to/file.test.ts
```

Confirm:
- the test passes
- other tests still pass
- output is clean (no errors, no warnings)

**Test failed?** Fix the code, not the test.
**Other tests failed?** Fix immediately.

### Refactor — clean up

Only after green:
- eliminate duplication
- improve naming
- extract helpers

Keep tests green. Don't add behavior.

### Repeat

Write the next failing test for the next feature.

## What makes a good test

| Trait | Good | Bad |
|-------|------|-----|
| **minimal** | tests one thing. Name has "and"? split it | `test("validates email and domain and whitespace")` |
| **clear** | name describes behavior | `test("test1")` |
| **intent-revealing** | shows the expected API | hides what the code should do |

## Why order matters

**"I'll finish the code, then add tests to verify."** — a test written after passes
immediately. An immediately-passing test proves nothing: it may test the wrong thing,
test the implementation rather than the behavior, miss edge cases you forgot, and you
never saw it catch a bug. Writing the test first forces you to see it fail, proving it
tests something real.

**"I already manually tested all edge cases."** — manual testing is ad hoc. No record,
can't re-run after changes, easily forgotten under pressure. "I tried it and it works"
is not coverage. Automated tests are systematic — they run the same way every time.

**"Deleting X hours of work is a waste."** — sunk-cost fallacy. The time is already
spent. Your choice now: delete and redo with TDD (X more hours, high confidence) vs.
keep and backfill tests (30 min, low confidence, possible bugs). The "waste" is keeping
code you can't trust. Runnable code without real tests is tech debt.

**"Backfilling tests achieves the same thing — it's the spirit not the ritual."** — No.
A backfilled test answers "what does this code do?". A test-first answers "what should
this code do?". Backfilled tests are biased by your implementation — you test what you
built, not what the requirement asked for; you verify edge cases you remember, not the
ones you'd discover. Test-first forces you to find edge cases before implementing.
30 minutes of backfilling ≠ TDD. You get coverage but lose proof of validity.

## Common excuses

| Excuse | Reality |
|--------|---------|
| "too simple to test" | simple code still has bugs; a test takes 30 seconds |
| "I'll add tests later" | an immediately-passing test proves nothing |
| "backfilling works just as well" | backfill = "what does this do?"; test-first = "what should this do?" |
| "already manually tested" | ad hoc ≠ systematic; no record, not reproducible |
| "deleting X hours is a waste" | sunk-cost fallacy; unverified code is tech debt |
| "keep as reference, then test-first" | you'll adapt it; that's backfilling; delete means delete |
| "need to explore first" | fine — explore, then throw it away and start TDD |
| "the test is hard to write = unclear design" | listen to the test; hard to test = hard to use |
| "TDD slows me down" | TDD is faster than debugging; pragmatic = test-first |
| "manual testing is faster" | manual can't prove edge cases; you re-test every change |
| "the existing code has no tests" | you're improving it; add tests for existing code too |

## Red lines — stop and start over

You're rationalizing if you catch yourself:

- wrote code before the test
- backfilled tests after implementing
- the test passed immediately
- can't explain why the test failed
- "add tests later"
- convincing yourself "just this once"
- "I already manually tested"
- "backfilling achieves the same thing"
- "it's the spirit not the ritual"
- "keep as reference" or "adapt the existing code"
- "already spent X hours, deleting is a waste"
- "TDD is too dogmatic, I'm being pragmatic"
- "this case is different, because…"

**All of these mean: delete the code. Restart with TDD.**

## Example: bug fix

**Bug:** empty email is accepted.

**Red**
```typescript
test("rejects empty email", async () => {
  const result = await submitForm({ email: "" });
  expect(result.error).toBe("Email required");
});
```

**Verify red**
```bash
$ bun test
FAIL: expected 'Email required', got undefined
```

**Green**
```typescript
function submitForm(data: FormData) {
  if (!data.email?.trim()) {
    return { error: "Email required" };
  }
  // ...
}
```

**Verify green**
```bash
$ bun test
PASS
```

**Refactor** — if useful, extract validation so it serves multiple fields.

## Verification checklist (before marking done)

- [ ] every new function/method has a test
- [ ] saw each test fail before implementing
- [ ] each test fails for the right reason (missing feature, not a typo)
- [ ] wrote minimal code per test to pass
- [ ] all tests pass
- [ ] output clean (no errors, no warnings)
- [ ] tests use real code (mocks only when unavoidable)
- [ ] edge cases and error paths covered

Can't check them all? You skipped TDD. Start over.

## When stuck

| Problem | Solution |
|---------|----------|
| don't know how to test | write the API you expect; write the assertion first; ask your partner |
| test is too complex | the design is too complex; simplify the interface |
| have to mock everything | code is too tightly coupled; use dependency injection |
| test setup is huge | extract helpers; still complex? simplify the design |

## Debugging integration

Found a bug? Write a failing test that reproduces it. Run the TDD cycle. The test both
proves the fix works and prevents regression. (See `systematic-debugging` Phase 4.)

**Never fix a bug without a test.**

## Final rule

```
production code → a test exists AND failed first
otherwise       → it's not TDD
```

No exceptions without your partner's explicit permission.
