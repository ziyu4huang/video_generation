/**
 * Phase 6 / WS-C7 — measure the per-turn schema-token cost of the registered
 * tools. Loads the extension via a fake pi (so the exact TypeBox schemas get
 * serialized), prints per-tool char/token estimates (~4 chars/token), and the
 * total. Use to quantify any description trimming before/after.
 *
 *   bun run scripts/measure-schema-tokens.mjs
 */
const mod = await import("../extensions/obsidian.ts");

const tools = {};
const pi = {
	registerTool: (t) => { tools[t.name] = t; },
	registerCommand: () => {},
	on: () => {},
};
mod.default(pi);

const rows = [];
let total = 0;
for (const [name, t] of Object.entries(tools)) {
	const json = JSON.stringify({
		name: t.name,
		label: t.label,
		description: t.description,
		parameters: t.parameters,
	});
	rows.push([name, json.length]);
	total += json.length;
}
rows.sort((a, b) => b[1] - a[1]);
console.log("tool".padEnd(28), "schema-chars", "  ~tokens");
for (const [n, l] of rows) {
	console.log(n.padEnd(28), String(l).padStart(11), String(Math.round(l / 4)).padStart(8));
}
console.log("-".repeat(50));
console.log("TOTAL".padEnd(28), String(total).padStart(11), String(Math.round(total / 4)).padStart(8), "tokens/turn (est.)");
console.log(`\n${rows.length} tools registered.`);
