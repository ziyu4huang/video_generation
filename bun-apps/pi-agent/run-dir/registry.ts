/**
 * registry.ts — the ONE parser for pi-agent.registry.yaml.
 *
 * The registry replaces both deploy-config.yaml and hand-maintained
 * manifest.json (which becomes a DERIVED artifact — see regen-manifest.ts).
 * Schema authority lives HERE and nowhere else: the devops deploy config
 * derives ShConfig from parseRegistry(), the manifest emitter derives the
 * arrays, and a structural guard forbids a third parser of this shape.
 *
 * Strict on purpose: an unknown key is an error, not a silent no-op — the
 * failure mode this rejects is a registry typo that quietly ships (or drops)
 * an extension.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface RegistryDeployBlock {
  order: number;
  copy: string[]; // default []
  vendor: string[]; // default []
  externals: string[]; // default []
  enabled: boolean; // default true
}
export interface RegistryExt {
  name: string; // "task"
  package: string; // "pi-agent-ext-task"
  entry: string; // package-relative: "extensions/task.ts"
  load: "static" | "dynamic";
  skills: boolean; // ships <package>/skills → manifest skills[]
  binarySkills: boolean; // default false → manifest binarySkills[]
  version?: string; // emitted on dynamic entries when present
  excludeReason?: string; // REQUIRED when deploy block is absent
  deploy?: RegistryDeployBlock;
}
export interface Registry {
  deploy: { outRoot: string; version: { from: "package.json"; gitSha: boolean }; freeze: boolean; current: boolean };
  hostApi: number;
  hostModules: string[];
  extensions: RegistryExt[];
  lazyExtensions: Record<string, string>;
}

const TOP_KEYS = new Set(["deploy", "hostApi", "hostModules", "extensions", "lazyExtensions"]);
const DEPLOY_KEYS = new Set(["outRoot", "version", "freeze", "current"]);
const EXT_KEYS = new Set(["name", "package", "entry", "load", "skills", "binarySkills", "version", "excludeReason", "deploy"]);
const DEPLOY_BLOCK_KEYS = new Set(["order", "copy", "vendor", "externals", "enabled"]);

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Strict parse + validate. Throws Error with the offending key/entry in the message. */
export function parseRegistry(text: string, opts: { bunAppsDir: string }): Registry {
  const raw = Bun.YAML.parse(text) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("pi-agent.registry.yaml must be a YAML mapping");
  }
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) throw new Error(`unknown registry key "${k}" (known: ${[...TOP_KEYS].join(", ")})`);
  }

  const deployRaw = (raw.deploy ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(deployRaw)) {
    if (!DEPLOY_KEYS.has(k)) throw new Error(`unknown deploy key "${k}" (known: ${[...DEPLOY_KEYS].join(", ")})`);
  }
  if (typeof deployRaw.outRoot !== "string" || deployRaw.outRoot.length === 0) {
    throw new Error(`deploy key "outRoot" is required and must be a string`);
  }
  const outRoot = expandHome(deployRaw.outRoot);
  if (!isAbsolute(outRoot)) throw new Error(`outRoot must resolve to an absolute path, got "${outRoot}"`);

  const versionRaw = (deployRaw.version ?? {}) as Record<string, unknown>;
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

  const lazyRaw = (raw.lazyExtensions ?? {}) as Record<string, unknown>;
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
    const binarySkills = ext.binarySkills === undefined ? false : ext.binarySkills;
    if (typeof binarySkills !== "boolean") {
      throw new Error(`extensions[${i}].binarySkills must be a boolean`);
    }

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
      deploy = {
        order: d.order,
        copy: strArray("copy"),
        vendor: strArray("vendor"),
        externals: strArray("externals"),
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
      binarySkills,
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
    },
    hostApi: raw.hostApi,
    hostModules: raw.hostModules as string[],
    extensions,
    lazyExtensions: lazyRaw as Record<string, string>,
  };
}
