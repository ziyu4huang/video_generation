import fs from "fs";
import path from "path";
import { UPLOAD_DIR, OUTPUT_DIR } from "../lib/paths";

// Verify the uploaded file's actual bytes match its claimed extension.
// Defense-in-depth against polyglot / HTML / SVG payloads disguised as images
// (e.g. evil.png whose bytes are <html><script>…). The extension allowlist alone
// can't catch this; combined with the Content-Type + nosniff on the serving
// path (gallery.ts), it closes the stored-XSS primitive.
async function matchesMagic(file: File, ext: string): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const eq = (offset: number, bytes: number[]) => bytes.every((b, i) => head[offset + i] === b);
  switch (ext) {
    case ".png":
      return eq(0, [0x89, 0x50, 0x4e, 0x47]);
    case ".jpg":
    case ".jpeg":
      return eq(0, [0xff, 0xd8, 0xff]);
    case ".webp":
      return eq(0, [0x52, 0x49, 0x46, 0x46]) && eq(8, [0x57, 0x45, 0x42, 0x50]); // RIFF….WEBP
    case ".mp4":
    case ".mov":
      return eq(4, [0x66, 0x74, 0x79, 0x70]); // ftyp box at offset 4
    default:
      return false;
  }
}

export async function handleUpload(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  // Ensure upload directory exists
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ ok: false, error: "No file provided" }, { status: 400 });
    }

    // Validate file extension against allowlist
    const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov"]);
    const ext = path.extname(file.name).toLowerCase() || ".png";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return Response.json({ ok: false, error: "File type not allowed" }, { status: 400 });
    }
    // Reject polyglot payloads: content must match the claimed extension.
    if (!(await matchesMagic(file, ext))) {
      return Response.json({ ok: false, error: "File content does not match its extension" }, { status: 400 });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    const filename = `upload_${timestamp}_${random}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    // Enforce upload size limit (50 MB)
    const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_SIZE) {
      return Response.json({ ok: false, error: "File too large" }, { status: 413 });
    }

    // Write file — File extends Blob, Bun.write accepts Blob directly (no Buffer allocation)
    await Bun.write(filePath, file);

    // URL relative to output serving
    const url = `/output/uploads/${filename}`;

    return Response.json({
      path: filePath,
      url,
      name: file.name,
      size: file.size,
    });
  } catch (err: any) {
    // err.message from fs/Bun.write can contain absolute filesystem paths —
    // log it server-side, return a generic message to the client (no auth).
    console.error("[upload] unexpected error:", err);
    return Response.json({ ok: false, error: "Upload failed — see server logs for details" }, { status: 500 });
  }
}
