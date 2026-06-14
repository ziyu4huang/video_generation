import fs from "fs";
import path from "path";
import { UPLOAD_DIR, OUTPUT_DIR } from "../lib/paths";

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
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
