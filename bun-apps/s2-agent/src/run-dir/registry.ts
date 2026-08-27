/**
 * registry.ts — the validation authority over src/registry-config.ts.
 *
 * Since ticket 04 (.planning/2026-08-24-registry-code-as-config/) the typed
 * REGISTRY in src/registry-config.ts is the ONLY registry; the retired YAML
 * registry and its parseRegistry bridge are deleted. THIS module
 * owns the invariants that need node:fs (which src/registry-config.ts forbids
 * by contract — map D4, zero imports): `loadRegistry()` validates the typed
 * entries — disk existence, duplicate names/orders, deploy/excludeReason
 * contradictions, vendor overlaps — and returns the legacy `Registry` shape
 * the emitter, tests, and devops' ShConfig projection consume.
 *
 * The checks here are the checks the YAML parser enforced at parse time; the
 * failure modes rejected are the same.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { REGISTRY, legacyRegistry } from "../registry-config.ts";

export interface RegistryDeployAsset {
  pkg: string;
  from: string;
  to: string;
}
export interface RegistryDeployBlock {
  order: number;
  copy: string[]; // default []
  vendor: string[]; // default []
  assets: RegistryDeployAsset[]; // default [] — npm payloads under <ext>/<to>, code bundles
  externals: string[]; // default []
  vendorExclude: string[]; // default [] — closure deps deliberately not shipped
  enabled: boolean; // default true
}
export interface RegistryExt {
  name: string; // "task"
  package: string; // "s2-agent-ext-task"
  entry: string; // package-relative: "extensions/task.ts"
  load: "static" | "dynamic";
  skills: boolean; // ships <package>/skills → manifest skills[]
  version?: string; // emitted on dynamic entries when present
  excludeReason?: string; // REQUIRED when deploy block is absent
  platforms?: string[]; // crossos-deploy D5 — target platforms; absent = portable
  deploy?: RegistryDeployBlock;
}
export interface Registry {
  deploy: {
    outRoot: string;
    version: { from: "package.json"; gitSha: boolean };
    freeze: boolean;
    current: boolean;
    /** Version dirs to retain when pruning (deploy Phase 3); undefined = deploy default. */
    keep?: number;
  };
  hostApi: number;
  hostModules: string[];
  extensions: RegistryExt[];
}

// ─── Validation over REGISTRY (the authority read path) ─────────────────────

/**
 * Validate the typed REGISTRY and return the legacy `Registry` shape.
 *
 * Every check the YAML parser enforced at parse time is enforced here over
 * the typed data instead — the failure modes rejected are the same: an entry
 * that points at a package/entry not on disk, duplicate names or deploy
 * orders, a deploy block contradicting excludeReason, vendor/externals/
 * vendorExclude overlaps, and (typed-only, map D2) a disabled entry missing
 * its disableReason/reEnableNote paper trail.
 */
export function loadRegistry(opts: { bunAppsDir: string }): Registry {
  const seenNames = new Set<string>();
  const seenOrders = new Map<number, string>();
  for (const [i, e] of REGISTRY.entries()) {
    if (e.name.length === 0) throw new Error(`REGISTRY[${i}].name must be a non-empty string`);
    if (seenNames.has(e.name)) throw new Error(`duplicate extension name "${e.name}"`);
    seenNames.add(e.name);

    const pkgDir = resolve(opts.bunAppsDir, e.package);
    if (!existsSync(pkgDir)) throw new Error(`extensions[${i}] ("${e.name}") package dir not found: ${pkgDir}`);
    const entryAbs = resolve(pkgDir, e.entry);
    if (!existsSync(entryAbs)) throw new Error(`extensions[${i}] ("${e.name}") entry not found: ${entryAbs}`);

    if (e.enabled && e.deploy === undefined && e.excludeReason === undefined) {
      throw new Error(`extensions[${i}] ("${e.name}") has no deploy block — excludeReason is required to say why it is not deployed`);
    }
    // crossos-deploy D5 (ticket 08): platforms must be process.platform
    // spellings the deploy targets can match, with no duplicates.
    if (e.platforms !== undefined) {
      const KNOWN_PLATFORMS = new Set(["darwin", "linux", "win32"]);
      for (const p of e.platforms) {
        if (!KNOWN_PLATFORMS.has(p)) {
          throw new Error(`extensions[${i}] ("${e.name}") platforms value "${p}" is not a known process.platform (darwin|linux|win32)`);
        }
      }
      if (new Set(e.platforms).size !== e.platforms.length) {
        throw new Error(`extensions[${i}] ("${e.name}") platforms has duplicate values`);
      }
    }
    if (e.enabled && e.deploy !== undefined && e.excludeReason !== undefined) {
      throw new Error(`extension "${e.name}" has both a deploy block and excludeReason — they contradict: either it ships or it does not`);
    }
    if (!e.enabled) {
      // Map D2: disabled entries are values, not deletions — but only as long
      // as the reason + re-enable path stay attached as data.
      if (!e.disableReason || e.disableReason.length === 0) {
        throw new Error(`extensions[${i}] ("${e.name}") is enabled: false — disableReason is required`);
      }
      if (!e.reEnableNote || e.reEnableNote.length === 0) {
        throw new Error(`extensions[${i}] ("${e.name}") is enabled: false — reEnableNote is required`);
      }
    }

    if (e.deploy !== undefined) {
      if (!Number.isInteger(e.deploy.order)) {
        throw new Error(`extensions[${i}] ("${e.name}") deploy.order must be an integer`);
      }
      const prior = seenOrders.get(e.deploy.order);
      if (prior !== undefined) {
        throw new Error(`extensions[${i}] ("${e.name}") deploy order ${e.deploy.order} duplicates "${prior}"`);
      }
      seenOrders.set(e.deploy.order, e.name);

      const vendor = e.deploy.vendor ?? [];
      const assets = e.deploy.assets ?? [];
      const externals = e.deploy.externals ?? [];
      const vendorExclude = e.deploy.vendorExclude ?? [];
      const overlap = vendor.filter((p) => externals.includes(p));
      if (overlap.length > 0) {
        throw new Error(`extensions[${i}] ("${e.name}") declares package(s) both vendored and external: ${overlap.join(", ")}`);
      }
      // An asset's package in `vendor` too is a contradiction: vendor ships the
      // whole package under node_modules/, assets exist to avoid exactly that.
      const assetVendorOverlap = [...new Set(assets.map((a) => a.pkg))].filter((p) => vendor.includes(p));
      if (assetVendorOverlap.length > 0) {
        throw new Error(
          `extensions[${i}] ("${e.name}") declares package(s) in both vendor and assets: ${assetVendorOverlap.join(", ")} — vendor the package OR extract its assets, not both`,
        );
      }
      const seenAssetTo = new Set<string>();
      for (const a of assets) {
        if (!a.pkg || !a.from || !a.to) {
          throw new Error(`extensions[${i}] ("${e.name}") deploy.assets entries need pkg, from, and to`);
        }
        if (isAbsolute(a.to) || a.to.split("/").includes("..")) {
          throw new Error(`extensions[${i}] ("${e.name}") deploy.assets to "${a.to}" must be a relative path inside the ext dir`);
        }
        if (seenAssetTo.has(a.to)) {
          throw new Error(`extensions[${i}] ("${e.name}") deploy.assets has duplicate to "${a.to}"`);
        }
        seenAssetTo.add(a.to);
      }
      const excludedRoots = vendor.filter(
        (p) => vendorExclude.includes(p) || vendorExclude.some((x) => x.endsWith("/*") && p.startsWith(x.slice(0, -1))),
      );
      if (excludedRoots.length > 0) {
        throw new Error(`extensions[${i}] ("${e.name}") declares vendor root(s) that vendorExclude also drops: ${excludedRoots.join(", ")}`);
      }
    }
  }

  const registry = legacyRegistry({ home: homedir() });
  if (!isAbsolute(registry.deploy.outRoot)) {
    throw new Error(`outRoot must resolve to an absolute path, got "${registry.deploy.outRoot}"`);
  }
  return registry;
}
