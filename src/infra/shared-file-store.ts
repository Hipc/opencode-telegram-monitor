import { readFile, rename, writeFile } from "node:fs/promises";

import { delay } from "./delay";
import { PollerLock } from "./poller-lock";

// Cross-window shared state file read-modify-write mechanism. Reuses PollerLock
// (O_EXCL atomic creation + pidAlive/TTL crash recovery + ownerId-guarded
// release) for short critical sections: acquire -> re-read latest -> mutate ->
// atomic tmp+rename write -> release. Timeouts return undefined instead of
// throwing so the plugin never crashes opencode.

export type SharedFileStoreOptions = {
  lockTtlMs?: number;
  acquireTimeoutMs?: number;
  retryMs?: number;
};

export class SharedFileStore<T> {
  private readonly lock: PollerLock;
  private readonly acquireTimeoutMs: number;
  private readonly retryMs: number;
  // Serializes concurrent withWrite calls on the same instance. PollerLock is
  // re-entrant for a single ownerId (same process re-acquires its own lock),
  // so without this queue two overlapping withWrite calls on one instance
  // could both enter the critical section. Cross-process exclusion still
  // comes from the lock file itself.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataPath: string,
    opts?: SharedFileStoreOptions,
  ) {
    this.lock = new PollerLock(dataPath + ".lock", opts?.lockTtlMs);
    this.acquireTimeoutMs = opts?.acquireTimeoutMs ?? 3_000;
    this.retryMs = opts?.retryMs ?? 50;
  }

  async read(): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.dataPath, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async withWrite(
    mutate: (current: T | undefined) => T | undefined | Promise<T | undefined>,
  ): Promise<T | undefined> {
    const deadline = Date.now() + this.acquireTimeoutMs;
    const run = this.queue.then(() => this.withWriteLocked(mutate, deadline));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withWriteLocked(
    mutate: (current: T | undefined) => T | undefined | Promise<T | undefined>,
    deadline: number,
  ): Promise<T | undefined> {
    while (!(await this.lock.tryAcquire())) {
      if (Date.now() >= deadline) return undefined;
      await delay(this.retryMs);
    }
    try {
      const current = await this.read();
      const next = await mutate(current);
      if (next === undefined) return undefined;
      await writeFile(this.dataPath + ".tmp", JSON.stringify(next), "utf8");
      await rename(this.dataPath + ".tmp", this.dataPath);
      return next;
    } finally {
      await this.lock.release();
    }
  }
}
