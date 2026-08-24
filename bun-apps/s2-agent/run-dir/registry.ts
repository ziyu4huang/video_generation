/**
 * registry.ts — the validation authority over src/registry-config.ts.
 *
 * Since ticket 02 (.planning/2026-08-24-registry-code-as-config/) the typed
 * REGISTRY in src/registry-config.ts is the data; THIS module owns the
 * invariants: `loadRegistry()` validates the typed entries (the checks the
 * YAML parser used to enforce at parse time — disk existence, duplicate
 * names/orders, deploy/excludeReason contradictions, vendor overlaps) and
 * returns the legacy `Registry` shape the emitter and tests consume. The
 * validation lives here and not in registry-config.ts because it needs
 * node:fs, and that module is zero-import by contract (map D4).
 *
 * `parseRegistry(text)` below is the RETIRED-BRIDGE YAML parser, kept only so
 * devops (`parseShConfig`) and `ext new` keep working until ticket 03 flips
 * them; ticket 04 deletes it together with s2-agent.registry.yaml. It stays
 * byte-for-byte the old authority — do not extend it.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { REGISTRY, registryToLegacyShapes } from "../src/registry-config.ts";

export interface RegistryDeployBlock {
  order: number;
  copy: string[]; // default []
  vendor: string[]; // default []
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
  lazyExtensions: Record<string, string>;
}

const TOP_KEYS = new Set(["deploy", "hostApi", "hostModules", "extensions", "lazyExtensions"]);
const DEPLOY_KEYS = new Set(["outRoot", "version", "freeze", "current", "keep"]);
const EXT_KEYS = new Set(["name", "package", "entry", "load", "skills", "version", "excludeReason", "deploy"]);
const DEPLOY_BLOCK_KEYS = new Set(["order", "copy", "vendor", "externals", "vendorExclude", "enabled"]);

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Container-typed keys must be mappings. A YAML list or scalar here would
 * otherwise sail through the key loops (Object.keys of a list yields index
 * strings) and be cast to the wrong shape — the silent-typo failure mode
 * this parser exists to reject.
 */
function requireMapping(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`registry key "${key}" must be a mapping`);
  }
  return value as Record<string, unknown>;
}

/**
 * @deprecated Retired bridge (ticket 02): parses s2-agent.registry.yaml text.
 * Remaining callers are devops `parseShConfig` and `ext new` — both flip in
 * ticket 03; ticket 04 deletes this function with the YAML. New code uses
 * `loadRegistry()`.
 */
export function parseRegistry(text: string, opts: { bunAppsDir: string }): Registry {
  const raw = Bun.YAML.parse(text) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("s2-agent.registry.yaml must be a YAML mapping");
  }
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) throw new Error(`unknown registry key "${k}" (known: ${[...TOP_KEYS].join(", ")})`);
  }

  const deployRaw = requireMapping(raw.deploy, "deploy");
  for (const k of Object.keys(deployRaw)) {
    if (!DEPLOY_KEYS.has(k)) throw new Error(`unknown deploy key "${k}" (known: ${[...DEPLOY_KEYS].join(", ")})`);
  }
  if (typeof deployRaw.outRoot !== "string" || deployRaw.outRoot.length === 0) {
    throw new Error(`deploy key "outRoot" is required and must be a string`);
  }
  const outRoot = expandHome(deployRaw.outRoot);
  if (!isAbsolute(outRoot)) throw new Error(`outRoot must resolve to an absolute path, got "${outRoot}"`);

  const versionRaw = requireMapping(deployRaw.version, "deploy.version");
  for (const k of Object.keys(versionRaw)) {
    if (k !== "from" && k !== "gitSha") throw new Error(`unknown version key "${k}" (known: from, gitSha)`);
  }
  if (versionRaw.from !== undefined && versionRaw.from !== "package.json") {
    throw new Error(`version.from currently supports only "package.json"`);
  }
  if (versionRaw.gitSha !== undefined && typeof versionRaw.gitSha !== "boolean") {
    throw new Error(`version.gitSha must be a boolean`);
  }
  if (deployRaw.freeze !== undefined && typeof deployRaw.freeze !== "boolean") {
    throw new Error(`deploy key "freeze" must be a boolean`);
  }
  if (deployRaw.current !== undefined && typeof deployRaw.current !== "boolean") {
    throw new Error(`deploy key "current" must be a boolean`);
  }
  if (
    deployRaw.keep !== undefined &&
    (typeof deployRaw.keep !== "number" || !Number.isInteger(deployRaw.keep) || deployRaw.keep < 1)
  ) {
    throw new Error(`deploy key "keep" must be an integer >= 1`);
  }

  if (typeof raw.hostApi !== "number" || !Number.isInteger(raw.hostApi)) {
    throw new Error(`registry key "hostApi" is required and must be an integer`);
  }
  if (
    !Array.isArray(raw.hostModules) ||
    raw.hostModules.length === 0 ||
    !raw.hostModules.every((m) => typeof m === "string")
  ) {
    throw new Error(`registry key "hostModules" is required and must be a non-empty array of strings`);
  }

  if (!Array.isArray(raw.extensions) || raw.extensions.length === 0) {
    throw new Error(`registry key "extensions" must list at least one extension`);
  }

  const lazyRaw = requireMapping(raw.lazyExtensions, "lazyExtensions");
  for (const [k, v] of Object.entries(lazyRaw)) {
    if (typeof v !== "string") throw new Error(`lazyExtensions["${k}"] must be a string`);
  }

  const seenNames = new Set<string>();
  const seenOrders = new Map<number, string>();
  const extensions: RegistryExt[] = raw.extensions.map((e, i) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`extensions[${i}] must be a mapping`);
    }
    const ext = e as Record<string, unknown>;
    for (const k of Object.keys(ext)) {
      if (!EXT_KEYS.has(k)) throw new Error(`unknown extension key "${k}" (known: ${[...EXT_KEYS].join(", ")})`);
    }
    for (const field of ["name", "package", "entry"]) {
      if (typeof ext[field] !== "string" || (ext[field] as string).length === 0) {
        throw new Error(`extensions[${i}].${field} is required and must be a string`);
      }
    }
    const name = ext.name as string;
    if (seenNames.has(name)) throw new Error(`duplicate extension name "${name}"`);
    seenNames.add(name);

    if (ext.load !== "static" && ext.load !== "dynamic") {
      throw new Error(`extensions[${i}].load must be "static" or "dynamic"`);
    }
    const load = ext.load;

    const skills = ext.skills === undefined ? false : ext.skills;
    if (typeof skills !== "boolean") throw new Error(`extensions[${i}].skills must be a boolean`);

    if (ext.version !== undefined && typeof ext.version !== "string") {
      throw new Error(`extensions[${i}].version must be a string`);
    }

    if (ext.excludeReason !== undefined && (typeof ext.excludeReason !== "string" || ext.excludeReason.length === 0)) {
      throw new Error(`extensions[${i}].excludeReason must be a non-empty string`);
    }

    const pkgDir = resolve(opts.bunAppsDir, ext.package as string);
    if (!existsSync(pkgDir)) throw new Error(`extensions[${i}] package dir not found: ${pkgDir}`);
    const entryAbs = resolve(pkgDir, ext.entry as string);
    if (!existsSync(entryAbs)) throw new Error(`extensions[${i}] entry not found: ${entryAbs}`);

    let deploy: RegistryDeployBlock | undefined;
    if (ext.deploy !== undefined) {
      const d = ext.deploy as Record<string, unknown>;
      if (d === null || typeof d !== "object" || Array.isArray(d)) {
        throw new Error(`extensions[${i}].deploy must be a mapping`);
      }
      for (const k of Object.keys(d)) {
        if (!DEPLOY_BLOCK_KEYS.has(k)) {
          throw new Error(`unknown deploy block key "${k}" (known: ${[...DEPLOY_BLOCK_KEYS].join(", ")})`);
        }
      }
      if (typeof d.order !== "number" || !Number.isInteger(d.order)) {
        throw new Error(`extensions[${i}].deploy.order is required and must be an integer`);
      }
      const prior = seenOrders.get(d.order);
      if (prior !== undefined) {
        throw new Error(`extensions[${i}] ("${name}") deploy order ${d.order} duplicates "${prior}"`);
      }
      seenOrders.set(d.order, name);
      const strArray = (key: string): string[] => {
        const v = d[key] === undefined ? [] : d[key];
        if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
          throw new Error(`extensions[${i}].deploy.${key} must be an array of strings`);
        }
        return v as string[];
      };
      const enabled = d.enabled === undefined ? true : d.enabled;
      if (typeof enabled !== "boolean") {
        throw new Error(`extensions[${i}].deploy.enabled must be a boolean`);
      }
      const copy = strArray("copy");
      const vendor = strArray("vendor");
      const externals = strArray("externals");
      const vendorExclude = strArray("vendorExclude");
      // A package in both lists is a silent wrong-build class: vendored means
      // "shipped as a real directory", external means "not shipped" — the
      // build would honour whichever it reads last. (Carried over from the
      // retired parseShConfig, which threw the same way.)
      const overlap = vendor.filter((p) => externals.includes(p));
      if (overlap.length > 0) {
        throw new Error(
          `extensions[${i}] ("${name}") declares package(s) both vendored and external: ${overlap.join(", ")}`,
        );
      }
      // Same contradiction one level down: vendorExclude drops CLOSURE deps, so
      // a vendor root matching it asks to ship and drop the same package.
      // Exact matches only — a `@scope/*` exclude against a root inside that
      // scope is exactly the thing being ruled out, and patterns against
      // patterns (`@scope/*` vs `@scope/*`) have no meaning.
      const excludedRoots = vendor.filter(
        (p) => vendorExclude.includes(p) || vendorExclude.some((e) => e.endsWith("/*") && p.startsWith(e.slice(0, -1))),
      );
      if (excludedRoots.length > 0) {
        throw new Error(
          `extensions[${i}] ("${name}") declares vendor root(s) that vendorExclude also drops: ${excludedRoots.join(", ")}`,
        );
      }
      deploy = {
        order: d.order,
        copy,
        vendor,
        externals,
        vendorExclude,
        enabled,
      };
    } else if (ext.excludeReason === undefined) {
      throw new Error(
        `extensions[${i}] ("${name}") has no deploy block — excludeReason is required to say why it is not deployed`,
      );
    }

    return {
      name,
      package: ext.package as string,
      entry: ext.entry as string,
      load,
      skills,
      version: ext.version as string | undefined,
      excludeReason: ext.excludeReason as string | undefined,
      deploy,
    };
  });

  // Checked after per-entry validation so a duplicate order wins over the
  // contradiction below when both apply — the order collision is the louder bug.
  for (const ext of extensions) {
    if (ext.deploy !== undefined && ext.excludeReason !== undefined) {
      throw new Error(
        `extension "${ext.name}" has both a deploy block and excludeReason — they contradict: either it ships or it does not`,
      );
    }
  }

  return {
    deploy: {
      outRoot,
      version: {
        from: "package.json",
        gitSha: versionRaw.gitSha === undefined ? true : versionRaw.gitSha === true,
      },
      freeze: deployRaw.freeze === undefined ? true : deployRaw.freeze === true,
      current: deployRaw.current === undefined ? true : deployRaw.current === true,
      ...(deployRaw.keep !== undefined ? { keep: deployRaw.keep } : {}),
    },
    hostApi: raw.hostApi,
    hostModules: raw.hostModules as string[],
    extensions,
    lazyExtensions: lazyRaw as Record<string, string>,
  };
}

// ─── Validation over REGISTRY (the new authority read path) ──────────────────

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
      const externals = e.deploy.externals ?? [];
      const vendorExclude = e.deploy.vendorExclude ?? [];
      const overlap = vendor.filter((p) => externals.includes(p));
      if (overlap.length > 0) {
        throw new Error(`extensions[${i}] ("${e.name}") declares package(s) both vendored and external: ${overlap.join(", ")}`);
      }
      const excludedRoots = vendor.filter(
        (p) => vendorExclude.includes(p) || vendorExclude.some((x) => x.endsWith("/*") && p.startsWith(x.slice(0, -1))),
      );
      if (excludedRoots.length > 0) {
        throw new Error(`extensions[${i}] ("${e.name}") declares vendor root(s) that vendorExclude also drops: ${excludedRoots.join(", ")}`);
      }
    }
  }

  const { registry } = registryToLegacyShapes({ home: homedir() });
  if (!isAbsolute(registry.deploy.outRoot)) {
    throw new Error(`outRoot must resolve to an absolute path, got "${registry.deploy.outRoot}"`);
  }
  return registry;
}
