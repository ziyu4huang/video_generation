import { describe, expect, it } from "bun:test";
import { sceneToPlannerScene, planStoryboard, type SceneSpec } from "./storyboard_scene.ts";

describe("sceneToPlannerScene — flatten SceneSpec for the prompt builder", () => {
  it("joins subject/motion/scene with '. ', skipping empty parts", () => {
    const planner = sceneToPlannerScene({
      id: "beat-1",
      subject: "a detective",
      motion: "lighting a cigarette",
      scene: "a rain-soaked alley",
    });
    expect(planner.description).toBe("a detective. lighting a cigarette. a rain-soaked alley");
    expect(planner.type).toBe("visual");
  });

  it("defaults type to 'visual' and heroMoment to false", () => {
    const planner = sceneToPlannerScene({ id: "s1", subject: "x", scene: "y" });
    expect(planner.type).toBe("visual");
    expect(planner.heroMoment).toBe(false);
  });
});

describe("planStoryboard — deterministic scene → shot mapping", () => {
  const scenes: SceneSpec[] = [
    { id: "beat-1", subject: "detective", scene: "alley", characterId: "detective", heroMoment: true },
    { id: "beat-2", subject: "detective", scene: "diner", characterId: "detective" },
    { id: "beat-3", subject: "a stranger", scene: "rooftop", characterId: "stranger" },
  ];

  it("maps each scene to one shot with its prompt + characterId", () => {
    const board = planStoryboard(scenes);
    expect(board.shots).toHaveLength(3);
    expect(board.shots[0]).toMatchObject({ sceneId: "beat-1", characterId: "detective", heroMoment: true });
    expect(board.shots[0]?.prompt.length).toBeGreaterThan(0);
  });

  it("lists characters appearing in >=2 shots as recurring, sorted", () => {
    const board = planStoryboard(scenes);
    expect(board.recurringCharacters).toEqual(["detective"]);
  });

  it("a character appearing in exactly 1 shot is NOT recurring", () => {
    const board = planStoryboard(scenes);
    expect(board.recurringCharacters).not.toContain("stranger");
  });

  it("drops transition scenes from shots (skipped by buildBatchPrompts)", () => {
    const board = planStoryboard([...scenes, { id: "t1", subject: "", scene: "", type: "transition" }]);
    expect(board.shots.map((s) => s.sceneId)).not.toContain("t1");
  });

  it("scenes with no characterId never appear in recurringCharacters", () => {
    const board = planStoryboard([{ id: "solo", subject: "x", scene: "y" }]);
    expect(board.recurringCharacters).toEqual([]);
    expect(board.shots[0]?.characterId).toBeNull();
  });
});
