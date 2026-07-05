import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preComposeGate, type RemotionEditDecisions } from "./precompose-gate.ts";

describe("preComposeGate — delivery promise", () => {
  it("fails when there are no cuts", () => {
    const r = preComposeGate({ version: "1.0", cuts: [] });
    expect(r.verdict).toBe("fail");
    expect(r.checks[0]!.name).toBe("cuts_present");
    expect(r.checks[0]!.status).toBe("fail");
  });

  it("fails when total duration is 0", () => {
    const r = preComposeGate({ version: "1.0", cuts: [{ id: "a", source: "/x.png", in_seconds: 0, out_seconds: 0, animation: "ken-burns" }] });
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.name === "total_duration_positive")!.status).toBe("fail");
  });
});

describe("preComposeGate — slideshow risk", () => {
  it("passes (no slideshow warning) when image cuts have motion", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-motion-"));
    try {
      const a = join(dir, "a.png"); writeFileSync(a, "x");
      const b = join(dir, "b.png"); writeFileSync(b, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: a, in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
          { id: "b", source: b, in_seconds: 2, out_seconds: 4, animation: "zoom-in" },
        ],
        transition: "crossfade",
      };
      const r = preComposeGate(edit);
      expect(r.checks.find((c) => c.name === "slideshow_risk")!.status).toBe("pass");
      // No delivery-promise fails → verdict pass (sources exist, audio is only a warn here).
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when most image cuts are static (slideshow risk)", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-static-"));
    try {
      const mk = (n: string) => { const p = join(dir, n); writeFileSync(p, "x"); return p; };
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: mk("a.png"), in_seconds: 0, out_seconds: 2 },                       // static
          { id: "b", source: mk("b.png"), in_seconds: 2, out_seconds: 4 },                       // static
          { id: "c", source: mk("c.png"), in_seconds: 4, out_seconds: 6 },                       // static
          { id: "d", source: mk("d.png"), in_seconds: 6, out_seconds: 8, animation: "zoom-in" }, // motion
        ],
        transition: "crossfade",
      };
      const r = preComposeGate(edit);
      const slide = r.checks.find((c) => c.name === "slideshow_risk")!;
      expect(slide.status).toBe("warn");
      expect(r.verdict).toBe("warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails slideshow risk when static images + transition=none", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-none-"));
    try {
      const mk = (n: string) => { const p = join(dir, n); writeFileSync(p, "x"); return p; };
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: mk("a.png"), in_seconds: 0, out_seconds: 2 },
          { id: "b", source: mk("b.png"), in_seconds: 2, out_seconds: 4 },
        ],
        transition: "none",
      };
      const r = preComposeGate(edit);
      expect(r.checks.find((c) => c.name === "slideshow_risk")!.status).toBe("fail");
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns on multiple image cuts with transition=none even if not slideshow-heavy", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-nonemo-"));
    try {
      const mk = (n: string) => { const p = join(dir, n); writeFileSync(p, "x"); return p; };
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: mk("a.png"), in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
          { id: "b", source: mk("b.png"), in_seconds: 2, out_seconds: 4, animation: "zoom-in" },
        ],
        transition: "none",
      };
      const r = preComposeGate(edit);
      // Motion is set so it's not slideshow-heavy, but transition=none with >=2 image cuts nudges.
      const slide = r.checks.find((c) => c.name === "slideshow_risk")!;
      expect(slide.status).toBe("warn");
      expect(slide.detail).toContain("crossfade");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preComposeGate — sources + audio", () => {
  it("fails sources_exist when every source is missing", () => {
    const r = preComposeGate({
      version: "1.0",
      cuts: [
        { id: "a", source: "/no/1.png", in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
        { id: "b", source: "/no/2.png", in_seconds: 2, out_seconds: 4, animation: "ken-burns" },
      ],
    });
    expect(r.checks.find((c) => c.name === "sources_exist")!.status).toBe("fail");
    expect(r.verdict).toBe("fail");
  });

  it("passes audio_present when a music layer is present (silent image cut OK)", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-aud-"));
    try {
      const a = join(dir, "a.png"); writeFileSync(a, "x");
      const mus = join(dir, "m.mp3"); writeFileSync(mus, "x");
      const r = preComposeGate({
        version: "1.0",
        cuts: [{ id: "a", source: a, in_seconds: 0, out_seconds: 3, animation: "ken-burns" }],
        audio: { music: { src: mus } },
      });
      expect(r.checks.find((c) => c.name === "audio_present")!.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
