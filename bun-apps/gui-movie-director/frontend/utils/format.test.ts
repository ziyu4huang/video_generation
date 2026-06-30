import { describe, it, expect } from "bun:test";
import { formatBytes, relativeTime, formatDate, basename, formatDuration } from "./format";

describe("formatBytes", () => {
  it("formats bytes", () => expect(formatBytes(0)).toBe("0 B"));
  it("formats small values", () => expect(formatBytes(512)).toBe("512 B"));
  it("formats KB", () => expect(formatBytes(1024)).toBe("1.0 KB"));
  it("formats MB", () => expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB"));
  it("formats GB", () => expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB"));
  it("rounds to 1 decimal", () => expect(formatBytes(1536)).toBe("1.5 KB"));
});

describe("formatSize (alias)", () => {
  const { formatSize } = require("./format");
  it("matches formatBytes", () => expect(formatSize(2048)).toBe(formatBytes(2048)));
});

describe("formatDuration", () => {
  it("formats ms", () => expect(formatDuration(500)).toBe("500ms"));
  it("formats seconds", () => expect(formatDuration(5000)).toBe("5s"));
  it("formats minutes + seconds", () => expect(formatDuration(95000)).toBe("1m 35s"));
  it("handles zero", () => expect(formatDuration(0)).toBe("0ms"));
});

describe("basename", () => {
  it("extracts from unix path", () => expect(basename("/a/b/file.png")).toBe("file.png"));
  it("extracts from relative path", () => expect(basename("output/file.png")).toBe("file.png"));
  it("returns same if no slash", () => expect(basename("file.png")).toBe("file.png"));
  it("handles empty string", () => expect(basename("")).toBe(""));
});

describe("relativeTime", () => {
  it("returns 'just now' for recent", () => {
    const now = new Date().toISOString();
    expect(relativeTime(now)).toBe("just now");
  });
  it("returns '5m ago' for 5 min ago", () => {
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relativeTime(past)).toBe("5m ago");
  });
  it("returns '2h ago' for 2 hours ago", () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(past)).toBe("2h ago");
  });
});

describe("formatDate", () => {
  it("returns a non-empty string", () => {
    const result = formatDate(new Date().toISOString());
    expect(result.length).toBeGreaterThan(0);
  });
  it("includes the time", () => {
    const result = formatDate("2025-06-12T15:30:00Z");
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});
