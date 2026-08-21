import { describe, expect, test } from "bun:test";
import { pickModel } from "./model.ts";

const registry = (models: Array<{ provider: string; id: string }>) => ({
  find: (provider: string, id: string) =>
    models.find((m) => m.provider === provider && m.id === id) as never,
});

describe("pickModel", () => {
  test("override spec resolved via registry (thinking suffix stripped)", () => {
    const ctxModel = { provider: "zai", id: "default" };
    const m = pickModel(
      { model: ctxModel as never, modelRegistry: registry([{ provider: "zai", id: "glm-5.3" }]) },
      "zai/glm-5.3:high",
    );
    expect(m?.id).toBe("glm-5.3");
  });
  test("unresolvable override falls back to session model", () => {
    const ctxModel = { provider: "zai", id: "default" };
    const m = pickModel({ model: ctxModel as never, modelRegistry: registry([]) }, "nope/x");
    expect(m?.id).toBe("default");
  });
  test("no override → session model; none → undefined", () => {
    const ctxModel = { provider: "zai", id: "default" };
    expect(pickModel({ model: ctxModel as never, modelRegistry: registry([]) }, undefined)?.id).toBe("default");
    expect(pickModel({ model: undefined, modelRegistry: registry([]) }, undefined)).toBeUndefined();
  });
});
