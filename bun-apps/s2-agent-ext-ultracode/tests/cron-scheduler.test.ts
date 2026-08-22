/**
 * cron-scheduler.ts — pure 5-field cron math (ticket 08).
 *
 * All expectations are built from LOCAL-time Date constructors (the pi
 * convention: no timezone math anywhere), so the table is TZ-independent by
 * construction — a fixture date built with `new Date(y, m, d, h, min)` and an
 * expected date built the same way agree in any TZ.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { isValidCronExpression, nextFire, parseCronExpression } from "../src/cron-scheduler.js";

/** Local-time helper: parse-cron → nextFire after a local from-date. */
function next(expr: string, from: Date): Date | null {
  return nextFire(parseCronExpression(expr), from);
}

test("cron table: minute/hour/dom/month/dow basics", () => {
  // Every 15 minutes → next quarter-hour strictly after `from`.
  assert.equal(next("*/15 * * * *", new Date(2026, 0, 2, 10, 7))?.getTime(), new Date(2026, 0, 2, 10, 15).getTime());
  // Exactly at a match minute → strictly after (10:15 itself is past).
  assert.equal(next("*/15 * * * *", new Date(2026, 0, 2, 10, 15))?.getTime(), new Date(2026, 0, 2, 10, 30).getTime());
  // Hour rollover from 23:59.
  assert.equal(next("*/15 * * * *", new Date(2026, 0, 2, 23, 59))?.getTime(), new Date(2026, 0, 3, 0, 0).getTime());
  // Single hour:minute daily.
  assert.equal(next("0 9 * * *", new Date(2026, 0, 2, 10, 0))?.getTime(), new Date(2026, 0, 3, 9, 0).getTime());
  // Same day when `from` is before the match.
  assert.equal(next("0 9 * * *", new Date(2026, 0, 2, 8, 0))?.getTime(), new Date(2026, 0, 2, 9, 0).getTime());
  // Range + list: 10:00-10:05 and 10:30.
  assert.equal(next("0,30 10 * * *", new Date(2026, 0, 2, 9, 0))?.getTime(), new Date(2026, 0, 2, 10, 0).getTime());
  assert.equal(next("0,30 10 * * *", new Date(2026, 0, 2, 10, 1))?.getTime(), new Date(2026, 0, 2, 10, 30).getTime());
  // Month field: only February.
  assert.equal(next("0 0 1 2 *", new Date(2026, 4, 1, 0, 0))?.getTime(), new Date(2027, 1, 1, 0, 0).getTime());
});

test("cron table: day-of-week (0 and 7 both Sunday, ranges)", () => {
  // 2026-08-23 is a Sunday (local).
  assert.equal(next("0 12 * * 0", new Date(2026, 7, 23, 0, 0))?.getTime(), new Date(2026, 7, 23, 12, 0).getTime());
  // dow 7 == Sunday too.
  assert.equal(next("0 12 * * 7", new Date(2026, 7, 23, 0, 0))?.getTime(), new Date(2026, 7, 23, 12, 0).getTime());
  // Weekdays 1-5: Friday 2026-08-21 18:00 → Monday 2026-08-24 09:00.
  assert.equal(next("0 9 * * 1-5", new Date(2026, 7, 21, 18, 0))?.getTime(), new Date(2026, 7, 24, 9, 0).getTime());
  // Saturday (6) is excluded by 1-5.
  assert.equal(next("0 9 * * 1-5", new Date(2026, 7, 22, 10, 0))?.getTime(), new Date(2026, 7, 24, 9, 0).getTime());
});

test("cron table: month/DOW OR semantics (Vixie rule)", () => {
  // "0 0 13 * 5" — dom 13 OR any Friday (both restricted). 2026-08-13 is a
  // Thursday but dom 13 matches → fires Aug 13 (dom match wins even though
  // it is not a Friday).
  assert.equal(next("0 0 13 * 5", new Date(2026, 7, 10, 1, 0))?.getTime(), new Date(2026, 7, 13, 0, 0).getTime());
  // After Aug 13 (00:00 past): the dom-13 match is spent, so the next fire is
  // the next FRIDAY (Aug 14 — dow match wins even though dom≠13).
  assert.equal(next("0 0 13 * 5", new Date(2026, 7, 13, 1, 0))?.getTime(), new Date(2026, 7, 14, 0, 0).getTime());
  // Only dom restricted (dow=*): plain AND — dom 13, any weekday.
  assert.equal(next("0 0 13 * *", new Date(2026, 7, 10, 1, 0))?.getTime(), new Date(2026, 7, 13, 0, 0).getTime());
  // Only dow restricted: any dom on Fridays.
  assert.equal(next("0 0 * * 5", new Date(2026, 7, 10, 1, 0))?.getTime(), new Date(2026, 7, 14, 0, 0).getTime());
});

test("cron table: steps within ranges; impossible dates never fire", () => {
  // 20-40/10 minutes → 20, 30, 40.
  assert.equal(next("20-40/10 * * * *", new Date(2026, 0, 2, 5, 0))?.getTime(), new Date(2026, 0, 2, 5, 20).getTime());
  assert.equal(next("20-40/10 * * * *", new Date(2026, 0, 2, 5, 21))?.getTime(), new Date(2026, 0, 2, 5, 30).getTime());
  // Feb 30 does not exist → null within the search bound.
  assert.equal(next("0 0 30 2 *", new Date(2026, 0, 1, 0, 0)), null);
  // Feb 29 fires only in a leap year (2028).
  assert.equal(next("0 0 29 2 *", new Date(2026, 0, 1, 0, 0))?.getTime(), new Date(2028, 1, 29, 0, 0).getTime());
});

test("parse: rejects wrong field count, ranges, and out-of-range values", () => {
  assert.equal(isValidCronExpression("* * * * *"), true);
  assert.equal(isValidCronExpression("*/15 * * * *"), true);
  assert.throws(() => parseCronExpression("* * * *"), /expected 5 fields/);
  assert.throws(() => parseCronExpression("60 * * * *"), /out of range/);
  assert.throws(() => parseCronExpression("* 24 * * *"), /out of range/);
  assert.throws(() => parseCronExpression("* * 0 * *"), /out of range/);
  assert.throws(() => parseCronExpression("* * * 13 *"), /out of range/);
  assert.throws(() => parseCronExpression("* * * * 8"), /out of range/);
  assert.throws(() => parseCronExpression("5-1 * * * *"), /reversed/);
  assert.throws(() => parseCronExpression("a * * * *"), /invalid minute/);
  assert.throws(() => parseCronExpression("*/0 * * * *"), /step/);
  // Step on a single value is rejected (Vixie rejects it too) — a step needs
  // a span: `*` or an a-b range.
  assert.throws(() => parseCronExpression("5/2 * * * *"), /step needs a range/);
  assert.equal(isValidCronExpression("5-40/10 * * * *"), true);
  assert.throws(() => parseCronExpression(""), /non-empty/);
});

test("parse: dow 7 normalizes to Sunday 0 in the field set", () => {
  const fields = parseCronExpression("0 0 * * 7");
  assert.deepEqual(fields.dow, [0]);
  assert.equal(fields.dowRestricted, true);
  const star = parseCronExpression("0 0 * * *");
  assert.equal(star.domRestricted, false);
  assert.equal(star.dowRestricted, false);
});
