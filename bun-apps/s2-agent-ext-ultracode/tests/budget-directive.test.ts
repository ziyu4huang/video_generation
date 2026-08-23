/**
 * Budget directives (cc-parity-2 ticket 05 / map D6): parser edge cases and
 * the session-level holder's set/peek/consume/reset lifecycle.
 */

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  budgetDirectivePrompt,
  consumeBudgetDirective,
  parseBudgetDirective,
  peekBudgetDirective,
  resetBudgetDirective,
  setBudgetDirective,
} from "../src/budget-directive.js";

afterEach(() => {
  resetBudgetDirective();
});

describe("parseBudgetDirective", () => {
  it("parses k/m units, case-insensitively, with decimal amounts", () => {
    assert.equal(parseBudgetDirective("+500k"), 500_000);
    assert.equal(parseBudgetDirective("+1m"), 1_000_000);
    assert.equal(parseBudgetDirective("+1.5m"), 1_500_000);
    assert.equal(parseBudgetDirective("+2K"), 2_000);
    assert.equal(parseBudgetDirective("+0.5k"), 500);
  });

  it("matches inside prose and takes the FIRST match", () => {
    assert.equal(parseBudgetDirective("please audit this +500k workflow"), 500_000);
    assert.equal(parseBudgetDirective("+100k or maybe +1m"), 100_000);
    assert.equal(parseBudgetDirective("do it\n\n+1.5m please"), 1_500_000);
  });

  it("requires the leading + and a word boundary after the unit", () => {
    assert.equal(parseBudgetDirective("500k"), undefined);
    assert.equal(parseBudgetDirective("spend up to 500k tokens"), undefined);
    assert.equal(parseBudgetDirective("+500kx"), undefined);
    assert.equal(parseBudgetDirective("+m"), undefined);
  });

  it("a doubled plus still matches at the second '+' (substring semantics)", () => {
    // `++500k` contains `+500k` at index 1 — first-match-wins finds it. Pinned
    // so a future tightening of the regex is a deliberate change, not drift.
    assert.equal(parseBudgetDirective("++500k"), 500_000);
  });

  it("accepts punctuation right after the unit", () => {
    assert.equal(parseBudgetDirective("(+500k)"), 500_000);
    assert.equal(parseBudgetDirective("+500k."), 500_000);
    assert.equal(parseBudgetDirective("+1m,"), 1_000_000);
  });

  it("rejects zero/negative-valued matches", () => {
    assert.equal(parseBudgetDirective("+0k"), undefined);
    assert.equal(parseBudgetDirective("+0.0001k"), undefined);
  });
});

describe("session directive holder", () => {
  it("set → peek → consume reads-and-clears (one directive binds one run)", () => {
    setBudgetDirective(500_000);
    assert.equal(peekBudgetDirective(), 500_000);
    assert.equal(consumeBudgetDirective(), 500_000);
    assert.equal(peekBudgetDirective(), undefined);
    assert.equal(consumeBudgetDirective(), undefined);
  });

  it("set(undefined) clears a stale directive (armed message without one)", () => {
    setBudgetDirective(500_000);
    setBudgetDirective(undefined);
    assert.equal(peekBudgetDirective(), undefined);
  });

  it("a later directive overwrites an unconsumed earlier one", () => {
    setBudgetDirective(500_000);
    setBudgetDirective(1_000_000);
    assert.equal(consumeBudgetDirective(), 1_000_000);
  });
});

describe("budgetDirectivePrompt", () => {
  it("names the ceiling and states it cannot be lowered", () => {
    const text = budgetDirectivePrompt(500_000);
    assert.match(text, /500,000/);
    assert.match(text, /BINDING run-wide token budget/);
    assert.match(text, /tokenBudget: 500000/);
    assert.match(text, /cannot be lowered/);
  });
});
