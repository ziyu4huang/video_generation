import { describe, expect, it } from "bun:test";
import { resolveWayfindEffortId } from "../src/commands.js";
import { effortSlug } from "../src/wayfinder.js";

// resolveWayfindEffortId mirrors the /wayfind dispatcher's parsing so the banner
// effort always matches the effort the subcommand operates on. These cases pin
// every parse branch: chart path, keyword subcommand (explicit + active
// fallback), force-chart `--` (with + without a destination), and bare no-arg
// (no active → undefined → no banner; active → banner).

describe("resolveWayfindEffortId (wayfind effort-id banner)", () => {
  it("chart path: a bare destination slugifies (no active effort needed)", () => {
    expect(resolveWayfindEffortId("pi agent ext webui", () => undefined)).toBe(effortSlug("pi agent ext webui"));
  });

  it("keyword subcommand with an explicit effort arg wins over the active one", () => {
    expect(resolveWayfindEffortId("status 2026-08-10-foo", () => "2026-08-10-bar")).toBe("2026-08-10-foo");
  });

  it("keyword subcommand with no arg falls back to the active effort", () => {
    expect(resolveWayfindEffortId("seed", () => "2026-08-10-active")).toBe("2026-08-10-active");
  });

  it("force-chart `--` slugifies the destination after the dashes", () => {
    expect(resolveWayfindEffortId("-- sync the database", () => undefined)).toBe(effortSlug("sync the database"));
  });

  it("force-chart `--` with nothing after falls back to the active effort", () => {
    expect(resolveWayfindEffortId("--", () => "2026-08-10-active")).toBe("2026-08-10-active");
  });

  it("bare `/wayfind` with no active effort returns undefined (no banner)", () => {
    expect(resolveWayfindEffortId("", () => undefined)).toBeUndefined();
  });

  it("bare `/wayfind` with an active effort returns that effort", () => {
    expect(resolveWayfindEffortId("", () => "2026-08-10-active")).toBe("2026-08-10-active");
  });

  it("help/usage parse as subcommands (active fallback), never as a chart slug", () => {
    expect(resolveWayfindEffortId("help", () => "2026-08-10-active")).toBe("2026-08-10-active");
    expect(resolveWayfindEffortId("usage", () => undefined)).toBeUndefined();
  });
});
