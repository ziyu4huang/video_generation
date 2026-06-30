import { describe, it, expect } from "bun:test";
import { parseServerArgs } from "./cli-args";

describe("parseServerArgs", () => {
  it("parses --gen-output-dir <path> and --port <n> in space form", () => {
    const out = parseServerArgs(["bun", "server.ts", "--gen-output-dir", "/tmp/a", "--port", "4099"]);
    expect(out.genOutputDir).toBe("/tmp/a");
    expect(out.port).toBe(4099);
  });

  it("parses the --flag=value form", () => {
    const out = parseServerArgs(["bun", "server.ts", "--gen-output-dir=/tmp/b", "--port=5099"]);
    expect(out.genOutputDir).toBe("/tmp/b");
    expect(out.port).toBe(5099);
  });

  it("returns an empty object when no flags are present", () => {
    expect(parseServerArgs(["bun", "server.ts"])).toEqual({});
  });

  it("drops a port that is not a finite positive integer in range", () => {
    expect(parseServerArgs(["bun", "server.ts", "--port", "NaN"]).port).toBeUndefined();
    expect(parseServerArgs(["bun", "server.ts", "--port", "0"]).port).toBeUndefined();
    expect(parseServerArgs(["bun", "server.ts", "--port", "-1"]).port).toBeUndefined();
    expect(parseServerArgs(["bun", "server.ts", "--port", "70000"]).port).toBeUndefined();
  });

  it("drops a whitespace-only --gen-output-dir", () => {
    expect(parseServerArgs(["bun", "server.ts", "--gen-output-dir", "   "]).genOutputDir).toBeUndefined();
  });

  it("parses each flag independently when only one is given", () => {
    expect(parseServerArgs(["bun", "server.ts", "--port", "8188"]).port).toBe(8188);
    expect(parseServerArgs(["bun", "server.ts", "--gen-output-dir", "/x"]).genOutputDir).toBe("/x");
  });
});
