import fs from "fs";
import path from "path";
import { UPLOAD_DIR, OUTPUT_DIR } from "../lib/paths";

export async function handleUpload(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Ensure upload directory exists
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    // Generate unique filename
    const ext = path.extname(file.name) || ".png";
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    const filename = `upload_${timestamp}_${random}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    // Write file
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    // URL relative to output serving
    const url = `/output/uploads/${filename}`;

    return Response.json({
      path: filePath,
      url,
      name: file.name,
      size: buffer.length,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
