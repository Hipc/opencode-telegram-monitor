// tests/poller-loop.test.mjs
//
// runTelegram 轮询循环的锁竞争集成回归测试（2026-09-06 修复）：
// 单元测试（poller-lock.test.mjs）只验证 PollerLock 类语义，这里直接实例化
// TelegramSessionMonitor 并真实调用 runTelegram()，断言轮询循环行为：
//
//   LOOP-100 锁被抢占后，成功路径 `isOwner()` 检查使轮询循环退出
//            → getUpdates 计数停止增长（修复前：循环永不退出 → 双轮询 → 409）
//   LOOP-101 getUpdates 连续失败的 catch 路径依然 touch() 刷新锁 TTL
//            → 锁文件 mtime 持续更新（修复前：失败窗口 > TTL 即被偷锁）
//
// 不触碰真实 Telegram（全局 fetch stub）；OTG_DIR 落在 temp HOME 不碰 ~/.otg。
// 运行：HOME=$(mktemp -d) bun tests/poller-loop.test.mjs

import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const monitorURL = new URL("../src/monitor.ts", import.meta.url);
const lockURL = new URL("../src/infra/poller-lock.ts", import.meta.url);
const registryURL = new URL("../src/registry/index.ts", import.meta.url);
const { TelegramSessionMonitor } = await import(monitorURL.href);
const { PollerLock } = await import(lockURL.href);
const { ProjectRegistryStore, registerProject } = await import(registryURL.href);

let failures = 0;
let passed = 0;
const total = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockPath = join(homedir(), ".otg", "poller.lock"); // 与 monitor 同源（OTG_DIR）

const realFetch = globalThis.fetch;

async function runCase(name, fn, timeoutMs = 8_000) {
  const baseDir = await mkdtemp(join(tmpdir(), "otg-poller-loop-"));
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`case timed out after ${timeoutMs}ms (poll loop likely never exits)`)), timeoutMs),
  );
  try {
    await Promise.race([fn(baseDir), timer]);
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    globalThis.fetch = realFetch;
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
}

function makeMonitor(registry, root) {
  const fakeClient = {
    app: { log: async () => {} },
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      get: async ({ path }) => ({ data: { id: path.id, title: "Test" } }),
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
    _client: { post: async () => ({ data: true }) },
  };
  const fakeConfig = {
    botToken: "123456789:TESTTOKEN_DO_NOT_USE_abcdefg",
    chatId: "123",
  };
  return new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
}

// LOOP-100：monitor 持锁轮询中，外部实例（新 PollerLock）直接抢占；
// 下一次 getUpdates 返回后 touch() 检测丢失 → isOwner() 为 false → 循环退出，
// getUpdates 调用计数停止增长，且不删除抢占者的锁文件。
await runCase("LOOP-100 stolen lock -> poll loop stops calling getUpdates", async (baseDir) => {
  await rm(lockPath, { force: true }).catch(() => {});
  const root = join(baseDir, "project");
  const registry = new ProjectRegistryStore(join(baseDir, "projects.json"));
  await registry.mutate((reg) => registerProject(reg, root));

  let getUpdatesCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/getUpdates")) getUpdatesCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const monitor = makeMonitor(registry, root);
  const poller = monitor.runTelegram(); // 不 await：常驻循环
  try {
    // 等待 monitor 抢到锁并进入轮询
    for (let i = 0; i < 100 && getUpdatesCalls < 2; i += 1) await sleep(20);
    if (getUpdatesCalls < 2) throw new Error("poller never started calling getUpdates");

    // 外部实例抢占锁（rm 后原子重建，模拟极端跨进程抢占）
    await rm(lockPath, { force: true });
    const B = new PollerLock(lockPath, 60_000);
    if (!(await B.tryAcquire())) throw new Error("B failed to seize the lock");

    // 等待 monitor 检测到丢失并退出（给足 2 轮 getUpdates 的余量）
    const callsAtSteal = getUpdatesCalls;
    await sleep(600);

    const stable = getUpdatesCalls === callsAtSteal;
    if (!stable) {
      throw new Error(
        `poll loop kept calling getUpdates after lock theft: ${callsAtSteal} -> ${getUpdatesCalls}`,
      );
    }

    // 退出路径 release() 不得误删 B 的锁文件
    let fileGone = false;
    try {
      await stat(lockPath);
    } catch {
      fileGone = true;
    }
    if (fileGone) throw new Error("stolen holder release() deleted the new owner's lock file");
    if (!B.isOwner()) throw new Error("B lost ownership after monitor exit");
  } finally {
    // dispose() 会 await runTelegram 结束；修复前循环永不退出 → dispose 挂起。
    // 用竞速兜底：dispose 卡住（>2s）也放行，让测试进程正常收尾而非悬挂。
    await Promise.race([
      monitor.dispose(),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await rm(lockPath, { force: true }).catch(() => {});
  }
});

// LOOP-101：getUpdates 连续失败（网络故障）时，catch 路径每次仍 touch()，
// 锁文件 mtime 持续刷新 → 锁不 stale，其它实例抢不到（修复前：失败即不 touch，
// 窗口 > TTL 后锁被回收 → 双轮询前提）。
await runCase("LOOP-101 failing poll still touches lock (mtime keeps refreshing)", async (baseDir) => {
  await rm(lockPath, { force: true }).catch(() => {});
  const root = join(baseDir, "project");
  const registry = new ProjectRegistryStore(join(baseDir, "projects.json"));
  await registry.mutate((reg) => registerProject(reg, root));

  globalThis.fetch = async () => {
    throw new Error("network down (simulated)");
  };

  const monitor = makeMonitor(registry, root);
  const poller = monitor.runTelegram();
  try {
    // 等待 monitor 抢到锁（失败也照常，catch 后每轮 backoff 重试）
    let sawInitialMtime = false;
    let initialMtime = 0;
    for (let i = 0; i < 100 && !sawInitialMtime; i += 1) {
      await sleep(20);
      try {
        const s = await stat(lockPath);
        initialMtime = s.mtimeMs;
        sawInitialMtime = true;
      } catch {
        /* lock not created yet */
      }
    }
    if (!sawInitialMtime) throw new Error("monitor never acquired the lock");

    // 观察 4s（覆盖 ≥2 轮 backoff：1s → 2s；修复后失败路径每轮 touch，
    // 且分段 sleep 每 10s 内至少 touch 一次），mtime 必须持续前进。
    let lastMtime = initialMtime;
    const advances = [];
    for (let i = 0; i < 8; i += 1) {
      await sleep(500);
      const s = await stat(lockPath);
      if (s.mtimeMs > lastMtime) advances.push(s.mtimeMs - lastMtime);
      lastMtime = s.mtimeMs;
    }
    if (advances.length < 2) {
      throw new Error(
        `lock mtime not refreshed during failures (touch missing in catch path): advances=${JSON.stringify(advances)}`,
      );
    }

    // 锁必须仍归 monitor（未被偷）——用另一实例验证抢不到
    const B = new PollerLock(lockPath, 60_000);
    if (await B.tryAcquire()) {
      await B.release();
      throw new Error("lock was stolen while holder kept failing (no touch in catch)");
    }
  } finally {
    // dispose() 会 await runTelegram 结束；修复前循环永不退出 → dispose 挂起。
    // 用竞速兜底：dispose 卡住（>2s）也放行，让测试进程正常收尾而非悬挂。
    await Promise.race([
      monitor.dispose(),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await rm(lockPath, { force: true }).catch(() => {});
  }
});

console.log(
  failures === 0
    ? `${passed}/${total} cases passed`
    : `${failures} FAILED (${passed}/${total} passed)`,
);
process.exit(failures === 0 ? 0 : 1);