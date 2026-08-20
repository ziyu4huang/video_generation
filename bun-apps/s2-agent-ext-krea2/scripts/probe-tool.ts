/**
 * probe-tool.ts — confirm pi actually loads the `krea2` tool from the extension.
 * Mirrors doctor's smoke probe but asserts the tool BY NAME (not just marker
 * path counting). Runs offline (exits at session_start, before any model call).
 *
 *   bun scripts/probe-tool.ts
 */
export default (pi: any) => {
  pi.on("session_start", () => {
    const tools = pi.getAllTools() as Array<{ name?: string; sourceInfo?: { path?: string } }>;
    const krea2 = tools.find((t) => t?.name === "krea2");
    const krea2ByPath = tools.filter((t) =>
      String(t?.sourceInfo?.path ?? "").includes("s2-agent-ext-krea2"),
    );
    process.stderr.write(
      `[PROBE] total=${tools.length} krea2ByName=${krea2 ? "YES" : "NO"} ` +
        `krea2ByPath=${krea2ByPath.length}\n`,
    );
    if (krea2) {
      process.stderr.write(`[PROBE] ✓ krea2 tool loaded\n`);
      process.exit(0);
    }
    process.stderr.write(`[PROBE] ✗ krea2 tool NOT loaded\n`);
    process.exit(1);
  });
};
