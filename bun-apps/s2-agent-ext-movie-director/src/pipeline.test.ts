import { describe, test, expect } from "bun:test";
import { listPipelines, loadPipeline, getStageOrder, getStage, getNextStage, getStageHumanApprovalDefault } from "./pipeline.ts";

describe("pipeline loader", () => {
  test("listPipelines includes the bundled manifests", () => {
    const list = listPipelines();
    expect(list).toContain("talking-head");
    expect(list).toContain("animated-explainer");
  });

  test("talking-head loads + schema-validates", () => {
    const m = loadPipeline("talking-head");
    expect("stages" in m).toBe(true);
    if (!("stages" in m)) return;
    expect(m.name).toBe("talking-head");
    expect(getStageOrder("talking-head")).toEqual(["idea", "script", "scene_plan", "assets", "edit", "compose", "publish"]);
  });

  test("talking-head approval gates match the manifest", () => {
    // From pipeline_defs/talking-head.yaml: idea/script/scene_plan/assets/publish gated; edit/compose not.
    expect(getStageHumanApprovalDefault("talking-head", "idea")).toBe(true);
    expect(getStageHumanApprovalDefault("talking-head", "script")).toBe(true);
    expect(getStageHumanApprovalDefault("talking-head", "assets")).toBe(true);
    expect(getStageHumanApprovalDefault("talking-head", "edit")).toBe(false);
    expect(getStageHumanApprovalDefault("talking-head", "compose")).toBe(false);
    expect(getStageHumanApprovalDefault("talking-head", "publish")).toBe(true);
  });

  test("getNextStage walks the order", () => {
    expect(getNextStage("talking-head", "idea")).toBe("script");
    expect(getNextStage("talking-head", "compose")).toBe("publish");
    expect(getNextStage("talking-head", "publish")).toBeUndefined();
  });

  test("produces + skill accessors", () => {
    expect(getStage("talking-head", "compose")?.produces).toEqual(["render_report", "final_review"]);
    expect(getStage("talking-head", "idea")?.produces).toEqual(["brief", "decision_log"]);
  });

  test("unknown pipeline returns a load error", () => {
    const m = loadPipeline("not-a-real-pipeline");
    expect("ok" in m && m.ok === false).toBe(true);
    expect(getStageOrder("not-a-real-pipeline")).toEqual([]);
  });
});
