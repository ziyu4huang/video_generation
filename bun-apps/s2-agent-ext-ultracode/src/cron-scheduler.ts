/**
 * Pure 5-field cron math for the workflow cron scheduler (ticket 08).
 *
 * Standard Vixie semantics, evaluated in LOCAL time only (pi convention — no
 * timezone math anywhere): `minute hour day-of-month month day-of-week` with
 * `*`, single values, ranges `a-b`, steps (star over n and `a-b/n`), and comma lists.
 * When BOTH day-of-month and day-of-week are restricted, a day matches if
 * EITHER matches (the classic cron OR rule); otherwise both must match.
 *
 * Pure by design — no fs, no clock. Callers pass `from` dates explicitly so
 * the cron table test pins math without sleeping or faking timers.
 */

/** Field ranges; dow is normalized so 0 and 7 are both Sunday (stored as 0). */
const FIELD_RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 7 },
} as const;

export type CronField = keyof typeof FIELD_RANGES;

/** Upper bound for next-fire search. 4 years + 1 day covers a Feb-29 cycle
 *  (the longest legitimate gap); anything beyond is "never fires" (e.g. Feb 30). */
const SEARCH_BOUND_DAYS = 4 * 366 + 1;

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** True when the dom field is NOT `*` (restricted) — feeds the dom/dow OR rule. */
  domRestricted: boolean;
  /** True when the dow field is NOT `*` (restricted) — feeds the dom/dow OR rule. */
  dowRestricted: boolean;
}

/** Parse one comma-separated field body (`a-b/n`, star-over-n steps, `a`, `a-b`) into sorted values. */
function parseField(field: CronField, body: string): number[] {
  const { min, max } = FIELD_RANGES[field];
  const values = new Set<number>();
  for (const part of body.split(",")) {
    if (!part) throw new Error(`cron: empty part in ${field} field ("${body}")`);
    const stepMatch = part.match(/^(.+?)\/(\d+)$/);
    let range = part;
    let step = 1;
    if (stepMatch?.[1] && stepMatch[2]) {
      range = stepMatch[1];
      step = Number.parseInt(stepMatch[2], 10);
      if (step < 1) throw new Error(`cron: step must be >= 1 in ${field} field ("${part}")`);
      // `5/2` (step on a single value) is rejected: Vixie rejects it too, and
      // silently reading it as just {5} (or expanding 5,7,9,… like croniter)
      // would be a third meaning. A step needs a span: `*` or an a-b range.
      if (range !== "*" && !range.includes("-")) {
        throw new Error(`cron: step needs a range in ${field} field ("${part}") — use "*/${step}" or "a-b/${step}"`);
      }
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const bounds = range.match(/^(\d+)(?:-(\d+))?$/);
      if (!bounds?.[1]) throw new Error(`cron: invalid ${field} value "${range}"`);
      lo = Number.parseInt(bounds[1], 10);
      hi = bounds[2] ? Number.parseInt(bounds[2], 10) : lo;
      if (lo < min || hi > max || lo > hi) {
        throw new Error(`cron: ${field} value out of range (${min}-${max}) or reversed: "${range}"`);
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  // Normalize Sunday: dow 7 → 0 so matching sees one canonical Sunday.
  if (field === "dow") {
    if (values.has(7)) {
      values.delete(7);
      values.add(0);
    }
  }
  return [...values].sort((a, b) => a - b);
}

/** Parse a 5-field cron expression. Throws on invalid syntax or out-of-range values. */
export function parseCronExpression(expr: string): CronFields {
  if (typeof expr !== "string" || !expr.trim()) throw new Error("cron: expression must be a non-empty string");
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields (minute hour dom month dow), got ${parts.length}: "${expr}"`);
  }
  // Length checked above — a 5-tuple cast is exact, not an assertion of faith.
  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts as [string, string, string, string, string];
  return {
    minute: parseField("minute", minuteStr),
    hour: parseField("hour", hourStr),
    dom: parseField("dom", domStr),
    month: parseField("month", monthStr),
    dow: parseField("dow", dowStr),
    domRestricted: domStr !== "*",
    dowRestricted: dowStr !== "*",
  };
}

/** Does a plain cron expression validate? (Boolean wrapper for tool input checks.) */
export function isValidCronExpression(expr: string): boolean {
  try {
    parseCronExpression(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(fields: CronFields, year: number, month: number, dom: number): boolean {
  // month is 0-based in Date; cron month is 1-based.
  if (!fields.month.includes(month + 1)) return false;
  const domOk = fields.dom.includes(dom);
  // JS getDay(): 0=Sunday … 6=Saturday — same numbering as normalized cron dow.
  const dow = new Date(year, month, dom).getDay();
  const dowOk = fields.dow.includes(dow);
  // Vixie OR rule: both restricted → either matches; otherwise → both must match.
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * The next fire STRICTLY AFTER `from`'s minute (a fire at `from` itself already
 * happened by definition), truncated to the minute, or null when no fire occurs
 * within the search bound (permanently impossible dates like "0 0 31 2 *").
 */
export function nextFire(fields: CronFields, from: Date): Date | null {
  let year = from.getFullYear();
  let month = from.getMonth();
  let day = from.getDate();
  // Exclusive start, in minutes since midnight of `from`'s day: 23:59 → 1440
  // (rolls to the next day naturally — the hour loop below just doesn't run).
  const fromTotal = from.getHours() * 60 + from.getMinutes() + 1;
  const startHour = Math.floor(fromTotal / 60);
  const startMinute = fromTotal % 60;

  for (let d = 0; d <= SEARCH_BOUND_DAYS; d++) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    if (day > daysInMonth) {
      // Walked past the end of the month — advance to the 1st of the next month.
      day = 1;
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    if (!dayMatches(fields, year, month, day)) {
      day += 1;
      continue;
    }
    // Find the first matching hour:minute at/after the carry point on this day
    // (the carry applies only to `from`'s own day — later days start at 00:00).
    const hourStart = d === 0 ? startHour : 0;
    const minuteStart = d === 0 ? startMinute : 0;
    for (let h = hourStart; h <= 23; h++) {
      for (let m = h === hourStart ? minuteStart : 0; m <= 59; m++) {
        if (fields.hour.includes(h) && fields.minute.includes(m)) {
          return new Date(year, month, day, h, m, 0, 0);
        }
      }
    }
    day += 1;
  }
  return null;
}
