/**
 * Pure HTML→structural-facts parser for generated archify artifacts.
 * No DOM/browser dependency — string + regex only. Used by the real-result
 * evaluation to assert generated-HTML quality (round-trip integrity,
 * functional self-containment, non-triviality).
 */

export interface ExternalRef {
  kind: "script" | "stylesheet" | "preconnect" | "image" | "anchor";
  url: string;
  /** true = absence breaks offline rendering (external script/img/non-allowlisted ref). */
  blocking: boolean;
}

export interface ArtifactFacts {
  bytes: number;
  hasDoctype: boolean;
  hasSvg: boolean;
  svgViewBox?: string;
  title?: string;
  generator?: string;
  /** distinct values among every `data-kind` attribute (includes the
   *  template's legend/theme swatches); NOT a diagram-node-kind list — use
   *  `textLabels` for node-content signals. */
  dataKinds: string[];
  /** counts every `data-kind` attribute (includes the template's legend/theme
   *  swatches); NOT a diagram-node count — use `textLabels` for node-content
   *  signals. */
  dataKindAttrCount: number;
  /** <text> contents, inner tags stripped, trimmed, de-duped. */
  textLabels: string[];
  inlineScripts: number;
  externalScripts: number;
  externalRefs: ExternalRef[];
  /** subset of externalRefs whose absence breaks offline rendering. */
  requiredExternalRefs: ExternalRef[];
}

/** External hosts that are cosmetic/help-only (system-font fallback exists). */
const OPTIONAL_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "tt-a1i.github.io"];

/** Extract the lowercase hostname from a URL-ish string. Strips the scheme,
 *  then takes everything up to the first `/`, `?`, or `#`. Returns "" for
 *  schemeless/relative URLs so they never match an OPTIONAL_HOST. */
function hostOf(url: string): string {
  const noScheme = url.replace(/^https?:\/\//i, "").replace(/^\/\//, "");
  return noScheme.split(/[/?#]/)[0]!.toLowerCase();
}

function isOptional(url: string): boolean {
  const host = hostOf(url);
  return OPTIONAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function inspectArtifact(html: string): ArtifactFacts {
  const bytes = html.length;
  const hasDoctype = /^\s*<!doctype html>/i.test(html);
  const hasSvg = /<svg\b/i.test(html);
  const svgViewBox = /<svg[^>]*\bviewBox="([^"]*)"/i.exec(html)?.[1];
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const generator = /<meta[^>]*name="generator"[^>]*content="([^"]*)"/i.exec(html)?.[1];

  const kindMatches = [...html.matchAll(/data-kind="([^"]*)"/g)];
  const dataKinds = [...new Set(kindMatches.map((m) => m[1]!))];
  const dataKindAttrCount = kindMatches.length;

  const textMatches = [...html.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)];
  const textLabels = [
    ...new Set(
      textMatches
        .map((m) => m[1]!.replace(/<[^>]*>/g, "").trim())
        .filter((t) => t.length > 0),
    ),
  ];

  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]!);
  const externalScripts = scriptTags.filter((s) => /\bsrc=/i.test(s)).length;
  const inlineScripts = scriptTags.length - externalScripts;

  const externalRefs: ExternalRef[] = [];

  for (const m of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)]) {
    const url = m[1]!;
    externalRefs.push({ kind: "script", url, blocking: !isOptional(url) });
  }
  for (const m of [...html.matchAll(/<link\b[^>]*>/gi)]) {
    const tag = m[0];
    const href = /href="([^"]*)"/i.exec(tag)?.[1];
    if (!href || !/^https?:\/\//i.test(href)) continue;
    const rel = /rel="([^"]*)"/i.exec(tag)?.[1] ?? "";
    const kind: ExternalRef["kind"] = /preconnect|dns-prefetch/i.test(rel)
      ? "preconnect"
      : "stylesheet";
    externalRefs.push({ kind, url: href, blocking: !isOptional(href) });
  }
  for (const m of [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi)]) {
    const url = m[1]!;
    externalRefs.push({ kind: "image", url, blocking: !isOptional(url) });
  }
  for (const m of [...html.matchAll(/<a\b[^>]*\bhref="(https?:[^"]*)"/gi)]) {
    const url = m[1]!;
    externalRefs.push({ kind: "anchor", url, blocking: !isOptional(url) });
  }

  const requiredExternalRefs = externalRefs.filter((r) => r.blocking);

  return {
    bytes, hasDoctype, hasSvg, svgViewBox, title, generator,
    dataKinds, dataKindAttrCount, textLabels, inlineScripts, externalScripts,
    externalRefs, requiredExternalRefs,
  };
}
