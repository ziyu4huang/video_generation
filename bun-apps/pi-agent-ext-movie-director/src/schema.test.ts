import { describe, test, expect } from "bun:test";
import { validateArtifact, listSchemas } from "./schema.ts";

describe("artifact schema validation", () => {
  test("schemas loaded include the canonical artifacts", () => {
    const list = listSchemas();
    expect(list).toContain("artifact/script");
    expect(list).toContain("artifact/edit_decisions");
    expect(list).toContain("artifact/research_brief"); // ported from OpenMontage (research stage)
    expect(list).toContain("pipeline/pipeline_manifest");
    expect(list).toContain("checkpoint/checkpoint");
  });

  test("a well-formed brief validates", () => {
    const r = validateArtifact("brief", {
      version: "1.0",
      title: "Hook Test",
      hook: "a hook",
      key_points: ["a"],
      tone: "neutral",
      style: "clean",
      target_platform: "youtube",
      target_duration_seconds: 30,
    });
    expect(r.ok).toBe(true);
  });

  test("a malformed brief (missing required) fails with errors", () => {
    const r = validateArtifact("brief", { version: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  test("a well-formed research_brief validates (port of OpenMontage's research stage artifact)", () => {
    const r = validateArtifact("research_brief", {
      version: "1.0",
      topic: "Why local-first AI video generation matters",
      research_date: "2026-07-10",
      landscape: {
        existing_content: [
          { title: "Cloud video gen 101", source: "youtube", angle: "tutorial", what_it_covers: "API basics" },
          { title: "On-device MLX intro", source: "blog", angle: "technical", what_it_covers: "MLX primitives" },
          { title: "Cost of cloud gen", source: "tiktok", angle: "financial", what_it_covers: "per-clip spend" },
        ],
        saturated_angles: ["generic cloud API tutorials"],
        underserved_gaps: ["fully-offline local video pipelines"],
      },
      data_points: [
        { claim: "Local MLX marginal cost is ~$0", source_url: "https://example.com/a", credibility: "primary_source" },
        { claim: "Cloud video gen averages $0.10/sec", source_url: "https://example.com/b", credibility: "secondary_source" },
        { claim: "MLX matches CUDA on Apple Silicon for inference", source_url: "https://example.com/c", credibility: "secondary_source" },
      ],
      audience_insights: {
        common_questions: ["Is local fast enough?", "What about quality?", "Cost comparison?"],
        misconceptions: [{ myth: "Local can't do video", reality: "LTX-2.3 runs natively on MLX" }],
        knowledge_level: "Knows cloud gen; new to local MLX",
      },
      angles_discovered: [
        { name: "The $0 video", hook: "Generate video for free, on your own silicon", type: "data_driven", why_now: "MLX parity reached in 2026" },
        { name: "Offline-first", hook: "Zero network egress, ever", type: "evergreen", why_now: "Privacy + reliability" },
        { name: "The cloud cost audit", hook: "What cloud gen actually costs at scale", type: "contrarian", why_now: "Rising API prices" },
      ],
      sources: [
        { url: "https://example.com/a", title: "Source A", used_for: "cost data" },
        { url: "https://example.com/b", title: "Source B", used_for: "cost data" },
        { url: "https://example.com/c", title: "Source C", used_for: "MLX parity" },
        { url: "https://example.com/d", title: "Source D", used_for: "landscape" },
        { url: "https://example.com/e", title: "Source E", used_for: "audience" },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test("a malformed research_brief (too few sources / angles) fails with errors", () => {
    const r = validateArtifact("research_brief", {
      version: "1.0",
      topic: "x",
      research_date: "2026-07-10",
      landscape: { existing_content: [], saturated_angles: [], underserved_gaps: [] },
      data_points: [],
      audience_insights: { common_questions: [], misconceptions: [], knowledge_level: "" },
      angles_discovered: [{ name: "only one", hook: "h", type: "evergreen", why_now: "w" }], // minItems:3
      sources: [{ url: "https://e.com", title: "one", used_for: "x" }], // minItems:5
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  test("a wrong enum value's error names the actual allowed values, not just 'allowed values'", () => {
    const r = validateArtifact("research_brief", {
      version: "1.0",
      topic: "x",
      research_date: "2026-07-10",
      landscape: {
        existing_content: [
          { title: "a", source: "s", angle: "a", what_it_covers: "c" },
          { title: "b", source: "s", angle: "a", what_it_covers: "c" },
          { title: "c", source: "s", angle: "a", what_it_covers: "c" },
        ],
        saturated_angles: [],
        underserved_gaps: ["gap"],
      },
      data_points: [{ claim: "c", source_url: "https://e.com", credibility: "high" }], // invalid enum value
      audience_insights: { common_questions: [], misconceptions: [], knowledge_level: "beginner" },
      angles_discovered: [
        { name: "a", hook: "h", type: "evergreen", why_now: "w" },
        { name: "b", hook: "h", type: "evergreen", why_now: "w" },
        { name: "c", hook: "h", type: "evergreen", why_now: "w" },
      ],
      sources: Array.from({ length: 5 }, (_, i) => ({ url: `https://e.com/${i}`, title: `t${i}`, used_for: "x" })),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const credibilityError = r.errors.find((e) => e.includes("credibility"));
      expect(credibilityError).toBeDefined();
      expect(credibilityError).toContain("primary_source");
      expect(credibilityError).toContain("secondary_source");
      expect(credibilityError).toContain('got "high"');
    }
  });

  test("a missing nested-required-object property names its own required sub-fields", () => {
    const r = validateArtifact("proposal_packet", { production_plan: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const stagesError = r.errors.find((e) => e.includes("'stages'"));
      expect(stagesError).toBeDefined();
      expect(stagesError).toContain("stage");
      expect(stagesError).toContain("tools");
      expect(stagesError).toContain("approach");
      const runtimeError = r.errors.find((e) => e.includes("'render_runtime'"));
      expect(runtimeError).toBeDefined();
      expect(runtimeError).toContain("remotion");
      expect(runtimeError).toContain("hyperframes");
    }
  });
});

describe("scene_plan", () => {
  test("scene_plan: a scene may declare continuity 'cut' or 'continue'", () => {
    const scenePlan = {
      version: "1.0",
      scenes: [
        { id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 6, continuity: "cut" },
        { id: "s2", type: "generated", description: "a sphere", start_seconds: 6, end_seconds: 12, continuity: "continue" },
      ],
    };
    expect(validateArtifact("scene_plan", scenePlan).ok).toBe(true);
  });

  test("scene_plan: continuity rejects values outside 'continue'/'cut'", () => {
    const scenePlan = {
      version: "1.0",
      scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 6, continuity: "maybe" }],
    };
    expect(validateArtifact("scene_plan", scenePlan).ok).toBe(false);
  });
});

describe("edit_decisions", () => {
  test("edit_decisions: top-level transition accepts 'none' or 'crossfade'", () => {
    const edit = {
      version: "1.0",
      render_runtime: "ffmpeg",
      transition: "none",
      cuts: [{ id: "cut-1", source: "/tmp/relay.mp4", in_seconds: 0, out_seconds: 8 }],
    };
    expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
  });

  test("edit_decisions: transition rejects values outside 'none'/'crossfade'", () => {
    const edit = {
      version: "1.0",
      render_runtime: "ffmpeg",
      transition: "wipe",
      cuts: [{ id: "cut-1", source: "/tmp/relay.mp4", in_seconds: 0, out_seconds: 8 }],
    };
    expect(validateArtifact("edit_decisions", edit).ok).toBe(false);
  });
});
