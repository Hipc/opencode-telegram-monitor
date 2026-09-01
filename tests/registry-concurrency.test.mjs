// tests/registry-concurrency.test.mjs
//
// 并发行为测试：ProjectRegistryStore.mutate() 的跨进程 PollerLock 语义。
// 契约：docs/modules/projects-registry.md §6（LOCK-001~005，唯一权威）。
// 每个独立 ProjectRegistryStore 实例是独立的锁 owner（各自内嵌 PollerLock，
// ownerId 互异）——用「多个独立实例共享同一 filePath」模拟多进程并发。
//
// 用例全部使用 mkdtemp 临时目录隔离，绝不触碰真实 ~/.otg。
// 运行：bun tests/registry-concurrency.test.mjs

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const registryURL = new URL("../src/registry/index.ts", import.meta.url);
const lockURL = new URL("../src/infra/poller-lock.ts", import.meta.url);
const { ProjectRegistryStore, registerProject } = await import(registryURL.href);
const { PollerLock } = await import(lockURL.href);

let failures = 0;
const total = 5;

async function runCase(name, fn) {
  const baseDir = await mkdtemp(join(tmpdir(), "otg-registry-concurrency-"));
  try {
    await fn(baseDir);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

// LOCK-001: ≥10 个独立 store 实例并发 mutate，无丢失更新。
// 1) 各实例注册唯一路径条目 -> 最终读回恰 10 条；
// 2) 强校验：N 次并发「读→改→写」计数器，终值必须等于 N。
await runCase("LOCK-001 concurrent stores: no lost updates", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const stores = Array.from(
    { length: 10 },
    () => new ProjectRegistryStore(filePath),
  );

  await Promise.all(
    stores.map((store, i) =>
      store.mutate((reg) =>
        registerProject(reg, join(baseDir, "project", `p-${i}`)),
      ),
    ),
  );

  const reader = new ProjectRegistryStore(filePath);
  const reg = await reader.read();
  if (reg.projects.length !== 10) {
    throw new Error(
      `expected 10 entries, got ${reg.projects.length}: ` +
        JSON.stringify(reg.projects.map((e) => e.path)),
    );
  }

  // 读→改→写计数器：addedAt 字段存数值字符串（测试脚手架，非业务用途）。
  const COUNTER_PATH = join(baseDir, "__counter__");
  const bump = (store) =>
    store.mutate((r) => {
      const current = Number(
        r.projects.find((e) => e.path === COUNTER_PATH)?.addedAt ?? "0",
      );
      const rest = r.projects.filter((e) => e.path !== COUNTER_PATH);
      return {
        projects: [
          ...rest,
          { path: COUNTER_PATH, enabled: false, addedAt: String(current + 1) },
        ],
      };
    });
  const attempts = 15;
  await Promise.all(
    Array.from({ length: attempts }, (_, i) => bump(stores[i % stores.length])),
  );
  const finalReg = await reader.read();
  const counter = Number(
    finalReg.projects.find((e) => e.path === COUNTER_PATH)?.addedAt ?? "0",
  );
  if (counter !== attempts) {
    throw new Error(
      `counter lost updates: expected ${attempts}, got ${counter}`,
    );
  }
});

// LOCK-002: 实例 A mutate 持锁期间，另一实例 B 的 read() 立即返回
// （<100ms 量级）、返回可解析注册表、且不等待锁释放、不抛错。
await runCase("LOCK-002 read() not blocked by held lock", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const storeA = new ProjectRegistryStore(filePath);
  const storeB = new ProjectRegistryStore(filePath);
  await storeA.mutate((reg) => registerProject(reg, join(baseDir, "seed")));

  let bReadPromise;
  let fnEnteredResolve;
  const fnEntered = new Promise((resolve) => {
    fnEnteredResolve = resolve;
  });
  const aMutate = storeA.mutate((reg) => {
    bReadPromise = storeB.read(); // A 持锁期间发起 B 的读
    fnEnteredResolve();
    return registerProject(reg, join(baseDir, "locked-write"));
  });
  await fnEntered; // A 已进入临界区（锁被持有）

  const t0 = Date.now();
  const reg = await bReadPromise;
  const readMs = Date.now() - t0;
  const aResult = await aMutate;

  if (readMs >= 100) {
    throw new Error(
      `read() blocked ${readMs}ms while lock held (should be immediate)`,
    );
  }
  if (!Array.isArray(reg.projects) || reg.projects.length < 1) {
    throw new Error(`read() returned unparseable registry: ${JSON.stringify(reg)}`);
  }
  if (aResult === undefined) {
    throw new Error("A's mutate unexpectedly returned undefined");
  }
});

// LOCK-003: 他人持锁不释放时，mutate 约 3s 后返回 undefined、不抛错；
// 锁释放后再次 mutate 成功返回注册表。
await runCase("LOCK-003 acquire timeout returns undefined", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const holder = new PollerLock(`${filePath}.lock`); // 模拟 A 持锁不释放
  if (!(await holder.tryAcquire())) {
    throw new Error("test could not acquire holder lock");
  }
  const store = new ProjectRegistryStore(filePath);
  const t0 = Date.now();
  let result;
  let thrown;
  try {
    result = await store.mutate((reg) =>
      registerProject(reg, join(baseDir, "w")),
    );
  } catch (error) {
    thrown = error;
  }
  const elapsed = Date.now() - t0;
  if (thrown) {
    throw new Error(`mutate threw instead of timing out: ${thrown.message}`);
  }
  if (result !== undefined) {
    throw new Error(
      `expected undefined on acquire timeout, got ${JSON.stringify(result)}`,
    );
  }
  if (elapsed < 2_800 || elapsed > 4_500) {
    throw new Error(`timeout elapsed ${elapsed}ms, expected ~3000ms`);
  }
  await holder.release();
  const second = await store.mutate((reg) =>
    registerProject(reg, join(baseDir, "w")),
  );
  if (second === undefined || second.projects.length !== 1) {
    throw new Error(`mutate after release failed: ${JSON.stringify(second)}`);
  }
});

// LOCK-004: 预置死进程 pid 的锁文件（LockInfo JSON，host=本机 hostname），
// mutate 越过 stale 锁成功并写盘。
await runCase("LOCK-004 stale lock (dead pid) reclaimed", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: 2 ** 31 - 1, // 不存在于本机的 pid -> isStale 判定为死进程
      host: hostname(),
      ownerId: "dead-owner",
      createdAt: Date.now(),
    }),
    "utf8",
  );

  const store = new ProjectRegistryStore(filePath);
  const result = await store.mutate((reg) =>
    registerProject(reg, join(baseDir, "stale-ok")),
  );
  if (result === undefined) {
    throw new Error("mutate failed to reclaim stale lock");
  }
  if (result.projects.length !== 1) {
    throw new Error(
      `unexpected registry after stale reclaim: ${JSON.stringify(result)}`,
    );
  }
  if (existsSync(lockPath)) {
    throw new Error("lock file not removed after mutate");
  }
  const reg = await store.read();
  if (reg.projects.length !== 1) {
    throw new Error("registry not persisted after stale reclaim");
  }
});

// LOCK-005: mutate 回调抛错 -> 错误向上传播且锁先 release；
// 随后（另一实例）mutate 正常成功（锁未被卡死）。
await runCase("LOCK-005 thrown callback releases lock", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const storeA = new ProjectRegistryStore(filePath);
  const storeB = new ProjectRegistryStore(filePath);

  let thrown;
  try {
    await storeA.mutate(() => {
      throw new Error("boom");
    });
  } catch (error) {
    thrown = error;
  }
  if (!thrown || thrown.message !== "boom") {
    throw new Error(`expected mutation error to propagate, got ${thrown}`);
  }

  const result = await storeB.mutate((reg) =>
    registerProject(reg, join(baseDir, "after-crash")),
  );
  if (result === undefined || result.projects.length !== 1) {
    throw new Error(`mutate after thrown callback failed: ${JSON.stringify(result)}`);
  }
  if (existsSync(`${filePath}.lock`)) {
    throw new Error("lock file not released after thrown callback");
  }
});

const passed = total - failures;
console.log(`\n${passed}/${total} cases passed`);
process.exit(failures === 0 ? 0 : 1);