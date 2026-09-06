// tests/poller-lock.test.mjs
//
// PollerLock 轮询抢占回归测试（2026-09-06 修复）：
// 背景：多 opencode 实例共享一个 bot token，只有锁持有者执行 getUpdates。
// 原实现只在 getUpdates 成功返回后 touch()，失败窗口（网络/代理故障）超过
// TTL 后锁被其它实例回收，而原持有者的 poll 循环从不检查「锁是否还归自己」，
// 继续无限 getUpdates → 双轮询 → Telegram 409 Conflict 刷屏。
//
// 三个回归断言：
//   LOCK-100 锁被抢占后 touch() 将 isOwner() 置 false → 轮询循环得以退出
//            （修复前：无 isOwner()，循环永不退出 → 409 根源）
//   LOCK-101 失败路径持续 touch 保活：锁不 stale，其它实例抢不到
//            （修复前：失败窗口 > TTL 即被抢 → 双轮询前提）
//   LOCK-102 被抢占后 release() 不删除新持有者的锁文件（ownerId 校验兜底）
//
// 用例使用 mkdtemp 临时目录隔离，绝不触碰真实 ~/.otg。
// 运行：bun tests/poller-lock.test.mjs

import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lockURL = new URL("../src/infra/poller-lock.ts", import.meta.url);
const { PollerLock } = await import(lockURL.href);

let failures = 0;
let passed = 0;
const total = 3;

async function runCase(name, fn) {
  const baseDir = await mkdtemp(join(tmpdir(), "otg-poller-lock-"));
  try {
    await fn(baseDir);
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// LOCK-100：锁被抢占后，touch() 检测到 ownerId 不符 → isOwner() === false。
// 这是 runTelegram 轮询循环 `if (!this.pollerLock.isOwner()) return` 的退出前提。
await runCase("LOCK-100 lock stolen -> touch() clears isOwner() so poll loop exits", async (baseDir) => {
  const lockPath = join(baseDir, "poller.lock");
  const ttlMs = 60; // 缩短 TTL 加速 stale 回收
  const A = new PollerLock(lockPath, ttlMs);
  if (!(await A.tryAcquire())) throw new Error("A failed to acquire");
  if (!A.isOwner()) throw new Error("A.isOwner() should be true after acquire");

  // A 停止 touch（模拟 getUpdates 失败窗口），等待锁文件过期
  await sleep(ttlMs + 50);

  // B 回收 stale 锁并成为新 owner
  const B = new PollerLock(lockPath, ttlMs);
  if (!(await B.tryAcquire())) throw new Error("B failed to steal stale lock");
  if (!B.isOwner()) throw new Error("B.isOwner() should be true after steal");

  // A 的下一次 touch() 必须把本地 owner 置 false（修复核心）
  await A.touch();
  if (A.isOwner()) {
    throw new Error(
      "A still thinks it owns the lock after theft; poll loop would keep calling getUpdates -> 409",
    );
  }
});

// LOCK-101：失败路径持续 touch 保活——持有者即使 getUpdates 连续失败，
// 只要还在 touch，锁就不过期，其它实例抢不到 → 不会出现双轮询前提。
// （修复前：catch 路径无 touch，失败窗口 > TTL 后锁即被抢。）
await runCase("LOCK-101 failing holder keeps touching -> lock not stealable", async (baseDir) => {
  const lockPath = join(baseDir, "poller.lock");
  const ttlMs = 120;
  const A = new PollerLock(lockPath, ttlMs);
  if (!(await A.tryAcquire())) throw new Error("A failed to acquire");

  const B = new PollerLock(lockPath, ttlMs);
  const stolen = { value: false };

  // 模拟 runTelegram catch 路径：每 30ms touch 一次（失败窗口持续 > TTL 数倍）
  const touchTimer = setInterval(() => void A.touch(), 30);
  try {
    for (let i = 0; i < 15; i += 1) {
      await sleep(50);
      if (await B.tryAcquire()) {
        stolen.value = true;
        await B.release();
        break;
      }
    }
  } finally {
    clearInterval(touchTimer);
  }

  if (stolen.value) {
    throw new Error(
      "B stole the lock while A kept touching (failure window); would start a second poller -> 409",
    );
  }
  if (!A.isOwner()) throw new Error("A lost ownership despite touching");
});

// LOCK-102：被抢占后 A.release() 不删除 B 刚创建的锁文件（ownerId 校验）。
// runTelegram 的 finally 里 release() 在「锁被偷后退出」路径上被调用，
// 必须不能误删新持有者的锁，否则 B 也被迫释放 → 连锁抢占风暴。
await runCase("LOCK-102 stolen holder release() does not delete new owner's lock file", async (baseDir) => {
  const lockPath = join(baseDir, "poller.lock");
  const ttlMs = 60;
  const A = new PollerLock(lockPath, ttlMs);
  if (!(await A.tryAcquire())) throw new Error("A failed to acquire");

  await sleep(ttlMs + 50);

  const B = new PollerLock(lockPath, ttlMs);
  if (!(await B.tryAcquire())) throw new Error("B failed to steal stale lock");

  await A.release(); // 修复后：ownerId 不符 → 不 rm

  let fileGone = false;
  try {
    await stat(lockPath);
  } catch {
    fileGone = true;
  }
  if (fileGone) {
    throw new Error("A.release() deleted B's lock file after theft");
  }
  if (!B.isOwner()) throw new Error("B lost ownership after A.release()");
});

console.log(
  failures === 0
    ? `${passed}/${total} cases passed`
    : `${failures} FAILED (${passed}/${total} passed)`,
);
process.exit(failures === 0 ? 0 : 1);