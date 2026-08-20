import { describe, it } from "bun:test";
import assert from "node:assert";
import {
  computeHeat,
  resolveDecayConfig,
  type HeatInput,
  type DecayConfig,
} from "../../src/store/heat.js";
import {
  DEFAULT_DECAY_HALFLIFE_DAYS,
  DEFAULT_DECAY_WORTH_WEIGHT,
  DEFAULT_DECAY_USED_BONUS,
} from "../../src/constants.js";

// Fixed "now" anchor for all date math — deterministic, TZ-stable (full ISO
// timestamps avoid date-only UTC/local ambiguity). 2024-06-15T12:00:00Z.
const NOW = new Date("2024-06-15T12:00:00Z");

// The canonical default config (mirrors DEFAULT_DECAY_* in constants.ts).
const DEFAULT_CFG: DecayConfig = resolveDecayConfig({});

// A neutral baseline entry: age 0, laplace 0.5 (worthMult 1), never used.
function neutralInput(overrides: Partial<HeatInput> = {}): HeatInput {
  return {
    lastReferenced: "2024-06-15T12:00:00Z", // age 0
    created: "2024-06-15T12:00:00Z",
    mwSuccess: 0,
    mwFail: 0, // laplace = 1/2 = 0.5 → worthMult = 1
    usedExists: false,
    now: NOW,
    ...overrides,
  };
}

const EPS = 1e-9;

describe("computeHeat — recency spine (exp(-age/halflife))", () => {
  it("age 0 → recencySpine 1 → heat 1 (neutral worthMult, no used bonus)", () => {
    const heat = computeHeat(neutralInput(), DEFAULT_CFG);
    assert.ok(Math.abs(heat - 1) < EPS, `age-0 neutral heat should be 1.0, got ${heat}`);
  });

  it("future lastReferenced (negative pre-clamp age) → age clamped to 0 → heat 1 (max(0,…) guard)", () => {
    // A future date would yield a negative age → recencySpine > 1 without the
    // Math.max(0, …) guard. Assert it clamps to age 0 (heat 1, neutral).
    const future = new Date(NOW.getTime() + 86_400_000).toISOString(); // +1 day
    const heat = computeHeat(neutralInput({ lastReferenced: future }), DEFAULT_CFG);
    assert.ok(Math.abs(heat - 1) < EPS, `future-date heat should be 1.0 (age clamped), got ${heat}`);
  });

  it("age = halflife → recencySpine ≈ exp(-1) ≈ 0.368", () => {
    // age exactly one halflife (default 14 days): spine = e^-1
    const age = DEFAULT_DECAY_HALFLIFE_DAYS; // 14
    const lastReferenced = new Date(NOW.getTime() - age * 86_400_000).toISOString();
    const heat = computeHeat(neutralInput({ lastReferenced }), DEFAULT_CFG);
    assert.ok(
      Math.abs(heat - Math.exp(-1)) < EPS,
      `heat at one halflife should be e^-1 (${Math.exp(-1)}), got ${heat}`,
    );
  });

  it("large age → recencySpine → 0 (heat ≈ 0, no used bonus)", () => {
    // 1000 days old → exp(-1000/14) ≈ 1e-31, effectively 0
    const lastReferenced = new Date(NOW.getTime() - 1000 * 86_400_000).toISOString();
    const heat = computeHeat(neutralInput({ lastReferenced }), DEFAULT_CFG);
    assert.ok(heat < 1e-10, `huge-age heat should be ≈0, got ${heat}`);
  });

  it("recencySpine is monotonically decreasing as age grows", () => {
    const ages = [0, 1, 3, 7, 14, 30, 60, 90];
    const heats = ages.map((days) => {
      const lastReferenced = new Date(NOW.getTime() - days * 86_400_000).toISOString();
      return computeHeat(neutralInput({ lastReferenced }), DEFAULT_CFG);
    });
    for (let i = 1; i < heats.length; i++) {
      assert.ok(
        heats[i] < heats[i - 1],
        `heat not monotonic decreasing: age ${ages[i - 1]}→${ages[i]}: ${heats[i - 1]} → ${heats[i]}`,
      );
    }
  });
});

describe("computeHeat — worth multiplier (1 + worthWeight*(laplace - 0.5))", () => {
  it("laplace > 0.5 (mwSuccess ≫ mwFail) → worthMult > 1 → higher heat than neutral", () => {
    const base = computeHeat(
      neutralInput({ lastReferenced: new Date(NOW.getTime() - 7 * 86_400_000).toISOString() }),
      DEFAULT_CFG,
    );
    const highWorth = computeHeat(
      neutralInput({
        lastReferenced: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
        mwSuccess: 100,
        mwFail: 0,
      }),
      DEFAULT_CFG,
    );
    assert.ok(highWorth > base, `high-worth should beat neutral at same age (${highWorth} > ${base})`);
    // laplace = 101/102 ≈ 0.9902 → worthMult = 1 + 0.15*(0.4902) ≈ 1.0735 > 1
    const laplace = 101 / 102;
    const expectedMult = 1 + DEFAULT_DECAY_WORTH_WEIGHT * (laplace - 0.5);
    assert.ok(expectedMult > 1, "sanity: expected worthMult > 1");
  });

  it("laplace < 0.5 (mwSuccess ≪ mwFail) → worthMult < 1 → lower heat than neutral", () => {
    const base = computeHeat(
      neutralInput({ lastReferenced: new Date(NOW.getTime() - 7 * 86_400_000).toISOString() }),
      DEFAULT_CFG,
    );
    const lowWorth = computeHeat(
      neutralInput({
        lastReferenced: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
        mwSuccess: 0,
        mwFail: 100,
      }),
      DEFAULT_CFG,
    );
    assert.ok(lowWorth < base, `low-worth should lose to neutral at same age (${lowWorth} < ${base})`);
    // laplace = 1/102 ≈ 0.0098 → worthMult = 1 + 0.15*(-0.4902) ≈ 0.9265 < 1
    const laplace = 1 / 102;
    const expectedMult = 1 + DEFAULT_DECAY_WORTH_WEIGHT * (laplace - 0.5);
    assert.ok(expectedMult < 1, "sanity: expected worthMult < 1");
  });

  it("laplace == 0.5 (equal counts OR both zero) → worthMult == 1 (neutral)", () => {
    // both zero
    const bothZero = computeHeat(neutralInput({ mwSuccess: 0, mwFail: 0 }), DEFAULT_CFG);
    assert.ok(Math.abs(bothZero - 1) < EPS, `both-zero (age 0) → heat 1.0, got ${bothZero}`);
    // equal non-zero
    const equal = computeHeat(neutralInput({ mwSuccess: 50, mwFail: 50 }), DEFAULT_CFG);
    assert.ok(Math.abs(equal - 1) < EPS, `equal counts (age 0) → heat 1.0, got ${equal}`);
  });

  it("worthMult formula matches the spec exactly at a known laplace", () => {
    // mwSuccess 9, mwFail 1 → laplace = 10/12 = 0.8333. Use a mid-range age
    // (recencySpine 0.5) so the product stays UNDER the clamp cap and the raw
    // worthMult is observable (age 0 would clamp 1.05 → 1.0 and hide it).
    const age = 14 * Math.log(2); // exp(-age/14) = 0.5
    const lastReferenced = new Date(NOW.getTime() - age * 86_400_000).toISOString();
    const heat = computeHeat(neutralInput({ lastReferenced, mwSuccess: 9, mwFail: 1 }), DEFAULT_CFG);
    const laplace = 10 / 12;
    const expected = 0.5 * (1 + DEFAULT_DECAY_WORTH_WEIGHT * (laplace - 0.5));
    assert.ok(Math.abs(heat - expected) < EPS, `heat ${heat} vs expected ${expected}`);
  });
});

describe("computeHeat — used bonus", () => {
  it("usedExists: true adds exactly cfg.usedBonus (at a mid-range age so it stays under the cap)", () => {
    // Pick an age where recencySpine ≈ 0.5 so 0.5 + 0.1 = 0.6 (unclamped, observable).
    // age where exp(-age/14) = 0.5 → age = 14*ln2 ≈ 9.704.
    const age = 14 * Math.log(2);
    const lastReferenced = new Date(NOW.getTime() - age * 86_400_000).toISOString();
    const unused = computeHeat(neutralInput({ lastReferenced, usedExists: false }), DEFAULT_CFG);
    const used = computeHeat(neutralInput({ lastReferenced, usedExists: true }), DEFAULT_CFG);
    assert.ok(Math.abs(used - unused - DEFAULT_DECAY_USED_BONUS) < EPS,
      `used bonus should be exactly ${DEFAULT_DECAY_USED_BONUS}, got ${used - unused}`);
  });

  it("usedExists: false adds exactly 0 (heat equals recencySpine*worthMult)", () => {
    const age = 14 * Math.log(2);
    const lastReferenced = new Date(NOW.getTime() - age * 86_400_000).toISOString();
    const heat = computeHeat(neutralInput({ lastReferenced, usedExists: false }), DEFAULT_CFG);
    assert.ok(Math.abs(heat - 0.5) < EPS, `unused mid-age heat should be 0.5, got ${heat}`);
  });
});

describe("computeHeat — clamp [0, 1]", () => {
  it("cap: age 0, laplace 1, used true → raw > 1 → clamped to exactly 1", () => {
    // raw = recencySpine(1) * worthMult(1+0.15*0.5=1.075) + usedBonus(0.1) = 1.175 → clamp 1
    const heat = computeHeat(
      neutralInput({ mwSuccess: 1_000_000, mwFail: 0, usedExists: true }),
      DEFAULT_CFG,
    );
    assert.strictEqual(heat, 1, `capped heat should be exactly 1, got ${heat}`);
  });

  it("floor: a config producing a negative raw value clamps to exactly 0", () => {
    // worthWeight large enough to make worthMult negative at laplace 0:
    // worthMult = 1 + W*(-0.5); with W=3 → -0.5. age 0 → recencySpine 1, used false.
    // raw = 1 * -0.5 + 0 = -0.5 → clamp 0.
    const cfg: DecayConfig = { halflifeDays: 14, worthWeight: 3, usedBonus: 0.1 };
    const heat = computeHeat(neutralInput({ mwSuccess: 0, mwFail: 1_000_000 }), cfg);
    assert.strictEqual(heat, 0, `negative-raw heat should clamp to exactly 0, got ${heat}`);
  });

  it("output is always within [0, 1] across a sweep of inputs", () => {
    for (const mwSuccess of [0, 1, 10, 1000]) {
      for (const mwFail of [0, 1, 10, 1000]) {
        for (const used of [false, true]) {
          for (const ageDays of [0, 1, 7, 14, 100]) {
            const lastReferenced = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
            const heat = computeHeat(
              neutralInput({ mwSuccess, mwFail, usedExists: used, lastReferenced }),
              DEFAULT_CFG,
            );
            assert.ok(heat >= 0 && heat <= 1, `heat out of [0,1]: ${heat} (s/${mwSuccess} f/${mwFail} u/${used} a/${ageDays})`);
          }
        }
      }
    }
  });
});

describe("computeHeat — missing-dates fallback chain (last → created → epoch)", () => {
  it("lastReferenced present → used (created ignored even if older)", () => {
    const heatLastRecent = computeHeat(
      neutralInput({
        lastReferenced: "2024-06-15T12:00:00Z", // today → age 0 → heat 1
        created: "2000-01-01T00:00:00Z",          // ancient, must be ignored
      }),
      DEFAULT_CFG,
    );
    assert.ok(Math.abs(heatLastRecent - 1) < EPS, `lastReferenced should win, got ${heatLastRecent}`);
  });

  it("lastReferenced absent, created present → created is used", () => {
    // created today → age 0 → heat 1
    const heat = computeHeat(
      neutralInput({ lastReferenced: undefined, created: "2024-06-15T12:00:00Z" }),
      DEFAULT_CFG,
    );
    assert.ok(Math.abs(heat - 1) < EPS, `created fallback should give age-0 heat 1, got ${heat}`);
    // created ancient → heat ≈ 0
    const heatOld = computeHeat(
      neutralInput({ lastReferenced: undefined, created: "2000-01-01T00:00:00Z" }),
      DEFAULT_CFG,
    );
    assert.ok(heatOld < 1e-10, `ancient created → heat ≈ 0, got ${heatOld}`);
  });

  it("both absent → epoch (1970) → age huge → heat ≈ 0", () => {
    const heat = computeHeat(
      neutralInput({ lastReferenced: undefined, created: undefined }),
      DEFAULT_CFG,
    );
    assert.ok(heat < 1e-50, `both-absent (epoch) → heat ≈ 0, got ${heat}`);
  });

  it("tolerates both date-only (YYYY-MM-DD) and full ISO strings", () => {
    // date-only: must parse (no throw). Use created = today date-only.
    const todayDateOnly = NOW.toISOString().slice(0, 10); // "2024-06-15"
    const heatDateOnly = computeHeat(
      neutralInput({ lastReferenced: undefined, created: todayDateOnly }),
      DEFAULT_CFG,
    );
    // date-only parses as UTC midnight; now is 12:00Z same day → age 0.5 day → spine ≈ exp(-0.5/14) ≈ 0.965
    assert.ok(heatDateOnly > 0.95 && heatDateOnly <= 1, `date-only parsed heat in range, got ${heatDateOnly}`);
    // full ISO still works (covered elsewhere) — assert no NaN
    const heatIso = computeHeat(
      neutralInput({ lastReferenced: "2024-06-15T12:00:00Z" }),
      DEFAULT_CFG,
    );
    assert.ok(!Number.isNaN(heatIso), "ISO parse must not yield NaN");
  });

  it("invalid date string → treated as epoch → heat ≈ 0", () => {
    const heat = computeHeat(
      neutralInput({ lastReferenced: "not-a-date", created: undefined }),
      DEFAULT_CFG,
    );
    assert.ok(heat < 1e-50, `invalid lastReferenced → epoch → heat ≈ 0, got ${heat}`);
  });
});

describe("computeHeat — config knobs honored", () => {
  it("larger halflife → slower decay → higher heat at the same age", () => {
    const ageDays = 14;
    const lastReferenced = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
    const shortHl = computeHeat(neutralInput({ lastReferenced }), { halflifeDays: 14, worthWeight: 0.15, usedBonus: 0.1 });
    const longHl = computeHeat(neutralInput({ lastReferenced }), { halflifeDays: 28, worthWeight: 0.15, usedBonus: 0.1 });
    assert.ok(longHl > shortHl, `longer halflife should decay slower (${longHl} > ${shortHl})`);
    // at age 14: halflife 14 → exp(-1); halflife 28 → exp(-0.5)
    assert.ok(Math.abs(shortHl - Math.exp(-1)) < EPS);
    assert.ok(Math.abs(longHl - Math.exp(-0.5)) < EPS);
  });

  it("larger worthWeight → wider spread between high/low worth", () => {
    const ageDays = 7;
    const lastReferenced = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
    const lowCfg = { halflifeDays: 14, worthWeight: 0.05, usedBonus: 0.1 };
    const highCfg = { halflifeDays: 14, worthWeight: 0.5, usedBonus: 0.1 };
    const spreadLow = computeHeat(neutralInput({ lastReferenced, mwSuccess: 100, mwFail: 0 }), lowCfg)
      - computeHeat(neutralInput({ lastReferenced, mwSuccess: 0, mwFail: 100 }), lowCfg);
    const spreadHigh = computeHeat(neutralInput({ lastReferenced, mwSuccess: 100, mwFail: 0 }), highCfg)
      - computeHeat(neutralInput({ lastReferenced, mwSuccess: 0, mwFail: 100 }), highCfg);
    assert.ok(spreadHigh > spreadLow, `larger worthWeight → wider spread (${spreadHigh} > ${spreadLow})`);
  });

  it("larger usedBonus → bigger used-vs-unused gap", () => {
    const ageDays = 7;
    const lastReferenced = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
    const smallBonus = { halflifeDays: 14, worthWeight: 0.15, usedBonus: 0.02 };
    const bigBonus = { halflifeDays: 14, worthWeight: 0.15, usedBonus: 0.3 };
    const gapSmall = computeHeat(neutralInput({ lastReferenced, usedExists: true }), smallBonus)
      - computeHeat(neutralInput({ lastReferenced, usedExists: false }), smallBonus);
    const gapBig = computeHeat(neutralInput({ lastReferenced, usedExists: true }), bigBonus)
      - computeHeat(neutralInput({ lastReferenced, usedExists: false }), bigBonus);
    assert.ok(gapBig > gapSmall, `larger usedBonus → bigger gap (${gapBig} > ${gapSmall})`);
    assert.ok(Math.abs(gapSmall - 0.02) < EPS);
    assert.ok(Math.abs(gapBig - 0.3) < EPS);
  });
});

describe("resolveDecayConfig", () => {
  it("returns the DEFAULT_DECAY_* defaults when all fields are absent", () => {
    const cfg = resolveDecayConfig({});
    assert.strictEqual(cfg.halflifeDays, DEFAULT_DECAY_HALFLIFE_DAYS);
    assert.strictEqual(cfg.worthWeight, DEFAULT_DECAY_WORTH_WEIGHT);
    assert.strictEqual(cfg.usedBonus, DEFAULT_DECAY_USED_BONUS);
  });

  it("respects provided values", () => {
    const cfg = resolveDecayConfig({ decayHalflifeDays: 30, decayWorthWeight: 0.2, decayUsedBonus: 0.05 });
    assert.strictEqual(cfg.halflifeDays, 30);
    assert.strictEqual(cfg.worthWeight, 0.2);
    assert.strictEqual(cfg.usedBonus, 0.05);
  });

  it("fills missing individual fields with their respective defaults", () => {
    const cfg = resolveDecayConfig({ decayHalflifeDays: 21 });
    assert.strictEqual(cfg.halflifeDays, 21);
    assert.strictEqual(cfg.worthWeight, DEFAULT_DECAY_WORTH_WEIGHT);
    assert.strictEqual(cfg.usedBonus, DEFAULT_DECAY_USED_BONUS);
  });
});
