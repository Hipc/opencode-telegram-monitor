import { resolve, dirname } from "node:path";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";

export type RegistryEntry = {
  path: string;
  enabled: boolean;
  addedAt: string;
};

export type ProjectRegistry = {
  projects: RegistryEntry[];
};

export const EMPTY_REGISTRY: ProjectRegistry = { projects: [] };

export function normalizeRegistryPath(path: string) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function parseRegistry(text: string): ProjectRegistry | undefined {
  if (text.trim().length === 0) return { projects: [] };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const projects = (value as Record<string, unknown>).projects;
    if (projects === undefined) return { projects: [] };
    if (!Array.isArray(projects)) return undefined;
    const entries: RegistryEntry[] = [];
    for (const item of projects) {
      const rec =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined;
      const path = typeof rec?.path === "string" ? rec.path : undefined;
      if (!path) return undefined;
      entries.push({
        path,
        enabled: rec.enabled === true,
        addedAt:
          typeof rec.addedAt === "string"
            ? rec.addedAt
            : new Date().toISOString(),
      });
    }
    return { projects: entries };
  } catch {
    return undefined;
  }
}

export function serializeRegistry(registry: ProjectRegistry) {
  return JSON.stringify(registry, null, 2);
}

export function findRegistryEntry(
  registry: ProjectRegistry,
  rootPath: string,
): RegistryEntry | undefined {
  const normalized = normalizeRegistryPath(rootPath);
  return registry.projects.find(
    (entry) => normalizeRegistryPath(entry.path) === normalized,
  );
}

export function registerProject(
  registry: ProjectRegistry,
  rootPath: string,
): ProjectRegistry {
  if (findRegistryEntry(registry, rootPath)) return registry;
  return {
    projects: [
      ...registry.projects,
      {
        path: resolve(rootPath),
        enabled: false,
        addedAt: new Date().toISOString(),
      },
    ],
  };
}

/**
 * 路径的稳定短 token（callback_data 用，避免位置序号在多实例下错位）。
 * 归一化路径 -> sha1 前 12 位 hex。同机同路径恒定，跨实例一致。
 */
export function entryToken(rootPath: string) {
  const normalized = normalizeRegistryPath(rootPath);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function findEntryByToken(
  registry: ProjectRegistry,
  token: string,
): RegistryEntry | undefined {
  return registry.projects.find((entry) => entryToken(entry.path) === token);
}

/**
 * 幂等设值：目标状态与当前一致时返回原引用（无写入）；路径不存在返回 undefined。
 */
export function setProjectEnabled(
  registry: ProjectRegistry,
  rootPath: string,
  enabled: boolean,
): ProjectRegistry | undefined {
  const normalized = normalizeRegistryPath(rootPath);
  const index = registry.projects.findIndex(
    (entry) => normalizeRegistryPath(entry.path) === normalized,
  );
  if (index === -1) return undefined;
  if (registry.projects[index]!.enabled === enabled) return registry;
  const projects = registry.projects.slice();
  projects[index] = { ...projects[index]!, enabled };
  return { projects };
}

/**
 * 幂等删除：路径不存在时返回原引用（视为已删除，无写入）。
 */
export function deleteProjectByPath(
  registry: ProjectRegistry,
  rootPath: string,
): ProjectRegistry {
  const normalized = normalizeRegistryPath(rootPath);
  const next = {
    projects: registry.projects.filter(
      (entry) => normalizeRegistryPath(entry.path) !== normalized,
    ),
  };
  return next.projects.length === registry.projects.length ? registry : next;
}

export class ProjectRegistryStore {
  private cache?: { key: string; registry: ProjectRegistry };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger?: (message: string) => Promise<void> | void,
  ) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async logWarn(message: string) {
    try {
      await this.logger?.(message);
    } catch {
      /* ignore */
    }
  }

  private async statKey(): Promise<string | undefined> {
    try {
      const st = await stat(this.filePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }

  async ensureDir() {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  async read(): Promise<ProjectRegistry> {
    const key = await this.statKey();
    if (this.cache && this.cache.key === key) return this.cache.registry;
    let registry: ProjectRegistry = EMPTY_REGISTRY;
    if (key !== undefined) {
      let text = "";
      try {
        text = await readFile(this.filePath, "utf8");
      } catch {
        text = "";
      }
      const parsed = parseRegistry(text);
      if (parsed) {
        registry = parsed;
      } else {
        await this.logWarn(
          "projects.json parse failed; treated as empty until next write repairs it",
        );
      }
    }
    this.cache = { key: key ?? "missing", registry };
    return registry;
  }

  async isEnabled(rootPath: string) {
    const registry = await this.read();
    return findRegistryEntry(registry, rootPath)?.enabled ?? false;
  }

  async mutate(
    fn: (reg: ProjectRegistry) => ProjectRegistry | undefined,
  ): Promise<ProjectRegistry | undefined> {
    return this.serialized(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const beforeKey = await this.statKey();
        let registry: ProjectRegistry = EMPTY_REGISTRY;
        let hadParseError = false;
        if (beforeKey !== undefined) {
          let text = "";
          try {
            text = await readFile(this.filePath, "utf8");
          } catch {
            text = "";
          }
          const parsed = parseRegistry(text);
          if (parsed) {
            registry = parsed;
          } else if (text.trim().length > 0) {
            hadParseError = true;
          }
        }
        if (hadParseError) {
          try {
            await copyFile(this.filePath, `${this.filePath}.bak`);
            await this.logWarn(
              "projects.json was corrupt; backed up to projects.json.bak",
            );
          } catch {
            await this.logWarn("projects.json was corrupt; backup failed");
          }
        }
        const next = fn(registry);
        if (next === undefined) return undefined;
        if (next === registry && !hadParseError) {
          // 幂等无变化：不写盘，仅刷新缓存（损坏文件时仍走写盘以修复）
          this.cache = { key: beforeKey ?? "missing", registry: next };
          return next;
        }
        const afterKey = await this.statKey();
        if (beforeKey !== afterKey && attempt < 2) continue; // 并发写者改了文件 -> 重试
        await this.writeAtomic(next);
        this.cache = {
          key: (await this.statKey()) ?? "missing",
          registry: next,
        };
        return next;
      }
      return undefined;
    });
  }

  private async writeAtomic(registry: ProjectRegistry) {
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, serializeRegistry(registry), "utf8");
    try {
      await rename(tmp, this.filePath);
      return;
    } catch {
      // Windows: rename over an existing file can raise EPERM (user-profile
      // dirs under OneDrive/AV/sync tools). Fall back to delete+rename.
    }
    try {
      await rm(this.filePath, { force: true });
      await rename(tmp, this.filePath);
      return;
    } catch {
      // Last resort: overwrite via copy (reliably replaces on Windows).
      await copyFile(tmp, this.filePath);
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
