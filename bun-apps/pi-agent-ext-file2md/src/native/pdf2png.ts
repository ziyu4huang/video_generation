/**
 * PDF → PNG rasterizer.
 *
 * Two interchangeable backends, tried in order:
 *
 * 1. **`pdf2image`** (Xpdf/Ghostscript CLI, e.g. `brew install pdf2image`).
 *    Preferred when available: native binary, no Swift compile step.
 *    The CLI writes `<xmlBase>_<n>.png` next to the supplied xml-file path
 *    (1-indexed from the first rendered page); we rename those into the
 *    canonical `page-NNN.png` layout.
 * 2. **macOS PDFKit** (fallback). The Swift source is embedded as a string;
 *    at runtime we write it to a temp file and invoke the system `swift`
 *    toolchain (`xcrun swift`). Works on any Mac with Xcode Command Line
 *    Tools installed, with no extra dependencies.
 *
 * Output: <outDir>/page-001.png, page-002.png, … (1-indexed, zero-padded to
 * the page count width). Prints the page count to stdout on success.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Embedded Swift helper. Kept self-contained (Foundation + Quartz + AppKit). */
const SWIFT_SOURCE = `import Foundation
import Quartz
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: pdf2png input.pdf outDir [dpi] [fromPage] [toPage]\\n".data(using:.utf8)!)
    exit(2)
}
let input = args[1]
let outDir = args[2]
let dpi = args.count >= 4 ? Double(args[3])! : 150.0
let fromPage = args.count >= 5 ? Int(args[4])! : 1
let toPageIn = args.count >= 6 ? Int(args[5])! : 0

guard let doc = PDFDocument(url: URL(fileURLWithPath: input)) else {
    FileHandle.standardError.write("cannot open \\(input)\\n".data(using:.utf8)!)
    exit(3)
}
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
let total = doc.pageCount
let toPage = toPageIn > 0 ? min(toPageIn, total) : total
let width = max(3, String(total).count)
let scale = dpi / 72.0
var written = 0
for i in max(1,fromPage)...toPage {
    guard let page = doc.page(at: i-1) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let w = max(1, Int(bounds.width * scale))
    let h = max(1, Int(bounds.height * scale))
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0) else { continue }
    NSGraphicsContext.saveGraphicsState()
    guard let gctx = NSGraphicsContext(bitmapImageRep: rep) else { NSGraphicsContext.restoreGraphicsState(); continue }
    NSGraphicsContext.current = gctx
    let ctx = gctx.cgContext
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fill(CGRect(x:0,y:0,width:w,height:h))
    // Scale point-space (72 DPI) up to the target pixel DPI. Uniform positive
    // scale only — NO vertical flip. PDFKit draws upright into the bitmap rep's
    // NSGraphicsContext (origin bottom-left, same as PDF); flipping Y would turn
    // the page upside-down, and omitting the scale would shrink it to ~1/4.
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { continue }
    let name = String(format: "%@/page-%0\\(width)d.png", outDir, i)
    try png.write(to: URL(fileURLWithPath: name))
    written += 1
}
print(written)
`;

export interface RasterizeOptions {
  /** Render DPI (default 150). */
  dpi?: number;
  /** 1-indexed first page (default 1). */
  fromPage?: number;
  /** 1-indexed last page (default: last). */
  toPage?: number;
}

export interface RasterizeResult {
  pageCount: number;
  /** Absolute paths of produced PNGs, in page order. */
  pages: string[];
}

/** Run a command and collect stdout/stderr. Works in both Bun and Node runtimes. */
function spawnCollect(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "pipe" });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    p.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    p.on("error", reject);
    p.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      }),
    );
  });
}

/**
 * Rasterize a PDF to PNG pages using macOS PDFKit.
 *
 * @param pdfPath  absolute path to the source PDF
 * @param outDir   directory to write page PNGs into (created if missing)
 */
async function rasterizeViaPdfKit(pdfPath: string, outDir: string, opts: RasterizeOptions): Promise<RasterizeResult> {
  const swift = await findSwift();

  // Write the embedded Swift source to a temp .swift file.
  const tmpDir = mkdtempSync(join(tmpdir(), "vlm-pdf2png-"));
  const swiftFile = join(tmpDir, "pdf2png.swift");
  writeFileSync(swiftFile, SWIFT_SOURCE);

  try {
    const { code, stdout, stderr } = await spawnCollect(swift, [
      swiftFile,
      pdfPath,
      outDir,
      String(opts.dpi ?? 150),
      String(opts.fromPage ?? 1),
      String(opts.toPage ?? 0),
    ]);
    if (code !== 0) {
      throw new Error(`pdf2png failed (exit ${code}):\n${stderr}`);
    }
    const pageCount = Number(stdout.trim()) || 0;
    if (pageCount === 0) throw new Error(`pdf2png produced no pages.\n${stderr}`);
    const width = Math.max(3, String(pageCount).length);
    const pages: string[] = [];
    for (let i = 1; i <= pageCount; i++) {
      pages.push(join(outDir, `page-${String(i).padStart(width, "0")}.png`));
    }
    return { pageCount, pages };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Locate the system swift binary (prefer the resolved xcrun path). */
async function findSwift(): Promise<string> {
  // xcrun resolves the active developer toolchain's swift (handles Xcode vs CLT).
  try {
    const { code, stdout } = await spawnCollect("xcrun", ["--find", "swift"]);
    if (code === 0) {
      const path = stdout.trim();
      if (path && existsSync(path)) return path;
    }
  } catch {
    /* fall through */
  }
  // Fallback: ask the shell where swift lives.
  try {
    const { code, stdout } = await spawnCollect("which", ["swift"]);
    if (code === 0) {
      const path = stdout.trim();
      if (path && existsSync(path)) return path;
    }
  } catch {
    /* fall through */
  }
  throw new Error("swift toolchain not found. Install Xcode Command Line Tools: `xcode-select --install`.");
}

/** Locate the `pdf2image` CLI on PATH. Returns its path or null if absent. */
async function findPdf2Image(): Promise<string | null> {
  try {
    const { code, stdout } = await spawnCollect("which", ["pdf2image"]);
    if (code === 0) {
      const path = stdout.trim();
      if (path && existsSync(path)) return path;
    }
  } catch {
    /* not installed */
  }
  return null;
}

/**
 * Rasterize a PDF to PNG pages via the `pdf2image` CLI (Xpdf/Ghostscript).
 *
 * The CLI emits `<xmlBase>_<n>.png` siblings of the given xml-file path
 * (1-indexed from the first rendered page). We render into a temp dir, then
 * rename the produced PNGs into `<outDir>/page-NNN.png`.
 *
 * NOTE: `pdf2image` returns exit 0 even for damaged/corrupt PDFs while
 * emitting no pages, so success is decided by the count of produced PNGs —
 * a zero count triggers a fallback to the PDFKit backend.
 */
async function rasterizeViaPdf2Image(
  pdfPath: string,
  outDir: string,
  opts: RasterizeOptions,
): Promise<RasterizeResult> {
  const bin = await findPdf2Image();
  if (!bin) throw new Error("pdf2image not found");

  const fromPage = opts.fromPage ?? 1;
  const dpi = opts.dpi ?? 150;
  // pdf2image's -zoom is a scale factor over the 72 DPI point space.
  const zoom = dpi / 72;

  // Render into a temp dir so a failed/partial run never pollutes outDir.
  const tmpDir = mkdtempSync(join(tmpdir(), "vlm-pdf2image-"));
  const tmpXml = join(tmpDir, "out.xml");
  try {
    const args = ["-dev", "png16m", "-zoom", String(zoom), "-f", String(fromPage)];
    if (opts.toPage && opts.toPage > 0) {
      args.push("-l", String(opts.toPage));
    }
    args.push(pdfPath, tmpXml);

    await spawnCollect(bin, args);

    // Collect `<tmpXml>_<n>.png` sorted by page index.
    const prefix = `${tmpXml}_`;
    const produced = readdirSync(tmpDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
      .map((f) => Number(f.slice(prefix.length, -".png".length)))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);

    if (produced.length === 0) {
      throw new Error("pdf2image produced no pages");
    }

    const pageCount = produced.length;
    const width = Math.max(3, String(fromPage + pageCount - 1).length);
    const pages: string[] = [];
    produced.forEach((n, idx) => {
      const pageNo = fromPage + idx; // preserve global page index in the name
      const dst = join(outDir, `page-${String(pageNo).padStart(width, "0")}.png`);
      renameSync(join(tmpDir, `${prefix}${n}.png`), dst);
      pages.push(dst);
    });
    return { pageCount, pages };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Rasterize a PDF to PNG pages.
 *
 * Tries the `pdf2image` CLI first; on any failure (binary missing, non-zero
 * exit, zero pages produced) it transparently falls back to the PDFKit
 * backend so the error-message contract (`pdf2png failed …`) is preserved.
 *
 * @param pdfPath  absolute path to the source PDF
 * @param outDir   directory to write page PNGs into (created if missing)
 */
export async function rasterizePdf(
  pdfPath: string,
  outDir: string,
  opts: RasterizeOptions = {},
): Promise<RasterizeResult> {
  try {
    return await rasterizeViaPdf2Image(pdfPath, outDir, opts);
  } catch (err) {
    // Graceful fallback to the dependency-free PDFKit backend.
    return await rasterizeViaPdfKit(pdfPath, outDir, opts);
  }
}
