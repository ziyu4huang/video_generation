import fs from "fs";

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function findLatestReportUrl(outputDir: string, prefix: string): string | null {
  try {
    const files = fs.readdirSync(outputDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".html"))
      .sort();
    return files.length > 0 ? `/output/${files[files.length - 1]}` : null;
  } catch {
    return null;
  }
}
