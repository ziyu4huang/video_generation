import { describe, it, expect } from "bun:test";
import { handleGallery, handleGallerySearch } from "./gallery";

function gzipReq(url: string): Request {
  return new Request(url, { headers: { "Accept-Encoding": "gzip" } });
}

function plainReq(url: string): Request {
  return new Request(url);
}

describe("handleGallery: gzip compression", () => {
  it("sets Content-Encoding: gzip when Accept-Encoding: gzip is present", async () => {
    const res = await handleGallery(gzipReq("http://x/api/gallery"));
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
  });

  it("sets Vary: Accept-Encoding header with gzip", async () => {
    const res = await handleGallery(gzipReq("http://x/api/gallery"));
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
  });

  it("Bun.gunzipSync() decompresses body to valid JSON with images and total", async () => {
    const res = await handleGallery(gzipReq("http://x/api/gallery"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(Bun.gunzipSync(bytes));
    const data = JSON.parse(text);
    expect(Array.isArray(data.images)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("returns plain JSON (no Content-Encoding) without Accept-Encoding: gzip", async () => {
    const res = await handleGallery(plainReq("http://x/api/gallery"));
    expect(res.headers.get("Content-Encoding")).toBeNull();
    const data = await res.json();
    expect(Array.isArray(data.images)).toBe(true);
  });

  it("pagination params page and limit are reflected in the response body", async () => {
    const res = await handleGallery(plainReq("http://x/api/gallery?page=2&limit=10"));
    const data = await res.json();
    expect(data.page).toBe(2);
    expect(data.limit).toBe(10);
  });
});

describe("handleGallerySearch: gzip compression", () => {
  it("returns 200 with empty results and no gzip when query is empty", async () => {
    const res = await handleGallerySearch(gzipReq("http://x/api/gallery/search?q="));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    const data = await res.json();
    expect(data.images).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it("compresses search results with Bun.gunzipSync() when Accept-Encoding: gzip", async () => {
    const res = await handleGallerySearch(gzipReq("http://x/api/gallery/search?q=cat"));
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(Bun.gunzipSync(bytes));
    const data = JSON.parse(text);
    expect(Array.isArray(data.images)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("returns plain JSON for search without Accept-Encoding: gzip", async () => {
    const res = await handleGallerySearch(plainReq("http://x/api/gallery/search?q=dog"));
    expect(res.headers.get("Content-Encoding")).toBeNull();
    const data = await res.json();
    expect(data).toHaveProperty("images");
  });
});
