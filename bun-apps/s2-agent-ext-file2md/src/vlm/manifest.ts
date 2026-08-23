/**
 * Manifest model for `file2md` output.
 *
 * Each input document maps to `output/<doc-slug>/` containing:
 *   - manifest.json   — input meta + per-page status (this module's schema)
 *   - pages/*.png     — rasterized page images (for PDF/profiles that convert)
 *   - pages/*.md      — per-page Obsidian markdown (frontmatter + ![[png]])
 *   - <slug>.md       — the document-level index note (MOC linking all pages)
 *
 * The manifest is the source of truth for resumability: the orchestrator
 * re-runs only pages whose status != "done".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export type PageStatus = "pending" | "in_progress" | "done" | "error";

export interface ManifestPage {
  /** 1-indexed page number. */
  page: number;
  /** PNG filename relative to the doc output dir (e.g. "pages/page-001.png"). */
  png: string | null;
  /** Markdown filename relative to the doc output dir (e.g. "pages/page-001.md"). */
  md: string | null;
  status: PageStatus;
  /** Last error message when status === "error". */
  error?: string;
}

export interface Manifest {
  /** Schema version of the manifest. */
  schemaVersion: 1;
  /** Original absolute input path. */
  input: string;
  /** Original basename. */
  inputName: string;
  /** Detected doc kind: "pdf" | "image". */
  kind: string;
  /** Semantic profile: "paper" | "image". */
  profile: string;
  /** Stable slug used as the output folder name. */
  slug: string;
  /** Number of pages (1 for single images). */
  pageCount: number;
  /** ISO timestamp when the manifest was created. */
  createdAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  pages: ManifestPage[];
}

/** Turn a filename into a filesystem-safe slug. */
export function slugify(name: string): string {
  const base = basename(name, extname(name));
  return (
    base
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "doc"
  );
}

/** Pad a page number to the given total-page width (1-indexed). */
export function pageLabel(page: number, total: number): string {
  const width = Math.max(3, String(total).length);
  return String(page).padStart(width, "0");
}

/** Path helpers for a document output dir. */
export interface DocLayout {
  dir: string;
  pagesDir: string;
  manifestPath: string;
  indexNotePath: string;
  /** Relative png path for a page (relative to dir). */
  pngRel: (page: number) => string;
  /** Relative md path for a page (relative to dir). */
  mdRel: (page: number) => string;
  /** Absolute png path for a page. */
  pngAbs: (page: number) => string;
  /** Absolute md path for a page. */
  mdAbs: (page: number) => string;
}

export function layoutFor(outRoot: string, slug: string, pageCount: number): DocLayout {
  const dir = join(outRoot, slug);
  const pagesDir = join(dir, "pages");
  const pngRel = (p: number) => `pages/page-${pageLabel(p, pageCount)}.png`;
  const mdRel = (p: number) => `pages/page-${pageLabel(p, pageCount)}.md`;
  return {
    dir,
    pagesDir,
    manifestPath: join(dir, "manifest.json"),
    indexNotePath: join(dir, `${slug}.md`),
    pngRel,
    mdRel,
    pngAbs: (p: number) => join(dir, pngRel(p)),
    mdAbs: (p: number) => join(dir, mdRel(p)),
  };
}

/** Create the doc output dir + pages/ subdir. */
export function ensureLayout(layout: DocLayout): void {
  mkdirSync(layout.dir, { recursive: true });
  mkdirSync(layout.pagesDir, { recursive: true });
}

/** Build a fresh manifest for a document. */
export function createManifest(opts: {
  input: string;
  inputName: string;
  kind: string;
  profile: string;
  slug: string;
  pageCount: number;
  layout: DocLayout;
}): Manifest {
  const now = new Date().toISOString();
  const pages: ManifestPage[] = [];
  for (let p = 1; p <= opts.pageCount; p++) {
    pages.push({
      page: p,
      png: opts.layout.pngRel(p),
      md: opts.layout.mdRel(p),
      status: "pending",
    });
  }
  return {
    schemaVersion: 1,
    input: opts.input,
    inputName: opts.inputName,
    kind: opts.kind,
    profile: opts.profile,
    slug: opts.slug,
    pageCount: opts.pageCount,
    createdAt: now,
    updatedAt: now,
    pages,
  };
}

/** Persist a manifest to disk. */
export function writeManifest(layout: DocLayout, manifest: Manifest): void {
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Load a manifest if present (for resumability), else null. */
export function loadManifest(layout: DocLayout): Manifest | null {
  if (!existsSync(layout.manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(layout.manifestPath, "utf8")) as Manifest;
  } catch {
    return null;
  }
}
