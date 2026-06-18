import { apiFetch } from "./client";
import type { GalleryImage } from "../types";

export function fetchGallery(limit = 20, page = 0): Promise<{ images: GalleryImage[]; total: number }> {
  return apiFetch(`/api/gallery?limit=${limit}&page=${page}`);
}

export function searchGallery(q: string, type = "all"): Promise<{ images: GalleryImage[]; total: number }> {
  return apiFetch(`/api/gallery/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`);
}

export function deleteGalleryItem(name: string, dirIdx: number): Promise<{ ok: boolean; failed?: string[] }> {
  return apiFetch("/api/gallery", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, dirIdx }),
  });
}
