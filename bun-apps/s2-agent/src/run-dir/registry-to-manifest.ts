/**
 * registry-to-manifest.ts — pure emitter: Registry → manifest.json object/text.
 *
 * manifest.json is a DERIVED artifact; this module is the only thing that
 * decides its shape (schema-cost discovery, run-dir loading and deploy all
 * read what lands here). No node:fs — the regen script owns I/O.
 */
import type { Registry } from "./registry.ts";

export interface ManifestJson {
  $generated: string; // "from src/registry-config.ts by regen:manifest — do not edit" — the byte-identical manifest gate freezes it
  extensions: Array<{ name: string; entry: string; version?: string }>; // load:dynamic, entry = "<package>/<entry>"
  skills: string[]; // "<package>/skills" for skills:true (registry order)
  staticExtensions: string[]; // package names for load:static (registry order)
}

export function buildManifestObject(r: Registry): ManifestJson {
  const byLoad = (load: "static" | "dynamic") => r.extensions.filter((e) => e.load === load);
  return {
    $generated: "from src/registry-config.ts by regen:manifest — do not edit",
    extensions: byLoad("dynamic").map((e) => {
      const entry: { name: string; entry: string; version?: string } = {
        name: e.name,
        entry: `${e.package}/${e.entry}`,
      };
      if (e.version !== undefined) entry.version = e.version;
      return entry;
    }),
    skills: r.extensions.filter((e) => e.skills).map((e) => `${e.package}/skills`),
    staticExtensions: byLoad("static").map((e) => e.package),
  };
}

/** Byte-stable serialisation: JSON.stringify(obj, null, "\t") + trailing newline. */
export function manifestText(obj: ManifestJson): string {
  return JSON.stringify(obj, null, "\t") + "\n";
}
