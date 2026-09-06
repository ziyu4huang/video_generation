// Stage-exact slide captures: inject overflow:hidden, size the viewport to the
// .stage rect, screenshot. Run: bun capture.ts [slide numbers...]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dir, "..", "..", "..", "..", "..", "output", "as5200-pcie");
const slidesDir = join(outDir, "as5200-pcie.slides");
mkdirSync(outDir, { recursive: true });

const nums = process.argv.slice(2).map(Number);
const targets = nums.length
  ? nums
  : [1, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17];

const view = new Bun.WebView();
for (const n of targets) {
  // Composed layouts keep the diagram twin in slide-N.diagram.html; slide-N.html
  // is the pptx-shaped flat view. Review the twin (the full-fidelity one).
  const file = join(slidesDir, `slide-${n}.html`);
  await view.navigate(`file://${file}`);
  await Bun.sleep(900);
  await view.evaluate(`(() => {
    const style = document.createElement("style");
    style.textContent = "html,body{overflow:hidden!important;margin:0!important}";
    document.head.appendChild(style);
  })()`);
  const rect = (await view.evaluate(`(() => {
    const el = document.querySelector(".stage") ?? document.body;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  })()`)) as string;
  const box = JSON.parse(rect) as { x: number; y: number; w: number; h: number };
  await view.resize(box.w, box.h);
  await Bun.sleep(250);
  const png = await view.screenshot();
  await Bun.write(join(outDir, "shots", `slide-${String(n).padStart(2, "0")}.png`), png);
  console.log(`slide ${n}: ${box.w}x${box.h} captured`);
}
await view.close();
