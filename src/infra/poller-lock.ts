import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { DEFAULT_TTL_MS } from "../constants";

export type LockInfo = {
  pid: number;
  host: string;
  ownerId: string;
  createdAt: number;
};

export class PollerLock {
  private owner = false;
  private readonly ownerId = randomUUID();

  constructor(
    private readonly lockPath: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  private identity(): LockInfo {
    return {
      pid: process.pid,
      host: hostname(),
      ownerId: this.ownerId,
      createdAt: Date.now(),
    };
  }

  private async readInfo(): Promise<LockInfo | undefined> {
    try {
      const value = JSON.parse(await readFile(this.lockPath, "utf8")) as LockInfo;
      if (
        typeof value?.pid === "number" &&
        typeof value?.host === "string" &&
        typeof value?.ownerId === "string" &&
        typeof value?.createdAt === "number"
      ) {
        return value;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private pidAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async fileIsStale() {
    try {
      const value = await stat(this.lockPath);
      return Date.now() - value.mtimeMs > this.ttlMs;
    } catch {
      return true;
    }
  }

  private async isStale(info: LockInfo | undefined) {
    if (info?.host === hostname() && !this.pidAlive(info.pid)) return true;
    return await this.fileIsStale();
  }

  private async acquireExclusive(): Promise<boolean> {
    const handle = await open(this.lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(this.identity()), "utf8");
    } finally {
      await handle.close();
    }
    this.owner = true;
    return true;
  }

  async tryAcquire(): Promise<boolean> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    try {
      return await this.acquireExclusive();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }

    const info = await this.readInfo();
    if (info?.ownerId === this.ownerId) {
      this.owner = true;
      return true;
    }
    if (!(await this.isStale(info))) return false;

    try {
      await rm(this.lockPath, { force: true });
      return await this.acquireExclusive();
    } catch {
      return false;
    }
  }

  async touch() {
    if (!this.owner) return;
    try {
      const info = await this.readInfo();
      if (info?.ownerId !== this.ownerId) {
        this.owner = false;
        return;
      }
      const now = new Date();
      await utimes(this.lockPath, now, now);
    } catch {
      this.owner = false;
    }
  }

  async release() {
    if (!this.owner) return;
    this.owner = false;
    try {
      const info = await this.readInfo();
      if (info?.ownerId === this.ownerId) {
        await rm(this.lockPath, { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}
