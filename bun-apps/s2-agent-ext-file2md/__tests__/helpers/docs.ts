/**
 * helpers/docs.ts — pure-TS document fixture builders for the v2 suite.
 *
 * Everything is generated in-process (no binary fixtures in the repo):
 *   - textPdf       pdf-lib: real text layer (pdfjs extractable)
 *   - scannedPdf    pdf-lib: image-only page (no text layer)
 *   - workbookXlsx  exceljs: cells + a formula
 *   - tinyPng       bgraToPng (the v2 encoder itself)
 * All builders return Uint8Array buffers to write into temp dirs.
 */

import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { bgraToPng } from "../../src/raster/png.ts";

/** A 40×12 red-on-white PNG (our own encoder — also self-verifies it). */
export function tinyPng(): Uint8Array {
  const w = 40;
  const h = 12;
  const bgra = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    bgra[i * 4] = 0; // B
    bgra[i * 4 + 1] = 0; // G
    bgra[i * 4 + 2] = 200; // R
    bgra[i * 4 + 3] = 255; // A
  }
  return bgraToPng(bgra, w, h);
}

/** One-page A4 PDF with a real text layer ("Hello from file2md v2"). */
export async function textPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Hello from file2md v2", { x: 60, y: 760, size: 18, font });
  page.drawText("Second line of the body text.", { x: 60, y: 720, size: 12, font });
  return new Uint8Array(await doc.save());
}

/** One-page PDF with ONE image and NO text layer (scan-shaped). */
export async function scannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([40, 12]);
  const png = await doc.embedPng(tinyPng());
  page.drawImage(png, { x: 0, y: 0, width: 40, height: 12 });
  return new Uint8Array(await doc.save());
}

/** One-sheet workbook with rows A/B/C + a formula in C5. */
export async function workbookXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data");
  ws.addRow(["Item", "Qty", "Price"]);
  ws.addRow(["Widget", 3, 1.25]);
  ws.addRow(["Gadget", 5, 2.5]);
  ws.getCell("C5").value = { formula: "SUM(C2:C4)", result: 3.75 };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Minimal ipynb buffer (one markdown + one code cell). */
export function notebookIpynb(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["# Title cell"] },
        {
          cell_type: "code",
          metadata: {},
          source: ["print(42)"],
          outputs: [{ output_type: "stream", name: "stdout", text: ["42\n"] }],
        },
      ],
    }),
  );
}
