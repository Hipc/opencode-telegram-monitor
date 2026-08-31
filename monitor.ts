import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  dirname,
} from "node:path";
import { homedir, hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";

const OTG_DIR = join(homedir(), ".otg");
const DIAG_PATH = join(OTG_DIR, "tgdiag.log");

mkdirSync(OTG_DIR, { recursive: true });

function dline(message: string) {
  try {
    appendFileSync(
      DIAG_PATH,
      `${new Date().toISOString()} [${process.pid}] ${message}\n`,
    );
  } catch {
    /* diagnostics must never break the plugin */
  }
}

const DEFAULT_TTL_MS = 60_000;

type LockInfo = {
  pid: number;
  host: string;
  ownerId: string;
  createdAt: number;
};

class PollerLock {
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

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type {
  AssistantMessage,
  Part,
  Session,
  SessionStatus,
  Todo,
  ToolPart,
} from "@opencode-ai/sdk";

const SERVICE = "telegram-session-monitor";
const TARGET_OPENCODE_VERSION = "1.18.23";
// Single source of truth for the npm package version. The publish script
// (scripts/publish-version.mjs) reads this constant and writes it into
// package.json before `npm publish`, so the two never drift apart.
const PLUGIN_VERSION = "0.5.1";

// Self-update: the npm package name and registry endpoints used to check for
// and download newer releases. The update is atomic (staging dir + backup +
// verify + rollback) so an offline machine keeps running the cached version
// and never ends up with a half-installed plugin.
const NPM_PACKAGE_NAME = "opencode-telegram-monitor";
const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const SELF_UPDATE_FETCH_TIMEOUT_MS = 10_000;
// Only touch the plugin cache under ~/.cache/opencode (npm installs). A
// manually copied local file (~/.config/opencode/plugins/...) is left alone.
const OPENCODE_CACHE_MARKERS = [".cache/opencode", ".cache\\opencode"];
const IDLE_DEBOUNCE_MS = 5_000;
const WAITING_NOTIFY_DEBOUNCE_MS = 1_000;
const TELEGRAM_POLL_SECONDS = 25;
const TELEGRAM_POLL_TIMEOUT_MS = 35_000;
const TELEGRAM_SEND_TIMEOUT_MS = 15_000;
const TELEGRAM_SEND_ATTEMPTS = 3;
const TELEGRAM_MESSAGE_LIMIT = 3_500;
const MAX_EVENT_IDS = 2_000;
const MENU_MAX_PROJECTS = 20;
const POLLER_ACQUIRE_INTERVAL_MS = 20_000;
const POLLER_LOCK_TTL_MS = 60_000;
const REGISTER_INTERVAL_MS = 5 * 60_000;
// 暂时停用的命令（计划中，尚未开放）。路由收到这些命令时回复计划中提示；
// 对应实现方法保留，将来恢复只需从这里删除命令名并恢复 setMyCommands/helpText。
const PLANNED_COMMANDS = new Set([
  "start",
  "sessions",
  "use",
  "status",
  "todo",
  "usage",
]);

// Icon glyphs used in place of plain-text message type labels. Emoji carry
// their own color (green check, red cross, warning sign, ...) so no Telegram
// markdown parsing is required.
const ICON_COMPLETED = "✅";
const ICON_FAILED = "❌";
const ICON_CANCELLED = "❎";
const ICON_PERMISSION = "⚠️";
const ICON_QUESTION = "❓";
const ICON_RUNNING = "🟢";
const ICON_RETRYING = "🔁";
const ICON_IDLE = "💤";
const ICON_WAITING = "⏳";
const ICON_USAGE = "📊";
const ICON_TODO = "📋";
const ICON_HELP = "💁";
const ICON_SESSIONS = "🗂️";
const ICON_READY = "🟢";
const ICON_STATUS = "📊";

dline("MODULE LOADED");

type LogLevel = "debug" | "info" | "warn" | "error";
type SessionState = "idle" | "busy" | "retry";
type SessionOutcome = "completed" | "failed" | "cancelled";
type ToolState = "pending" | "running" | "completed" | "error";
type WaitingType = "permission" | "question";

type TelegramConfig = {
  botToken: string;
  chatId: string;
  proxy?: string;
};

type ProxySpec = {
  host: string;
  port: number;
  secure: boolean;
  auth?: string;
};

type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hasCost: boolean;
};

type ErrorSummary = {
  name: string;
  message?: string;
  cancelled: boolean;
};

type WaitingProjection = {
  requestID: string;
  type: WaitingType;
  summary: string;
  toolCallID?: string;
};

type ToolProjection = {
  partID?: string;
  callID: string;
  tool: string;
  state: ToolState;
  authoritative: boolean;
  target?: string;
  progress?: string;
  updatedAt: number;
};

type SessionProjection = {
  sessionID: string;
  info?: Session;
  status: SessionState;
  outcome?: SessionOutcome;
  observedRunning: boolean;
  turn: number;
  notifiedTurn?: number;
  currentAssistantMessageID?: string;
  emptyMessageRetries: number;
  turnStartedAt?: number;
  lastTransitionAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  agent?: string;
  messagesByID: Map<string, AssistantMessage>;
  toolsByCallID: Map<string, ToolProjection>;
  todos: Todo[];
  waitingByRequestID: Map<string, WaitingProjection>;
  tokens: TokenTotals;
  pendingError?: ErrorSummary;
};

type RuntimeEvent = {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
};

type TelegramCallbackQuery = {
  id: string;
  from?: { id: number | string };
  message?: {
    message_id: number;
    chat: { id: number | string };
  };
  data?: string;
};

type TelegramInlineButton = { text: string; callback_data?: string };
type TelegramInlineKeyboard = { inline_keyboard: TelegramInlineButton[][] };

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: {
      id: number | string;
    };
    chat: {
      id: number | string;
      type: string;
    };
  };
  callback_query?: TelegramCallbackQuery;
};

type TelegramEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
};

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

class TelegramSessionMonitor {
  private readonly root: string;
  private readonly projectLabel: string;
  private readonly sessions = new Map<string, SessionProjection>();
  private readonly sessionInfo = new Map<string, Session>();
  private readonly seenEventIDs = new Set<string>();
  private readonly seenWaitingRequestIDs = new Set<string>();
  private readonly waitingNotifyTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly terminalMessageIDs = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly abortController = new AbortController();

  private selectedSessionID?: string;
  private lastCompletedSessionID?: string;
  private telegramUpdateOffset?: number;
  private sendTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly pollerLock = new PollerLock(
    join(homedir(), ".otg", "poller.lock"),
    POLLER_LOCK_TTL_MS,
  );
  private pollerRetryTimer?: ReturnType<typeof setTimeout>;
  private registerTimer?: ReturnType<typeof setTimeout>;
  private selfUpdateTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly client: PluginInput["client"],
    private readonly config: TelegramConfig,
    root: string,
    private readonly registry: ProjectRegistryStore,
  ) {
    this.root = resolve(root);
    this.projectLabel = basename(this.root) || this.root;
  }

  initialize() {
    dline("initialize() called");
    // Start the Telegram poller immediately instead of waiting for the session
    // reconciliation to finish: the SDK's session API can hang while the opencode
    // server is still starting up (fetch timeouts are disabled), which would
    // otherwise prevent the poller (and therefore all Telegram commands) from ever
    // starting. bootstrap() runs in the background and only reconciles known state.
    this.track(this.runTelegram(), "Telegram poller failed");
    void this.bootstrap();
    this.scheduleRegistration();
    this.scheduleSelfUpdate();
  }

  /**
   * 自更新检查（npm 安装版才生效）：
   * - 本地文件安装（~/.config/opencode/plugins/...）不检查，避免误删用户手工副本。
   * - 从 npm registry 拉取 latest 版本，与 PLUGIN_VERSION 对比。
   * - 有新版 → 下载 tarball 到暂存区 → 校验 → 备份旧目录 → 原子替换 → 通知重启。
   * - 任何一步失败（含断网）都回滚/中止，旧版本目录始终可用，绝不导致 opencode 崩溃。
   * 全程异步、不阻塞 initialize()，任何异常都吞掉只写诊断日志。
   */
  private scheduleSelfUpdate() {
    if (this.disposed) return;
    // 延迟执行，避免与 poller 抢带宽/CPU；失败无妨，下次启动再试。
    const timer = setTimeout(() => {
      this.selfUpdateTimer = undefined;
      this.track(this.runSelfUpdate(), "Self-update failed");
    }, 5_000);
    this.selfUpdateTimer = timer;
  }

  private async runSelfUpdate() {
    try {
      if (this.disposed) return;
      const here = fileURLToPath(import.meta.url);
      const isCacheInstall = OPENCODE_CACHE_MARKERS.some((marker) =>
        here.includes(marker),
      );
      if (!isCacheInstall) {
        dline("self-update: skipped (not an npm cache install)");
        return;
      }

      const latest = await this.fetchNpmLatestVersion();
      if (!latest) {
        dline("self-update: registry unreachable, keeping current version");
        return;
      }
      if (latest === PLUGIN_VERSION) {
        dline(`self-update: already latest (${PLUGIN_VERSION})`);
        return;
      }

      dline(`self-update: found ${PLUGIN_VERSION} -> ${latest}`);
      await this.applyVersionUpdate(latest, here);
    } catch (error) {
      // 任何异常都不允许影响插件主功能，只记录诊断。
      dline(`self-update: unexpected error: ${this.errorCategory(error)}`);
    }
  }

  private async fetchNpmLatestVersion(): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SELF_UPDATE_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        `${NPM_REGISTRY_BASE}/${NPM_PACKAGE_NAME}/latest`,
        { signal: controller.signal },
      );
      if (!response.ok) return undefined;
      const data = (await response.json()) as { version?: string };
      return typeof data.version === "string" ? data.version : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 原子更新：下载到暂存区 → 校验 → 旧目录改名备份 → 暂存区替换 → 校验 → 删备份。
   * 断网/下载失败发生在「暂存区」阶段，旧目录分毫未动；替换阶段失败则回滚。
   * @param here 当前插件文件自身的绝对路径（便于测试注入）
   * @param deps 可注入的 fs 依赖（默认用真实实现；仅测试用）
   */
  private async applyVersionUpdate(
    latest: string,
    here: string,
    deps: {
      mkdir?: typeof mkdir;
      rm?: typeof rm;
      rename?: typeof rename;
      readFile?: typeof readFile;
    } = {},
  ) {
    const fsMkdir = deps.mkdir ?? mkdir;
    const fsRm = deps.rm ?? rm;
    const fsRename = deps.rename ?? rename;
    const fsReadFile = deps.readFile ?? readFile;
    const currentDir = dirname(here);
    const stagingRoot = join(OTG_DIR, "update-staging");
    const stagingDir = join(stagingRoot, latest);
    const backupDir = join(stagingRoot, `${latest}.bak`);

    await fsMkdir(stagingRoot, { recursive: true });

    // 1) 下载 + 解包到暂存区（断网/失败 → 直接中止，旧目录完好）
    const downloaded = await this.downloadAndExtract(latest, stagingDir);
    if (!downloaded) {
      dline("self-update: download/extract failed, keeping current version");
      await fsRm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return;
    }

    // 2) 校验暂存区内容：monitor.ts 存在且版本一致
    const stagedMain = join(stagingDir, "package", "monitor.ts");
    try {
      const staged = await fsReadFile(stagedMain, "utf8");
      if (!staged.includes(`const PLUGIN_VERSION = "${latest}"`)) {
        throw new Error(`staged version mismatch (want ${latest})`);
      }
    } catch (error) {
      dline(`self-update: staging verification failed: ${(error as Error).message}`);
      await fsRm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return;
    }

    // 3) 原子替换：current -> backup，staged -> current
    await fsRm(backupDir, { recursive: true, force: true }).catch(() => {});
    await fsRename(currentDir, backupDir);
    try {
      await fsRename(join(stagingDir, "package"), currentDir);
      // 4) 替换后再校验，通过才删备份
      const fresh = await fsReadFile(join(currentDir, "monitor.ts"), "utf8");
      if (!fresh.includes(`const PLUGIN_VERSION = "${latest}"`)) {
        throw new Error("post-swap verification failed");
      }
    } catch (error) {
      // 回滚：把备份恢复回去
      dline(`self-update: swap failed, rolling back: ${(error as Error).message}`);
      await fsRm(currentDir, { recursive: true, force: true }).catch(() => {});
      await fsRename(backupDir, currentDir).catch(() => {});
      return;
    }
    await fsRm(backupDir, { recursive: true, force: true }).catch(() => {});
    await fsRm(stagingDir, { recursive: true, force: true }).catch(() => {});

    dline(`self-update: applied ${PLUGIN_VERSION} -> ${latest} (restart opencode to load)`);
    this.enqueueMessage(
      `🔄 <b>Plugin updated</b>\n` +
        `<code>v${PLUGIN_VERSION}</code> → <code>v${latest}</code>\n` +
        `New version is staged in the opencode cache.\n` +
        `<b>Restart opencode</b> to load it.`,
    );
  }

  private async downloadAndExtract(
    version: string,
    destDir: string,
  ): Promise<boolean> {
    try {
      await rm(destDir, { recursive: true, force: true });
      await mkdir(destDir, { recursive: true });
      const url = `${NPM_REGISTRY_BASE}/${NPM_PACKAGE_NAME}/-/${NPM_PACKAGE_NAME}-${version}.tgz`;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        SELF_UPDATE_FETCH_TIMEOUT_MS,
      );
      let buffer: Uint8Array;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return false;
        buffer = new Uint8Array(await response.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }

      // tgz = gzip(tar)：先 gunzip，再手工解 tar（避免依赖外部 tar 命令）。
      const tar = gunzipSync(buffer);
      await this.extractTar(tar, destDir);
      return true;
    } catch (error) {
      dline(`self-update: download failed: ${this.errorCategory(error)}`);
      return false;
    }
  }

  /**
   * 极简 tar 解包（只支持 npm 包 tarball 需要的字段）：
   * 512 字节头：name(0,100) mode(100,8) uid(108,8) gid(116,8) size(124,12)
   * typeflag(156,1) prefix(345,155)。typeflag '0'=普通文件 '5'=目录 'L'=GNU 长文件名。
   * 只解出普通文件（含长文件名），跳过符号链接/硬链接，防目录穿越。
   */
  private async extractTar(tar: Uint8Array, destDir: string) {
    const decoder = new TextDecoder();
    let offset = 0;
    let longName: string | undefined;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break; // 连续 0 块 = 归档结束
      const typeflag = String.fromCharCode(header[156] ?? 0);
      const readStr = (start: number, len: number) =>
        decoder
          .decode(header.subarray(start, start + len))
          .replace(/\0.*$/, "");
      const size = Number.parseInt(
        decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim() ||
          "0",
        8,
      );
      const dataStart = offset + 512;
      const dataEnd = dataStart + size;

      if (typeflag === "L") {
        // GNU 长文件名：真实名字在数据块里
        longName = decoder
          .decode(tar.subarray(dataStart, dataEnd))
          .replace(/\0.*$/, "")
          .replace(/\/$/, "");
      } else if (typeflag === "0" || typeflag === "\0") {
        const name = longName ?? readStr(0, 100);
        longName = undefined;
        const prefix = readStr(345, 155);
        const fullName = prefix ? `${prefix}/${name}` : name;
        const rel = fullName.replace(/^\.\//, "");
        const target = resolve(destDir, rel);
        // 防目录穿越：目标必须仍在 destDir 内
        const relCheck = relative(destDir, target);
        if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
          throw new Error(`unsafe path in tarball: ${rel}`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, tar.subarray(dataStart, dataEnd));
      }
      // 其他类型（目录/链接/PAX 头）跳过数据块即可
      offset = dataEnd + ((512 - (size % 512)) % 512);
    }
  }

  accept(event: unknown) {
    if (this.disposed) return;
    this.track(this.handleEvent(event), "OpenCode event handler failed");
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();

    if (this.pollerRetryTimer) {
      clearTimeout(this.pollerRetryTimer);
      this.pollerRetryTimer = undefined;
    }

    for (const timer of this.waitingNotifyTimers.values()) {
      clearTimeout(timer);
    }
    this.waitingNotifyTimers.clear();

    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
    }

    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = undefined;
    }

    if (this.selfUpdateTimer) {
      clearTimeout(this.selfUpdateTimer);
      this.selfUpdateTimer = undefined;
    }

    await Promise.allSettled([...this.tasks, this.sendTail]);
    await this.pollerLock.release();
  }

  private async isProjectEnabled() {
    try {
      return await this.registry.isEnabled(this.root);
    } catch {
      return false;
    }
  }

  /**
   * 周期自注册（自我修复）：每隔 REGISTER_INTERVAL_MS 重新把本项目写进注册表。
   * 这样项目被 /menu 删除后，只要窗口还开着就会自动加回来（enabled: false），
   * 替代已移除的 ➕ 按钮。
   */
  private scheduleRegistration() {
    if (this.disposed) return;
    this.registerTimer = setTimeout(() => {
      this.registerTimer = undefined;
      this.track(this.reassertRegistration(), "Project re-registration failed");
    }, REGISTER_INTERVAL_MS);
  }

  private async reassertRegistration() {
    try {
      await this.registry.mutate((reg) => registerProject(reg, this.root));
    } catch {
      /* 失败不中断，下一轮继续 */
    }
    this.scheduleRegistration();
  }

  private async bootstrap() {
    // The opencode SDK client disables fetch timeouts, so a call issued while the
    // opencode server is still starting up can hang forever without resolving or
    // rejecting. Guard each call with a timeout and retry with backoff until the
    // server responds, so initialize() can always proceed to runTelegram().
    const withTimeout = async <T>(
      promise: Promise<T>,
    ): Promise<T | undefined> => {
      try {
        return await Promise.race([
          promise,
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 8_000),
          ),
        ]);
      } catch {
        return undefined;
      }
    };

    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
      attempts += 1;
      const [sessionsResult, statusResult] = await Promise.all([
        withTimeout(this.client.session.list({ throwOnError: true })),
        withTimeout(this.client.session.status({ throwOnError: true })),
      ]);

      let ok = false;
      if (sessionsResult?.data) {
        ok = true;
        for (const info of sessionsResult.data)
          this.sessionInfo.set(info.id, info);
      }

      if (statusResult?.data) {
        ok = true;
        for (const [sessionID, status] of Object.entries(statusResult.data)) {
          const session = this.ensureSession(sessionID);
          session.info = this.sessionInfo.get(sessionID);
          this.applyStatus(session, status, false);
        }
      }

      if (ok) {
        if (attempts > 1) {
          await this.log(
            "info",
            "Session reconciliation succeeded after retries",
            { attempts },
          );
        }
        dline(
          `bootstrap: succeeded (attempt ${attempts}), sessions tracked=${this.sessions.size}`,
        );
        return;
      }

      await this.log(
        "warn",
        `Session reconciliation incomplete (attempt ${attempts}/${maxAttempts}); retrying`,
        {
          hasSessions: Boolean(sessionsResult?.data),
          hasStatus: Boolean(statusResult?.data),
        },
      );
      await this.sleep(2_000 * attempts);
    }
  }

  private async handleEvent(value: unknown) {
    const event = this.parseRuntimeEvent(value);
    if (!event || !this.rememberEvent(event.id)) return;

    const properties = event.properties;
    const sessionID = this.string(properties.sessionID);

    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const info = this.session(properties.info);
        if (!info) return;
        this.sessionInfo.set(info.id, info);
        const projection = this.sessions.get(info.id);
        if (projection) projection.info = info;
        return;
      }

      case "session.deleted": {
        const info = this.session(properties.info);
        const id = sessionID ?? info?.id;
        if (!id) return;
        if (info) this.sessionInfo.set(info.id, info);
        const root = await this.primarySession(id);
        const projection = this.sessions.get(id);
        if (projection?.idleTimer) clearTimeout(projection.idleTimer);
        for (const requestID of projection?.waitingByRequestID.keys() ?? []) {
          this.cancelWaitingNotify(requestID);
        }
        this.sessions.delete(id);
        this.sessionInfo.delete(id);
        if (this.selectedSessionID === id) this.selectedSessionID = undefined;
        if (this.lastCompletedSessionID === id)
          this.lastCompletedSessionID = undefined;
        if (
          root.sessionID !== id &&
          root.status === "idle" &&
          root.observedRunning
        ) {
          this.scheduleIdleFinalization(root);
        }
        return;
      }

      case "session.status": {
        if (!sessionID) return;
        const status = this.status(properties.status);
        if (!status) return;
        this.applyStatus(this.ensureSession(sessionID), status, true);
        return;
      }

      case "session.idle": {
        if (!sessionID) return;
        this.applyStatus(this.ensureSession(sessionID), { type: "idle" }, true);
        return;
      }

      case "session.error": {
        if (!sessionID) {
          await this.log(
            "error",
            "OpenCode reported an unscoped session error",
          );
          return;
        }
        this.ensureSession(sessionID).pendingError = this.summarizeError(
          properties.error,
        );
        return;
      }

      case "message.updated": {
        const info = this.record(properties.info);
        const id = this.string(info?.id);
        const idFromMessage = this.string(info?.sessionID);
        if (!info || !id || !idFromMessage || info.role !== "assistant") return;
        const session = this.ensureSession(idFromMessage);
        const message = info as AssistantMessage;
        session.messagesByID.set(id, message);
        if (this.isCurrentTurnMessage(session, message)) {
          session.currentAssistantMessageID = id;
        }
        this.recalculateTokens(session);
        return;
      }

      case "message.removed": {
        const messageID = this.string(properties.messageID);
        if (!sessionID || !messageID) return;
        const session = this.ensureSession(sessionID);
        session.messagesByID.delete(messageID);
        this.recalculateTokens(session);
        return;
      }

      case "message.part.updated": {
        const part = this.record(properties.part);
        if (!part) return;
        this.applyPart(part as Part);
        return;
      }

      case "message.part.removed": {
        const partID = this.string(properties.partID);
        if (!sessionID || !partID) return;
        const session = this.ensureSession(sessionID);
        for (const [callID, tool] of session.toolsByCallID) {
          if (tool.partID === partID) session.toolsByCallID.delete(callID);
        }
        return;
      }

      case "todo.updated": {
        if (!sessionID || !Array.isArray(properties.todos)) return;
        this.ensureSession(sessionID).todos = properties.todos.filter(
          this.isTodo,
        );
        return;
      }

      case "permission.asked":
      case "permission.v2.asked": {
        if (!sessionID) return;
        const requestID = this.string(properties.id);
        if (!requestID) return;
        const permission =
          this.string(properties.permission) ??
          this.string(properties.action) ??
          "permission";
        const tool = this.record(properties.tool);
        const source = this.record(properties.source);
        this.addWaiting(sessionID, {
          requestID,
          type: "permission",
          summary: `${this.safeText(permission, 80)} permission`,
          toolCallID: this.string(tool?.callID) ?? this.string(source?.callID),
        });
        return;
      }

      case "permission.updated": {
        if (!sessionID) return;
        const requestID = this.string(properties.id);
        if (!requestID) return;
        const permission = this.string(properties.type) ?? "permission";
        this.addWaiting(sessionID, {
          requestID,
          type: "permission",
          summary: `${this.safeText(permission, 80)} permission`,
          toolCallID: this.string(properties.callID),
        });
        return;
      }

      case "permission.replied":
      case "permission.v2.replied": {
        if (!sessionID) return;
        const requestID =
          this.string(properties.requestID) ??
          this.string(properties.permissionID);
        if (requestID) {
          this.cancelWaitingNotify(requestID);
          this.ensureSession(sessionID).waitingByRequestID.delete(requestID);
        }
        return;
      }

      case "question.asked":
      case "question.v2.asked": {
        if (!sessionID) return;
        const requestID = this.string(properties.id);
        if (!requestID) return;
        const questions = Array.isArray(properties.questions)
          ? properties.questions
          : [];
        const firstQuestion = this.record(questions[0]);
        const header = this.string(firstQuestion?.header);
        const question = this.string(firstQuestion?.question);
        const tool = this.record(properties.tool);
        this.addWaiting(sessionID, {
          requestID,
          type: "question",
          summary: this.safeText(
            header ?? question ?? "OpenCode question",
            120,
          ),
          toolCallID: this.string(tool?.callID),
        });
        return;
      }

      case "question.replied":
      case "question.rejected":
      case "question.v2.replied":
      case "question.v2.rejected": {
        if (!sessionID) return;
        const requestID = this.string(properties.requestID);
        if (requestID) {
          this.cancelWaitingNotify(requestID);
          this.ensureSession(sessionID).waitingByRequestID.delete(requestID);
        }
        return;
      }

      case "session.next.agent.switched":
      case "session.next.step.started": {
        if (!sessionID) return;
        const agent = this.string(properties.agent);
        if (agent)
          this.ensureSession(sessionID).agent = this.safeText(agent, 80);
        return;
      }

      case "session.next.tool.input.started": {
        if (!sessionID) return;
        const callID = this.string(properties.callID);
        if (!callID) return;
        this.upsertTool(
          sessionID,
          callID,
          {
            tool: this.string(properties.name) ?? "tool",
            state: "pending",
          },
          "v2",
        );
        return;
      }

      case "session.next.tool.called": {
        if (!sessionID) return;
        const callID = this.string(properties.callID);
        if (!callID) return;
        const tool = this.string(properties.tool) ?? "tool";
        this.upsertTool(
          sessionID,
          callID,
          {
            tool,
            state: "running",
            target: this.safeToolTarget(tool, this.record(properties.input)),
          },
          "v2",
        );
        return;
      }

      case "session.next.tool.progress": {
        if (!sessionID) return;
        const callID = this.string(properties.callID);
        if (!callID) return;
        const structured = this.record(properties.structured);
        const progress = this.safeProgress(structured, properties.content);
        if (progress) this.upsertTool(sessionID, callID, { progress }, "v2");
        return;
      }

      case "session.next.tool.success":
      case "session.next.tool.failed": {
        if (!sessionID) return;
        const callID = this.string(properties.callID);
        if (!callID) return;
        this.upsertTool(
          sessionID,
          callID,
          {
            state: event.type.endsWith("success") ? "completed" : "error",
          },
          "v2",
        );
        return;
      }

      case "session.next.retried": {
        if (!sessionID) return;
        const attempt = this.number(properties.attempt) ?? 1;
        this.applyStatus(
          this.ensureSession(sessionID),
          {
            type: "retry",
            attempt,
            message: "Provider retry",
            next: Date.now(),
          },
          true,
        );
        return;
      }
    }
  }

  private applyPart(part: Part) {
    const sessionID = this.string(part.sessionID);
    if (!sessionID) return;
    const session = this.ensureSession(sessionID);

    if (part.type === "agent") {
      session.agent = this.safeText(part.name, 80);
      return;
    }

    if (part.type !== "tool") return;
    const toolPart = part as ToolPart;
    this.upsertTool(
      sessionID,
      toolPart.callID,
      {
        partID: toolPart.id,
        tool: toolPart.tool,
        state: toolPart.state.status,
        target: this.safeToolTarget(toolPart.tool, toolPart.state.input),
      },
      "stable",
    );
  }

  private addWaiting(sessionID: string, waiting: WaitingProjection) {
    const session = this.ensureSession(sessionID);
    if (this.seenWaitingRequestIDs.has(waiting.requestID)) return;
    this.rememberBounded(this.seenWaitingRequestIDs, waiting.requestID);
    session.waitingByRequestID.set(waiting.requestID, waiting);
    if (waiting.type === "permission") {
      // opencode's auto-approve mode answers permission requests client-side
      // within milliseconds of publishing permission.asked. Defer the Telegram
      // notification by a short window so auto-approved requests (which arrive
      // with a permission.replied right after) don't spam the chat; only
      // permissions that are still pending after the window are reported.
      this.scheduleWaitingNotify(sessionID, waiting);
      return;
    }
    this.track(
      this.notifyWaiting(sessionID, waiting),
      "Waiting notification failed",
    );
  }

  private scheduleWaitingNotify(sessionID: string, waiting: WaitingProjection) {
    dline(`scheduleWaitingNotify(${waiting.requestID}) type=${waiting.type}`);
    const timer = setTimeout(() => {
      this.waitingNotifyTimers.delete(waiting.requestID);
      if (this.disposed) return;
      this.track(
        this.notifyWaiting(sessionID, waiting),
        "Waiting notification failed",
      );
    }, WAITING_NOTIFY_DEBOUNCE_MS);
    this.waitingNotifyTimers.set(waiting.requestID, timer);
  }

  private cancelWaitingNotify(requestID: string) {
    const timer = this.waitingNotifyTimers.get(requestID);
    if (timer) {
      dline(`cancelWaitingNotify(${requestID})`);
      clearTimeout(timer);
      this.waitingNotifyTimers.delete(requestID);
    }
  }

  private async notifyWaiting(sessionID: string, waiting: WaitingProjection) {
    const root = await this.primarySession(sessionID);
    const source = this.sessions.get(sessionID);
    if (!source || !source.waitingByRequestID.has(waiting.requestID)) return;
    if (!(await this.isProjectEnabled())) return;
    if (!source.waitingByRequestID.has(waiting.requestID)) return;
    const tool = waiting.toolCallID
      ? source.toolsByCallID.get(waiting.toolCallID)?.tool
      : undefined;
    const rows = [
      this.fieldRow("Session", this.sessionLabel(root)),
      this.fieldRow("Type", waiting.type),
    ];
    if (source.sessionID !== root.sessionID) {
      rows.push(this.fieldRow("Subtask", this.sessionTitle(source)));
    }
    if (tool) rows.push(this.fieldRow("Tool", this.safeText(tool, 80)));
    rows.push(this.fieldRow("Request", waiting.summary));
    const parts = [
      this.titleLine(this.iconForWaitingType(waiting.type)),
      this.fieldTable(rows),
    ];
    this.enqueueMessage(parts.join("\n"));
  }

  private applyStatus(
    session: SessionProjection,
    status: SessionStatus,
    notify: boolean,
  ) {
    const next = status.type as SessionState;
    const now = Date.now();

    if (next !== "idle") {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = undefined;
      }

      if (!session.observedRunning) {
        session.turn += 1;
        session.turnStartedAt = now;
        session.notifiedTurn = undefined;
        session.currentAssistantMessageID = undefined;
        session.emptyMessageRetries = 0;
        session.pendingError = undefined;
        session.outcome = undefined;
      }

      session.observedRunning = true;
      session.status = next;
      session.lastTransitionAt = now;
      return;
    }

    session.status = "idle";
    session.lastTransitionAt = now;
    if (notify && session.observedRunning)
      this.scheduleIdleFinalization(session);
  }

  private scheduleIdleFinalization(session: SessionProjection) {
    if (session.idleTimer || session.notifiedTurn === session.turn) return;
    const turn = session.turn;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      this.track(
        this.finalizeIdle(session.sessionID, turn),
        "Idle finalization failed",
      );
    }, IDLE_DEBOUNCE_MS);
  }

  private async finalizeIdle(sessionID: string, turn: number) {
    let session = this.sessions.get(sessionID);
    if (!this.canFinalize(session, turn)) return;

    const reconciliation = await this.reconcileSession(sessionID);
    session = this.sessions.get(sessionID);
    if (!this.canFinalize(session, turn)) return;
    if (!reconciliation.messages && !session.pendingError) {
      this.scheduleIdleFinalization(session);
      return;
    }

    const root = await this.primarySession(sessionID);
    session = this.sessions.get(sessionID);
    if (!this.canFinalize(session, turn)) return;
    if (root.sessionID !== sessionID) {
      this.commitIdleOutcome(session);
      if (root.status === "idle" && root.observedRunning) {
        this.scheduleIdleFinalization(root);
      }
      return;
    }

    await this.synchronizeIdleDescendants(sessionID);
    session = this.sessions.get(sessionID);
    if (!this.canFinalize(session, turn)) return;
    const blockingDescendant = this.childSessions(sessionID).some(
      (child) => child.status !== "idle" || child.observedRunning,
    );
    if (blockingDescendant) return;

    const terminalMessageID = session.currentAssistantMessageID;
    if (!terminalMessageID && !session.pendingError) {
      if (session.emptyMessageRetries < 2) {
        session.emptyMessageRetries += 1;
        this.scheduleIdleFinalization(session);
      } else {
        session.notifiedTurn = turn;
        session.observedRunning = false;
        session.waitingByRequestID.clear();
      }
      return;
    }
    if (terminalMessageID && this.terminalMessageIDs.has(terminalMessageID)) {
      session.notifiedTurn = turn;
      session.observedRunning = false;
      return;
    }

    const { outcome, error } = this.commitIdleOutcome(session);
    if (terminalMessageID)
      this.rememberBounded(this.terminalMessageIDs, terminalMessageID);

    this.lastCompletedSessionID = sessionID;
    if (await this.isProjectEnabled()) {
      this.enqueueMessage(
        this.formatTerminalNotification(session, outcome, error),
      );
    }
  }

  private canFinalize(
    session: SessionProjection | undefined,
    turn: number,
  ): session is SessionProjection {
    return Boolean(
      session &&
      session.status === "idle" &&
      session.turn === turn &&
      session.observedRunning &&
      session.notifiedTurn !== turn,
    );
  }

  private commitIdleOutcome(session: SessionProjection) {
    const currentMessage = session.currentAssistantMessageID
      ? session.messagesByID.get(session.currentAssistantMessageID)
      : undefined;
    const messageError = currentMessage?.error
      ? this.summarizeError(currentMessage.error)
      : undefined;
    const error = messageError ?? session.pendingError;
    const outcome: SessionOutcome = error?.cancelled
      ? "cancelled"
      : error
        ? "failed"
        : "completed";

    session.outcome = outcome;
    session.notifiedTurn = session.turn;
    session.observedRunning = false;
    session.waitingByRequestID.clear();
    return { outcome, error };
  }

  private async synchronizeIdleDescendants(parentID: string) {
    const descendants = this.childSessions(parentID).filter(
      (child) => child.status === "idle" && child.observedRunning,
    );

    for (const child of descendants) {
      const turn = child.turn;
      const reconciliation = await this.reconcileSession(child.sessionID);
      const current = this.sessions.get(child.sessionID);
      if (!this.canFinalize(current, turn)) continue;
      if (!reconciliation.messages && !current.pendingError) {
        this.scheduleIdleFinalization(current);
        continue;
      }
      if (current.idleTimer) {
        clearTimeout(current.idleTimer);
        current.idleTimer = undefined;
      }
      this.commitIdleOutcome(current);
    }
  }

  private async reconcileSession(sessionID: string) {
    const session = this.ensureSession(sessionID);
    await this.ensureSessionInfo(sessionID);
    let messagesReconciled = false;
    let todosReconciled = false;

    const [messagesResult, todoResult] = await Promise.allSettled([
      this.client.session.messages({
        path: { id: sessionID },
        throwOnError: true,
      }),
      this.client.session.todo({ path: { id: sessionID }, throwOnError: true }),
    ]);

    if (messagesResult.status === "fulfilled" && messagesResult.value.data) {
      session.messagesByID.clear();
      session.toolsByCallID.clear();
      for (const message of messagesResult.value.data) {
        if (message.info.role === "assistant") {
          session.messagesByID.set(message.info.id, message.info);
          if (this.isCurrentTurnMessage(session, message.info)) {
            session.currentAssistantMessageID = message.info.id;
          }
        }
        for (const part of message.parts) this.applyPart(part);
      }
      this.recalculateTokens(session);
      messagesReconciled = true;
    } else if (messagesResult.status === "rejected") {
      await this.log("warn", "Session message reconciliation failed", {
        sessionID: this.shortID(sessionID),
        error: this.errorCategory(messagesResult.reason),
      });
    }

    if (todoResult.status === "fulfilled" && todoResult.value.data) {
      session.todos = todoResult.value.data;
      todosReconciled = true;
    } else if (todoResult.status === "rejected") {
      await this.log("warn", "Session todo reconciliation failed", {
        sessionID: this.shortID(sessionID),
        error: this.errorCategory(todoResult.reason),
      });
    }
    return { messages: messagesReconciled, todos: todosReconciled };
  }

  private async reconcileStatuses() {
    try {
      const result = await this.client.session.status({ throwOnError: true });
      if (!result.data) {
        dline("reconcileStatuses: session.status returned no data");
        return;
      }
      const active = new Set(Object.keys(result.data));
      dline(
        `reconcileStatuses: session.status returned ${active.size} active session(s): ${[...active].slice(0, 5).join(",")}`,
      );

      for (const [sessionID, status] of Object.entries(result.data)) {
        this.applyStatus(this.ensureSession(sessionID), status, false);
      }

      for (const session of this.sessions.values()) {
        if (session.status !== "idle" && !active.has(session.sessionID)) {
          this.applyStatus(session, { type: "idle" }, false);
        }
      }
    } catch (error) {
      dline(`reconcileStatuses: FAILED ${this.errorCategory(error)}`);
      await this.log("warn", "Session status reconciliation failed", {
        error: this.errorCategory(error),
      });
    }
  }

  private async ensureSessionInfo(sessionID: string) {
    const session = this.ensureSession(sessionID);
    if (session.info) return session.info;

    const cached = this.sessionInfo.get(sessionID);
    if (cached) {
      session.info = cached;
      return cached;
    }

    try {
      const result = await this.client.session.get({
        path: { id: sessionID },
        throwOnError: true,
      });
      if (!result.data) return undefined;
      this.sessionInfo.set(result.data.id, result.data);
      session.info = result.data;
      return result.data;
    } catch (error) {
      await this.log("warn", "Session metadata reconciliation failed", {
        sessionID: this.shortID(sessionID),
        error: this.errorCategory(error),
      });
      return undefined;
    }
  }

  private async primarySession(sessionID: string) {
    let current = this.ensureSession(sessionID);
    const seen = new Set<string>();

    while (!seen.has(current.sessionID)) {
      seen.add(current.sessionID);
      const info = await this.ensureSessionInfo(current.sessionID);
      if (!info?.parentID) return current;
      current = this.ensureSession(info.parentID);
    }

    return this.ensureSession(sessionID);
  }

  private ensureSession(sessionID: string) {
    const existing = this.sessions.get(sessionID);
    if (existing) return existing;

    const session: SessionProjection = {
      sessionID,
      info: this.sessionInfo.get(sessionID),
      status: "idle",
      observedRunning: false,
      turn: 0,
      emptyMessageRetries: 0,
      lastTransitionAt: Date.now(),
      messagesByID: new Map(),
      toolsByCallID: new Map(),
      todos: [],
      waitingByRequestID: new Map(),
      tokens: this.emptyTokens(),
    };
    this.sessions.set(sessionID, session);
    return session;
  }

  private upsertTool(
    sessionID: string,
    callID: string,
    patch: Partial<Omit<ToolProjection, "callID" | "updatedAt">>,
    source: "stable" | "v2",
  ) {
    const session = this.ensureSession(sessionID);
    const existing = session.toolsByCallID.get(callID);
    const authoritative =
      source === "stable" || existing?.authoritative === true;
    const canReplaceState = source === "stable" || !existing?.authoritative;
    session.toolsByCallID.set(callID, {
      callID,
      tool: canReplaceState
        ? (patch.tool ?? existing?.tool ?? "tool")
        : existing.tool,
      state: canReplaceState
        ? (patch.state ?? existing?.state ?? "pending")
        : existing.state,
      authoritative,
      partID: patch.partID ?? existing?.partID,
      target: canReplaceState
        ? (patch.target ?? existing?.target)
        : existing.target,
      progress: patch.progress ?? existing?.progress,
      updatedAt: Date.now(),
    });
  }

  private recalculateTokens(session: SessionProjection) {
    const totals = this.emptyTokens();
    for (const message of session.messagesByID.values()) {
      totals.input += message.tokens.input || 0;
      totals.output += message.tokens.output || 0;
      totals.reasoning += message.tokens.reasoning || 0;
      totals.cacheRead += message.tokens.cache.read || 0;
      totals.cacheWrite += message.tokens.cache.write || 0;
      if (Number.isFinite(message.cost)) {
        totals.cost += message.cost;
        totals.hasCost = true;
      }
    }
    session.tokens = totals;
  }

  private isCurrentTurnMessage(
    session: SessionProjection,
    message: AssistantMessage,
  ) {
    if (!session.observedRunning || !session.turnStartedAt) return false;
    return (
      message.time.created >= session.turnStartedAt - 1_000 ||
      Boolean(
        message.time.completed &&
        message.time.completed >= session.turnStartedAt - 1_000,
      )
    );
  }

  private async runTelegram() {
    dline("runTelegram() started");
    // 多实例共享一个 bot token：只有持有轮询锁的实例执行 getUpdates，
    // 否则多个长轮询会随机分发 update 且 offset 各自推进，导致重复投递
    //（一个点击被处理两次）与菜单闪烁。非轮询实例定期重试抢占。
    const acquired = await this.pollerLock.tryAcquire();
    if (!acquired) {
      dline("poller lock held elsewhere; scheduling retry");
      this.pollerRetryTimer = setTimeout(() => {
        this.pollerRetryTimer = undefined;
        if (!this.abortController.signal.aborted) {
          this.track(this.runTelegram(), "Telegram poller failed");
        }
      }, POLLER_ACQUIRE_INTERVAL_MS);
      return;
    }
    dline("poller lock acquired");

    try {
      try {
        dline("deleteWebhook: calling");
        await this.telegramWithRetry("deleteWebhook", {
          drop_pending_updates: true,
        });
        dline("deleteWebhook: OK");
        dline("setMyCommands: calling");
        await this.telegramWithRetry("setMyCommands", {
          commands: [
            { command: "menu", description: "Manage monitored projects" },
            { command: "help", description: "Show available commands" },
          ],
        });
        dline("setMyCommands: OK");
      } catch (error) {
        // Don't bail out if the initial webhook/command setup fails (e.g. a flaky
        // proxy). The poll loop below is resilient: getUpdates errors are retried
        // with backoff, so the poller still comes up and can serve Telegram commands.
        await this.log(
          "error",
          "Telegram initialization failed; continuing to poll",
          {
            error: this.errorCategory(error),
          },
        );
        dline(`init failed: ${this.errorCategory(error)}; continuing to poll`);
      }

      dline("poll loop: starting");
      let backoff = 1_000;
      while (!this.abortController.signal.aborted) {
        try {
          dline("getUpdates: calling");
          const updates = await this.telegramRequest<TelegramUpdate[]>(
            "getUpdates",
            {
              timeout: TELEGRAM_POLL_SECONDS,
              allowed_updates: ["message", "callback_query"],
              ...(this.telegramUpdateOffset === undefined
                ? {}
                : { offset: this.telegramUpdateOffset }),
            },
            TELEGRAM_POLL_TIMEOUT_MS,
          );
          backoff = 1_000;
          await this.pollerLock.touch();

          dline(`getUpdates: returned ${updates.length} update(s)`);
          for (const update of updates) {
            this.telegramUpdateOffset = Math.max(
              this.telegramUpdateOffset ?? 0,
              update.update_id + 1,
            );
            await this.handleTelegramUpdate(update);
          }
        } catch (error) {
          if (this.abortController.signal.aborted) return;
          if (error instanceof TelegramApiError && error.errorCode === 401) {
            await this.log(
              "error",
              "Telegram rejected the configured bot token",
            );
            return;
          }
          await this.log("warn", "Telegram polling failed; reconnecting", {
            error: this.errorCategory(error),
            retryMs: backoff,
          });
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    } finally {
      await this.pollerLock.release();
    }
  }

  private async handleTelegramUpdate(update: TelegramUpdate) {
    const callback = update.callback_query;
    if (callback) {
      await this.handleCallback(callback);
      return;
    }

    const message = update.message;
    if (
      !message?.text ||
      message.chat.type !== "private" ||
      String(message.chat.id) !== this.config.chatId ||
      String(message.from?.id) !== this.config.chatId
    )
      return;

    const match = message.text
      .trim()
      .match(/^\/([a-zA-Z]+)(?:@\S+)?(?:\s+(.+))?$/);
    if (!match) return;
    const command = match[1]?.toLowerCase();
    const argument = match[2]?.trim();

    if (PLANNED_COMMANDS.has(command)) {
      this.enqueueMessage(
        this.paragraph(`/${command} is planned but not available yet (计划中).`),
      );
      return;
    }

    switch (command) {
      case "menu":
        await this.commandMenu();
        return;
      case "help":
        this.enqueueMessage(this.helpText());
        return;
      default:
        this.enqueueMessage(
          `Unknown command: /${this.escapeHtml(command)}\n\n${this.helpText()}`,
        );
    }
  }

  private async commandStart() {
    let connected = true;
    try {
      await this.client.session.status({ throwOnError: true });
    } catch {
      connected = false;
    }

    const rows = [
      this.fieldRow("OpenCode target", TARGET_OPENCODE_VERSION),
      this.fieldRow(
        "OpenCode connection",
        connected ? "available" : "unavailable",
      ),
      this.fieldRow("Authorization", "verified"),
      this.fieldRow("Mode", "read-only"),
    ];
    this.enqueueMessage(
      [
        this.titleLine(ICON_READY),
        this.fieldTable(rows),
        "<p>Use /sessions to list active sessions.</p>",
      ].join("\n"),
    );
  }

  private async commandSessions() {
    await this.reconcileStatuses();
    const active = this.activePrimarySessions();
    dline(
      `commandSessions: total tracked=${this.sessions.size}, activePrimary=${active.length}`,
    );
    if (active.length === 0) {
      const parts = [
        this.paragraph(`${ICON_SESSIONS} ${this.projectLabel}`),
        this.paragraph("No active sessions."),
      ];
      const last = this.lastCompletedSessionID
        ? this.sessions.get(this.lastCompletedSessionID)
        : undefined;
      if (last) {
        parts.push(
          `<p>Last completed: ${this.escapeHtml(this.sessionLabel(last))}</p>`,
        );
      }
      this.enqueueMessage(parts.join("\n"));
      return;
    }

    const listItems = active
      .map((session) => {
        const marker = session.sessionID === this.selectedSessionID ? "*" : "-";
        return `<li>${marker} ${this.shortID(session.sessionID)} | ${this.displayState(session)} | ${this.escapeHtml(this.sessionTitle(session))}</li>`;
      })
      .join("");
    this.enqueueMessage(
      [
        this.paragraph(`${ICON_SESSIONS} ${this.projectLabel}`),
        `<ul>${listItems}</ul>`,
        "<p>Select one with /use &lt;short-id&gt;.</p>",
      ].join("\n"),
    );
  }

  private async commandUse(argument?: string) {
    if (!argument) {
      this.enqueueMessage(this.paragraph("Usage: /use &lt;short-id&gt;"));
      return;
    }

    await this.reconcileStatuses();
    const matches = [...this.sessions.values()].filter((session) =>
      this.matchesSessionID(session.sessionID, argument),
    );

    if (matches.length === 0) {
      this.enqueueMessage(
        this.paragraph(
          `No observed session matches: ${this.safeText(argument, 40)}`,
        ),
      );
      return;
    }
    if (matches.length > 1) {
      const listItems = matches
        .slice(0, 10)
        .map(
          (session) =>
            `<li>${this.shortID(session.sessionID)} | ${this.escapeHtml(this.sessionTitle(session))}</li>`,
        )
        .join("");
      this.enqueueMessage(
        [this.paragraph("Session ID is ambiguous:"), `<ul>${listItems}</ul>`].join(
          "\n",
        ),
      );
      return;
    }

    const session = matches[0]!;
    this.selectedSessionID = session.sessionID;
    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(this.paragraph(`Selected: ${this.sessionLabel(session)}`));
  }

  private async commandStatus() {
    await this.reconcileStatuses();
    const session = this.selectedSession();
    if (!session) {
      const active = this.activePrimarySessions();
      if (active.length > 0) {
        const listItems = active
          .slice(0, 10)
          .map(
            (item) =>
              `<li>${this.shortID(item.sessionID)} | ${this.displayState(item)} | ${this.escapeHtml(this.sessionTitle(item))}</li>`,
          )
          .join("");
        this.enqueueMessage(
          [
            this.paragraph(`${ICON_STATUS} No session selected.`),
            `<ul>${listItems}</ul>`,
            this.paragraph("Select one with /use &lt;short-id&gt;."),
          ].join("\n"),
        );
        return;
      }

      const last = this.lastCompletedSessionID
        ? this.sessions.get(this.lastCompletedSessionID)
        : undefined;
      this.enqueueMessage(
        last
          ? this.paragraph(
              `${ICON_STATUS} No active sessions.\nLast completed: ${this.sessionLabel(last)}`,
            )
          : this.paragraph(`${ICON_STATUS} No active sessions.`),
      );
      return;
    }

    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(this.formatStatus(session));
  }

  private async commandTodo() {
    const session = this.selectedSession();
    if (!session) {
      this.enqueueMessage(
        this.paragraph(
          "No session selected. Use /sessions and /use &lt;short-id&gt; first.",
        ),
      );
      return;
    }
    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(this.formatTodos(session));
  }

  private async commandUsage() {
    const session = this.selectedSession();
    if (!session) {
      this.enqueueMessage(
        this.paragraph(
          "No session selected. Use /sessions and /use &lt;short-id&gt; first.",
        ),
      );
      return;
    }
    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(this.formatUsage(session));
  }

  private async commandMenu() {
    const registry = await this.registry.read();
    this.enqueueMessageWithKeyboard(
      this.menuText(registry),
      this.buildMenuKeyboard(registry),
    );
  }

  private menuText(registry: ProjectRegistry) {
    const parts = [
      this.paragraph(`📋 项目监控列表（${registry.projects.length}）`),
    ];
    if (registry.projects.length === 0) {
      parts.push(this.paragraph("（暂无项目，启动 opencode 后会自动注册）"));
    } else {
      const items = [];
      for (
        let i = 0;
        i < Math.min(registry.projects.length, MENU_MAX_PROJECTS);
        i += 1
      ) {
        const entry = registry.projects[i]!;
        items.push(
          `<li>${entry.enabled ? "✅" : "⚪"} ${this.escapeHtml(basename(entry.path))}</li>`,
        );
      }
      parts.push(`<ul>${items.join("")}</ul>`);
      if (registry.projects.length > MENU_MAX_PROJECTS) {
        parts.push(
          this.paragraph(
            `... 以及另外 ${registry.projects.length - MENU_MAX_PROJECTS} 个项目`,
          ),
        );
      }
    }
    parts.push(this.paragraph("✅ 已监控 · ⚪ 已注册未开启 · 🗑 删除"));
    return parts.join("\n");
  }

  private buildMenuKeyboard(registry: ProjectRegistry): TelegramInlineKeyboard {
    const rows: TelegramInlineButton[][] = [];
    for (
      let i = 0;
      i < Math.min(registry.projects.length, MENU_MAX_PROJECTS);
      i += 1
    ) {
      const entry = registry.projects[i]!;
      // callback_data 用路径 token（稳定标识）而非位置序号，避免多实例并发下
      // 列表变化导致删错/切错项目；同时携带目标状态实现幂等。
      const token = entryToken(entry.path);
      const target = entry.enabled ? 0 : 1;
      rows.push([
        {
          text: `${entry.enabled ? "✅" : "⚪"} ${basename(entry.path)}`,
          callback_data: `otg:set:${token}:${target}`,
        },
        { text: "🗑", callback_data: `otg:del:${token}` },
      ]);
    }
    rows.push([{ text: "🔄 刷新", callback_data: "otg:refresh" }]);
    return { inline_keyboard: rows };
  }

  private async handleCallback(callback: TelegramCallbackQuery) {
    if (String(callback.from?.id) !== this.config.chatId) return;
    const { id, data, message } = callback;
    if (!id || !data || !message) return;
    const match = data.match(/^otg:([a-z]+)(?::([0-9a-f]{12}))?(?::([01]))?$/);
    if (!match) {
      await this.answerCallback(id, "Unknown action", false);
      return;
    }
    const action = match[1]!;
    const token = match[2];
    const target = match[3] !== undefined ? match[3] === "1" : undefined;

    try {
      switch (action) {
        case "set": {
          if (!token || target === undefined) break;
          const next = await this.registry.mutate((reg) => {
            const entry = findEntryByToken(reg, token);
            return entry
              ? setProjectEnabled(reg, entry.path, target)
              : undefined;
          });
          if (!next) {
            await this.answerCallback(id, "项目不存在", true);
            return;
          }
          await this.answerCallback(id, target ? "已开启" : "已关闭", false);
          break;
        }
        case "del": {
          if (!token) break;
          // 幂等：找不到条目视为已删除，不报错
          const next = await this.registry.mutate((reg) => {
            const entry = findEntryByToken(reg, token);
            return entry ? deleteProjectByPath(reg, entry.path) : reg;
          });
          if (!next) {
            await this.answerCallback(id, "项目不存在", true);
            return;
          }
          await this.answerCallback(id, "已删除", false);
          break;
        }
        case "register":
          // 兼容旧菜单中残留的 ➕ 按钮；新菜单已移除（改为周期自注册）
          await this.registry.mutate((reg) => registerProject(reg, this.root));
          await this.answerCallback(id, "已注册当前项目", false);
          break;
        case "refresh":
          await this.answerCallback(id, "已刷新", false);
          break;
        default:
          await this.answerCallback(id, "Unknown action", false);
          return;
      }
      const registry = await this.registry.read();
      await this.editMenuMessage(message.chat.id, message.message_id, registry);
    } catch (error) {
      await this.answerCallback(id, "操作失败，请重试", true).catch(
        () => undefined,
      );
      await this.log("error", "Callback handling failed", {
        error: this.errorCategory(error),
      });
    }
  }

  private async answerCallback(
    callbackQueryID: string,
    text: string,
    alert: boolean,
  ) {
    await this.telegramWithRetry("answerCallbackQuery", {
      callback_query_id: callbackQueryID,
      text,
      show_alert: alert,
    });
  }

  private async editMenuMessage(
    chatID: number | string,
    messageID: number,
    registry: ProjectRegistry,
  ) {
    await this.telegramWithRetry("editMessageText", {
      chat_id: chatID,
      message_id: messageID,
      text: this.menuText(registry),
      reply_markup: this.buildMenuKeyboard(registry),
    });
  }

  private activePrimarySessions() {
    return [...this.sessions.values()]
      .filter((session) => !session.info?.parentID)
      .filter(
        (session) =>
          session.status !== "idle" || session.waitingByRequestID.size > 0,
      )
      .sort((left, right) => right.lastTransitionAt - left.lastTransitionAt);
  }

  private selectedSession() {
    return this.selectedSessionID
      ? this.sessions.get(this.selectedSessionID)
      : undefined;
  }

  private formatStatus(session: SessionProjection) {
    const currentTool = [...session.toolsByCallID.values()]
      .filter((tool) => tool.state === "pending" || tool.state === "running")
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const todo = this.todoCounts(session.todos);
    const rows = [
      this.fieldRow("Session", this.sessionLabel(session)),
    ];

    if (session.agent) rows.push(this.fieldRow("Agent", session.agent));
    if (currentTool) {
      rows.push(this.fieldRow("Current tool", this.safeText(currentTool.tool, 80)));
      if (currentTool.target) rows.push(this.fieldRow("Target", currentTool.target));
      rows.push(this.fieldRow("Tool state", currentTool.state));
      if (currentTool.progress) rows.push(this.fieldRow("Progress", currentTool.progress));
    }
    rows.push(this.fieldRow("Todo", this.todoSummary(todo)));
    if (session.turnStartedAt && session.status !== "idle") {
      rows.push(
        this.fieldRow(
          "Elapsed",
          this.formatDuration(Date.now() - session.turnStartedAt),
        ),
      );
    }

    const parts = [
      this.titleLine(this.iconForState(this.displayState(session))),
      this.fieldTable(rows),
    ];

    const children = this.childSessions(session.sessionID);
    const activeChildren = children.filter(
      (child) => child.status !== "idle" || child.waitingByRequestID.size > 0,
    );
    if (activeChildren.length > 0) {
      const listItems = activeChildren
        .slice(0, 5)
        .map((child) => {
          const tool = [...child.toolsByCallID.values()]
            .filter(
              (item) => item.state === "pending" || item.state === "running",
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)[0];
          return `<li>${this.escapeHtml(this.sessionTitle(child))} | ${this.displayState(child)}${tool ? ` | ${this.escapeHtml(tool.tool)}` : ""}</li>`;
        })
        .join("");
      parts.push(this.paragraph("Active subtasks:"));
      parts.push(`<ul>${listItems}</ul>`);
      if (activeChildren.length > 5) {
        parts.push(this.paragraph(`... and ${activeChildren.length - 5} more`));
      }
    }

    return this.limitMessage(parts.join("\n"));
  }

  private formatTerminalNotification(
    session: SessionProjection,
    outcome: SessionOutcome,
    error?: ErrorSummary,
  ) {
    const todo = this.todoCounts(session.todos);
    const rows = [
      this.fieldRow("Session", this.sessionLabel(session)),
    ];
    if (session.turnStartedAt) {
      rows.push(
        this.fieldRow(
          "Duration",
          this.formatDuration(Date.now() - session.turnStartedAt),
        ),
      );
    }
    if (error && outcome === "failed") {
      rows.push(
        this.fieldRow(
          "Error",
          error.message ? `${error.name}: ${error.message}` : error.name,
        ),
      );
    }
    rows.push(this.fieldRow("Todo", this.todoSummary(todo)));

    const children = this.childSessions(session.sessionID);
    if (children.length > 0) {
      const completed = children.filter(
        (child) => child.outcome === "completed",
      ).length;
      const failed = children.filter(
        (child) => child.outcome === "failed",
      ).length;
      const cancelled = children.filter(
        (child) => child.outcome === "cancelled",
      ).length;
      const active = children.filter(
        (child) => child.status !== "idle" || child.observedRunning,
      ).length;
      rows.push(
        this.fieldRow(
          "Subtasks",
          `${completed} completed, ${failed} failed, ${cancelled} cancelled, ${active} active`,
        ),
      );
    }

    const tokens = this.aggregateTokens(session);
    rows.push(this.fieldRow("Tokens", this.formatNumber(this.totalTokens(tokens))));
    rows.push(this.fieldRow("Input", this.formatNumber(tokens.input)));
    rows.push(this.fieldRow("Output", this.formatNumber(tokens.output)));
    rows.push(
      this.fieldRow(
        "Cache",
        this.formatNumber(tokens.cacheRead + tokens.cacheWrite),
      ),
    );
    rows.push(this.fieldRow("Cost", this.formatCost(tokens)));
    return this.limitMessage(
      [
        this.titleLine(this.iconForOutcome(outcome)),
        this.fieldTable(rows),
      ].join("\n"),
    );
  }

  private formatTodos(session: SessionProjection) {
    const groups = [
      "in_progress",
      "pending",
      "completed",
      "cancelled",
    ] as const;
    const labels: Record<(typeof groups)[number], string> = {
      in_progress: "IN PROGRESS",
      pending: "PENDING",
      completed: "COMPLETED",
      cancelled: "CANCELLED",
    };
    const table = this.fieldTable([
      this.fieldRow("Session", this.sessionLabel(session)),
    ]);
    const title = this.titleLine(ICON_TODO);

    if (session.todos.length === 0) {
      return this.limitMessage(
        [title, table, this.paragraph("No todos reported.")].join("\n"),
      );
    }

    const parts = [title, table];
    let shown = 0;
    for (const group of groups) {
      const todos = session.todos.filter((todo) => todo.status === group);
      if (todos.length === 0) continue;
      parts.push(this.paragraph(labels[group]));
      const items: string[] = [];
      for (const todo of todos) {
        const line = `- ${this.escapeHtml(this.safeText(todo.content, 180))}`;
        if (
          parts.join("\n").length + items.join("\n").length + line.length >
          TELEGRAM_MESSAGE_LIMIT - 100
        )
          break;
        items.push(`<li>${this.escapeHtml(this.safeText(todo.content, 180))}</li>`);
        shown += 1;
      }
      if (items.length > 0) parts.push(`<ul>${items.join("")}</ul>`);
    }

    if (shown < session.todos.length) {
      parts.push(this.paragraph(`... and ${session.todos.length - shown} more items`));
    }
    return this.limitMessage(parts.join("\n"));
  }

  private formatUsage(session: SessionProjection) {
    const tokens = this.aggregateTokens(session);
    return [
      this.titleLine(ICON_USAGE),
      this.fieldTable([
        this.fieldRow("Session", this.sessionLabel(session)),
        this.fieldRow("Total tokens", this.formatNumber(this.totalTokens(tokens))),
        this.fieldRow("Input", this.formatNumber(tokens.input)),
        this.fieldRow("Output", this.formatNumber(tokens.output)),
        this.fieldRow("Reasoning", this.formatNumber(tokens.reasoning)),
        this.fieldRow("Cache read", this.formatNumber(tokens.cacheRead)),
        this.fieldRow("Cache write", this.formatNumber(tokens.cacheWrite)),
        this.fieldRow("Cost", this.formatCost(tokens)),
      ]),
    ].join("\n");
  }

  private helpText() {
    const commands = [
      "/menu - Manage monitored projects",
      "/help - Show this help",
    ];
    const planned = [
      "/start - Check the plugin connection",
      "/sessions - List active sessions",
      "/use <short-id> - Select a session",
      "/status - Show selected session status",
      "/todo - Show selected session todos",
      "/usage - Show selected session token usage and cost",
    ];
    const listItems = commands
      .map((command) => `<li>${this.escapeHtml(command)}</li>`)
      .join("");
    const plannedItems = planned
      .map((command) => `<li>${this.escapeHtml(command)}</li>`)
      .join("");
    return [
      `<p>${ICON_HELP} Commands:</p>`,
      `<ul>${listItems}</ul>`,
      "<p>Planned (not available yet):</p>",
      `<ul>${plannedItems}</ul>`,
      "<p>This bot is read-only. Approvals and answers must be handled in OpenCode.</p>",
    ].join("\n");
  }

  private enqueueMessage(text: string) {
    if (this.disposed) return;
    const operation = this.sendTail.then(() => this.sendMessage(text));
    this.sendTail = operation.catch(() => undefined);
    this.track(operation, "Telegram message send failed");
  }

  private enqueueMessageWithKeyboard(
    text: string,
    replyMarkup: TelegramInlineKeyboard,
  ) {
    if (this.disposed) return;
    const operation = this.sendTail.then(() =>
      this.sendMessageWithKeyboard(text, replyMarkup),
    );
    this.sendTail = operation.catch(() => undefined);
    this.track(operation, "Telegram message send failed");
  }

  private async sendMessage(text: string) {
    if (this.abortController.signal.aborted) return;
    await this.telegramWithRetry("sendRichMessage", {
      chat_id: this.config.chatId,
      rich_message: { html: this.limitMessage(text) },
    });
  }

  private async sendMessageWithKeyboard(
    text: string,
    replyMarkup: TelegramInlineKeyboard,
  ) {
    if (this.abortController.signal.aborted) return;
    await this.telegramWithRetry("sendRichMessage", {
      chat_id: this.config.chatId,
      rich_message: { html: this.limitMessage(text) },
      reply_markup: replyMarkup,
    });
  }

  private async telegramWithRetry<T>(
    method: string,
    body: Record<string, unknown>,
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TELEGRAM_SEND_ATTEMPTS; attempt += 1) {
      if (this.abortController.signal.aborted)
        throw new Error("Plugin disposed");
      try {
        return await this.telegramRequest<T>(
          method,
          body,
          TELEGRAM_SEND_TIMEOUT_MS,
        );
      } catch (error) {
        if (this.abortController.signal.aborted) throw error;
        lastError = error;
        if (error instanceof TelegramApiError && error.errorCode === 401)
          throw error;
        if (attempt === TELEGRAM_SEND_ATTEMPTS) break;
        const retryAfter =
          error instanceof TelegramApiError ? error.retryAfter : undefined;
        await this.sleep(
          retryAfter ? retryAfter * 1_000 : 2 ** (attempt - 1) * 1_000,
        );
      }
    }
    throw lastError;
  }

  private async telegramRequest<T>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ) {
    if (this.abortController.signal.aborted) throw new Error("Plugin disposed");
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    this.abortController.signal.addEventListener("abort", abortRequest, {
      once: true,
    });
    const timeout = setTimeout(abortRequest, timeoutMs);

    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;
      if (this.config.proxy) {
        return await this.requestViaProxy<T>(
          url,
          body,
          requestController.signal,
          timeoutMs,
        );
      }
      return await this.requestDirect<T>(url, body, requestController.signal);
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener("abort", abortRequest);
    }
  }

  private async requestDirect<T>(
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const envelope = (await response.json()) as TelegramEnvelope<T>;
    if (!response.ok || !envelope.ok || envelope.result === undefined) {
      throw new TelegramApiError(
        envelope.description ?? `Telegram HTTP ${response.status}`,
        envelope.error_code ?? response.status,
        envelope.parameters?.retry_after,
      );
    }
    return envelope.result;
  }

  private async requestViaProxy<T>(
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ) {
    const proxy = this.parseProxy(this.config.proxy!);
    const target = new URL(url);
    const targetPort = Number(target.port) || 443;
    const payload = JSON.stringify(body);
    const methodName = target.pathname.split("/").pop() ?? "?";

    dline(`requestViaProxy[${methodName}] start`);
    const socket = await this.openTunnel(
      proxy,
      target.hostname,
      targetPort,
      signal,
      timeoutMs,
    );
    dline(`requestViaProxy[${methodName}] tunnel ok`);

    const secure = tlsConnect({ socket, servername: target.hostname });
    await new Promise<void>((resolveTLS, rejectTLS) => {
      const onAbort = () => secure.destroy(new Error("Plugin disposed"));
      const onError = (error: Error) => {
        cleanup();
        rejectTLS(error);
      };
      const onConnect = () => {
        cleanup();
        resolveTLS();
      };
      const cleanup = () => {
        secure.removeListener("secureConnect", onConnect);
        secure.removeListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      secure.once("secureConnect", onConnect);
      secure.once("error", onError);
    });
    dline(`requestViaProxy[${methodName}] tls ok`);

    // Send the HTTP request directly over the TLS socket instead of wrapping it
    // with http.request(): using http.request({ createConnection }) over a proxy
    // CONNECT tunnel hangs (the request never completes and abort cannot reject
    // it), which kept deleteWebhook/polling stuck forever. Direct writes work
    // reliably over the tunnel (verified against the Telegram API).
    const response = await new Promise<{ status: number; body: string }>(
      (resolveResponse, reject) => {
        let responseBuffer = Buffer.alloc(0);
        let settled = false;

        const cleanup = () => {
          secure.removeListener("data", onData);
          secure.removeListener("end", onEnd);
          secure.removeListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const finish = (status: number, body: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          dline(
            `requestViaProxy[${methodName}] http done status=${status} bodyLen=${body.length}`,
          );
          resolveResponse({ status, body });
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          dline(
            `requestViaProxy[${methodName}] http fail: ${(error as Error).message}`,
          );
          reject(error);
        };
        const onAbort = () => fail(new Error("Plugin disposed"));
        const onError = (error: Error) => fail(error);
        const onEnd = () => {
          dline(`requestViaProxy[${methodName}] http end`);
          // Connection: close — stream ended; parse whatever we buffered.
          if (!settled) {
            const headerEnd = responseBuffer.indexOf("\r\n\r\n");
            if (headerEnd >= 0) {
              const head = responseBuffer.toString("latin1", 0, headerEnd);
              const status =
                Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1]) || 0;
              finish(
                status,
                responseBuffer.subarray(headerEnd + 4).toString("utf8"),
              );
            } else {
              fail(new Error("Connection closed before HTTP response"));
            }
          }
        };
        const onData = (chunk: Buffer) => {
          responseBuffer = Buffer.concat([responseBuffer, chunk]);
          const headerEnd = responseBuffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const head = responseBuffer.toString("latin1", 0, headerEnd);
          dline(
            `requestViaProxy[${methodName}] http header (${responseBuffer.length} bytes): ${head.split("\r\n")[0]}`,
          );
          const status =
            Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1]) || 0;
          const contentLengthMatch = /content-length:\s*(\d+)/i.exec(head);
          const body = responseBuffer.subarray(headerEnd + 4).toString("utf8");
          if (contentLengthMatch) {
            const len = Number(contentLengthMatch[1]);
            if (Buffer.byteLength(body) >= len) {
              finish(status, body.slice(0, len));
            }
          } else if (body.length > 0 || /^HTTP\/\d(?:\.\d)?\s+204/.test(head)) {
            // Telegram always sends content-length; fall back for edge cases.
            finish(status, body);
          }
        };

        signal.addEventListener("abort", onAbort, { once: true });
        secure.on("data", onData);
        secure.on("end", onEnd);
        secure.on("error", onError);
        secure.setTimeout(timeoutMs, () =>
          fail(new Error("Telegram request timed out")),
        );
        secure.write(
          `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
            `Host: ${target.hostname}\r\n` +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
            "Connection: close\r\n" +
            "\r\n" +
            payload,
        );
        dline(
          `requestViaProxy[${methodName}] http written, waiting for response`,
        );
      },
    );

    let envelope: TelegramEnvelope<T>;
    try {
      envelope = JSON.parse(response.body) as TelegramEnvelope<T>;
    } catch {
      throw new TelegramApiError(`Telegram HTTP ${response.status}`);
    }
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !envelope.ok ||
      envelope.result === undefined
    ) {
      throw new TelegramApiError(
        envelope.description ?? `Telegram HTTP ${response.status}`,
        envelope.error_code ?? response.status,
        envelope.parameters?.retry_after,
      );
    }
    return envelope.result;
  }

  private parseProxy(value: string): ProxySpec {
    const parsed = new URL(value);
    const secure = parsed.protocol === "https:";
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || (secure ? 443 : 80),
      secure,
      auth: parsed.username
        ? Buffer.from(
            `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
          ).toString("base64")
        : undefined,
    };
  }

  private openTunnel(
    proxy: ProxySpec,
    targetHost: string,
    targetPort: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Socket> {
    return new Promise((resolveTunnel, reject) => {
      const socket = proxy.secure
        ? tlsConnect({
            host: proxy.host,
            port: proxy.port,
            servername: proxy.host,
          })
        : netConnect({ host: proxy.host, port: proxy.port });

      let settled = false;
      let buffer = Buffer.alloc(0);
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        socket.removeListener("error", onError);
        socket.removeListener("data", onData);
        socket.removeListener("end", onEnd);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onError = (error: Error) => fail(error);
      const onEnd = () =>
        fail(new Error("Proxy closed before CONNECT completed"));
      const onAbort = () => fail(new Error("Plugin disposed"));
      const onTimeout = () => fail(new Error("Proxy CONNECT timed out"));

      timer = setTimeout(onTimeout, timeoutMs);
      socket.on("error", onError);
      socket.on("end", onEnd);
      signal.addEventListener("abort", onAbort, { once: true });

      const onData = (chunk: Buffer) => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (buffer.length > 64 * 1024)
            fail(new Error("Proxy CONNECT response too large"));
          return;
        }
        const head = buffer.toString("latin1", 0, headerEnd);
        const status =
          Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1]) || 0;
        if (status >= 200 && status < 300) {
          settled = true;
          cleanup();
          socket.pause();
          const leftover = buffer.subarray(headerEnd + 4);
          if (leftover.length > 0) socket.unshift(leftover);
          resolveTunnel(socket);
        } else {
          fail(
            new TelegramApiError(
              `Proxy CONNECT rejected with HTTP ${status}`,
              status || undefined,
            ),
          );
        }
      };
      socket.on("data", onData);

      const authority = `${targetHost}:${targetPort}`;
      let connectRequest = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
      if (proxy.auth) {
        connectRequest += `Proxy-Authorization: Basic ${proxy.auth}\r\n`;
      }
      connectRequest += "Proxy-Connection: keep-alive\r\n\r\n";
      socket.write(connectRequest);
    });
  }

  private async sleep(ms: number) {
    if (this.abortController.signal.aborted) return;
    await new Promise<void>((resolveSleep) => {
      const finish = () => {
        clearTimeout(timer);
        this.abortController.signal.removeEventListener("abort", finish);
        resolveSleep();
      };
      const timer = setTimeout(finish, ms);
      this.abortController.signal.addEventListener("abort", finish, {
        once: true,
      });
    });
  }

  private childSessions(parentID: string) {
    return [...this.sessions.values()].filter((candidate) => {
      let current = candidate.info?.parentID;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        if (current === parentID) return true;
        seen.add(current);
        current = this.sessionInfo.get(current)?.parentID;
      }
      return false;
    });
  }

  private aggregateTokens(session: SessionProjection) {
    const totals = this.emptyTokens();
    for (const item of [session, ...this.childSessions(session.sessionID)]) {
      totals.input += item.tokens.input;
      totals.output += item.tokens.output;
      totals.reasoning += item.tokens.reasoning;
      totals.cacheRead += item.tokens.cacheRead;
      totals.cacheWrite += item.tokens.cacheWrite;
      totals.cost += item.tokens.cost;
      totals.hasCost = totals.hasCost || item.tokens.hasCost;
    }
    return totals;
  }

  private safeToolTarget(tool: string, input?: Record<string, unknown>) {
    if (!input) return undefined;
    const normalized = tool.toLowerCase();

    if (["read", "edit", "write", "glob", "grep"].includes(normalized)) {
      const path =
        this.string(input.filePath) ??
        this.string(input.path) ??
        this.string(input.directory);
      return path ? this.safePath(path) : undefined;
    }

    if (["bash", "shell"].includes(normalized)) {
      const command = this.string(input.command);
      if (!command) return "shell command";
      const words = command.trim().split(/\s+/);
      const executable = words.find((word) => !word.includes("="));
      return executable
        ? `command: ${this.safeText(basename(executable), 60)}`
        : "shell command";
    }

    if (normalized === "task") {
      return "subtask";
    }

    return undefined;
  }

  private safeProgress(
    structured: Record<string, unknown> | undefined,
    content: unknown,
  ) {
    if (structured) {
      const status = this.string(structured.status)?.toLowerCase();
      if (
        status &&
        ["pending", "running", "processing", "completed", "error"].includes(
          status,
        )
      ) {
        return status;
      }
      const percent = this.number(structured.percent);
      if (percent !== undefined && percent >= 0 && percent <= 100)
        return `${percent}%`;
    }

    if (Array.isArray(content)) {
      const file = content
        .map(this.record)
        .find((item) => item?.type === "file");
      const name = this.string(file?.name);
      const uri = this.string(file?.uri);
      if (name) return `file: ${this.safePath(name)}`;
      if (uri?.startsWith("file://")) {
        try {
          return `file: ${this.safePath(new URL(uri).pathname)}`;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  private safePath(value: string) {
    const absolute = isAbsolute(value)
      ? resolve(value)
      : resolve(this.root, value);
    const projectRelative = relative(this.root, absolute);
    if (
      projectRelative &&
      !projectRelative.startsWith("..") &&
      !isAbsolute(projectRelative)
    ) {
      return this.safeText(projectRelative, 180);
    }
    if (!projectRelative) return ".";
    return this.safeText(basename(value), 180);
  }

  private safeText(value: string, limit: number) {
    const redacted = value
      .replace(
        /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gi,
        "[REDACTED_KEY]",
      )
      .replaceAll(this.config.botToken, "[REDACTED]")
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
      .replace(
        /\b(?:sk-(?:ant-)?|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/gi,
        "[REDACTED]",
      )
      .replace(/\b(?:github_pat_|npm_|hf_)[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
      .replace(
        /\b(?:glpat-|xox[baprs]-|pypi-)[A-Za-z0-9_-]{12,}\b/gi,
        "[REDACTED]",
      )
      .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[REDACTED]")
      .replace(
        /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        "[REDACTED]",
      )
      .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
      .replace(
        /\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD|PASSWD|SECRET|TOKEN|AUTHORIZATION|CREDENTIALS|COOKIE)[A-Z0-9_]*\b\s*[:=]\s*[^\s,;]+/gi,
        "[REDACTED_SECRET]",
      )
      .replace(
        /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+/gi,
        "[REDACTED_URL]",
      )
      .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[REDACTED_VALUE]")
      .replaceAll(this.root, "<project>")
      .replace(/(^|[\s=:"'(])\/(?:[^\s/]+\/)*[^\s,;)]*/g, "$1<external-path>")
      .replace(/\s+/g, " ")
      .trim();
    return redacted.length <= limit
      ? redacted
      : `${redacted.slice(0, limit - 3)}...`;
  }

  private escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  /**
   * Build a compact two-column Rich-Message table out of field rows. The
   * `compact` attribute keeps cell indents small so rows do not waste height;
   * label/value cells size themselves to the content, so long values wrap
   * inside their own cell instead of running back to the left margin.
   */
  private fieldTable(rows: string[]) {
    return `<table compact>${rows.join("")}</table>`;
  }

  /**
   * One table row: a bold label cell and an escaped value cell.
   */
  private fieldRow(label: string, value: string) {
    return `<tr><th>${label}</th><td>${this.escapeHtml(value)}</td></tr>`;
  }

  /**
   * Title line shown above a notification table: the icon followed by the
   * project name. Kept as a plain paragraph (not a table cell) so Telegram's
   * notification preview picks up its text.
   */
  private titleLine(icon: string) {
    return this.paragraph(`${icon} ${this.projectLabel}`);
  }

  /**
   * Wrap a plain-text line into an HTML paragraph for Rich Messages.
   */
  private paragraph(text: string) {
    return `<p>${this.escapeHtml(text)}</p>`;
  }

  private summarizeError(value: unknown): ErrorSummary {
    const error = this.record(value);
    const data = this.record(error?.data);
    const name =
      this.string(error?.name) ?? this.string(error?.type) ?? "OpenCodeError";
    const statusCode = this.number(data?.statusCode);
    const message =
      name === "APIError"
        ? statusCode
          ? `Provider request failed with HTTP ${statusCode}`
          : "Provider request failed"
        : name === "ProviderAuthError"
          ? "Provider authentication failed"
          : name === "MessageOutputLengthError"
            ? "Model output exceeded its limit"
            : name === "MessageAbortedError"
              ? "Session was cancelled locally"
              : undefined;
    return {
      name: this.safeText(name, 80),
      message: message ? this.safeText(message, 180) : undefined,
      cancelled:
        name === "MessageAbortedError" || name.toLowerCase().includes("abort"),
    };
  }

  private sessionLabel(session: SessionProjection) {
    return `${this.sessionTitle(session)} | ${this.shortID(session.sessionID)}`;
  }

  private sessionTitle(session: SessionProjection) {
    return this.safeText(session.info?.title ?? "Untitled session", 100);
  }

  private displayState(session: SessionProjection) {
    if (session.waitingByRequestID.size > 0) return "waiting";
    if (session.status === "busy") return "running";
    if (session.status === "retry") return "retrying";
    return session.outcome ?? "idle";
  }

  private iconForOutcome(outcome: SessionOutcome) {
    switch (outcome) {
      case "completed":
        return ICON_COMPLETED;
      case "failed":
        return ICON_FAILED;
      case "cancelled":
        return ICON_CANCELLED;
    }
  }

  private iconForState(state: ReturnType<TelegramSessionMonitor["displayState"]>) {
    switch (state) {
      case "running":
        return ICON_RUNNING;
      case "retrying":
        return ICON_RETRYING;
      case "waiting":
        return ICON_WAITING;
      case "completed":
        return ICON_COMPLETED;
      case "failed":
        return ICON_FAILED;
      case "cancelled":
        return ICON_CANCELLED;
      case "idle":
        return ICON_IDLE;
    }
  }

  private iconForWaitingType(type: WaitingType) {
    return type === "permission" ? ICON_PERMISSION : ICON_QUESTION;
  }

  private todoCounts(todos: Todo[]) {
    return {
      inProgress: todos.filter((todo) => todo.status === "in_progress").length,
      pending: todos.filter((todo) => todo.status === "pending").length,
      completed: todos.filter((todo) => todo.status === "completed").length,
      cancelled: todos.filter((todo) => todo.status === "cancelled").length,
      total: todos.length,
    };
  }

  private todoSummary(
    counts: ReturnType<TelegramSessionMonitor["todoCounts"]>,
  ) {
    if (counts.total === 0) return "none reported";
    return `${counts.completed}/${counts.total} completed, ${counts.inProgress} in progress, ${counts.pending} pending, ${counts.cancelled} cancelled`;
  }

  private totalTokens(tokens: TokenTotals) {
    return (
      tokens.input +
      tokens.output +
      tokens.reasoning +
      tokens.cacheRead +
      tokens.cacheWrite
    );
  }

  private emptyTokens(): TokenTotals {
    return {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      hasCost: false,
    };
  }

  private formatNumber(value: number) {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
  }

  private formatCost(tokens: TokenTotals) {
    if (!tokens.hasCost) return "N/A";
    if (tokens.cost >= 1) return `$${tokens.cost.toFixed(2)}`;
    if (tokens.cost >= 0.01) return `$${tokens.cost.toFixed(3)}`;
    return `$${tokens.cost.toFixed(4)}`;
  }

  private formatDuration(milliseconds: number) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  private shortID(sessionID: string) {
    const normalized = sessionID.startsWith("ses_")
      ? sessionID.slice(4)
      : sessionID;
    return normalized.slice(0, 8);
  }

  private matchesSessionID(sessionID: string, candidate: string) {
    const normalizedCandidate = candidate.trim().toLowerCase();
    const normalizedID = sessionID.toLowerCase();
    const withoutPrefix = normalizedID.startsWith("ses_")
      ? normalizedID.slice(4)
      : normalizedID;
    return (
      normalizedID === normalizedCandidate ||
      normalizedID.startsWith(normalizedCandidate) ||
      withoutPrefix.startsWith(normalizedCandidate)
    );
  }

  private limitMessage(text: string) {
    if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
    // Reserve room for the truncation marker.
    const RESERVED = "\n... truncated".length;
    const cut = TELEGRAM_MESSAGE_LIMIT - RESERVED;
    let truncated = text.slice(0, cut);
    // Back up to the previous tag boundary if we sliced mid-tag so we never
    // leave a half-written <table>/<tr>/<td>/<b>... that would break parsing.
    const lt = truncated.lastIndexOf("<");
    const gt = truncated.lastIndexOf(">");
    if (lt > gt) truncated = truncated.slice(0, lt);
    truncated += "\n... truncated";
    // Close any block/formatting tags left open by the cut so the rich HTML
    // parser does not reject the message.
    const openClose: Array<[RegExp, string, string]> = [
      [/<table>/g, /<\/table>/g, "</table>"],
      [/<tr>/g, /<\/tr>/g, "</tr>"],
      [/<td>/g, /<\/td>/g, "</td>"],
      [/<th>/g, /<\/th>/g, "</th>"],
      [/<ul>/g, /<\/ul>/g, "</ul>"],
      [/<li>/g, /<\/li>/g, "</li>"],
      [/<p>/g, /<\/p>/g, "</p>"],
      [/<code>/g, /<\/code>/g, "</code>"],
      [/<b>/g, /<\/b>/g, "</b>"],
    ];
    for (const [openRe, closeRe, closeTag] of openClose) {
      const opens = (truncated.match(openRe) ?? []).length;
      const closes = (truncated.match(closeRe) ?? []).length;
      if (opens > closes) truncated += closeTag.repeat(opens - closes);
    }
    return truncated;
  }

  private status(value: unknown): SessionStatus | undefined {
    const status = this.record(value);
    const type = this.string(status?.type);
    if (type === "idle" || type === "busy") return { type };
    if (type !== "retry") return undefined;
    return {
      type: "retry",
      attempt: this.number(status?.attempt) ?? 1,
      message: this.safeText(
        this.string(status?.message) ?? "Provider retry",
        120,
      ),
      next: this.number(status?.next) ?? Date.now(),
    };
  }

  private session(value: unknown): Session | undefined {
    const info = this.record(value);
    if (!info || typeof info.id !== "string" || typeof info.title !== "string")
      return undefined;
    return info as Session;
  }

  private parseRuntimeEvent(value: unknown): RuntimeEvent | undefined {
    const event = this.record(value);
    const type = this.string(event?.type);
    const properties = this.record(event?.properties);
    if (!event || !type || !properties) return undefined;
    return { id: this.string(event.id), type, properties };
  }

  private rememberEvent(eventID?: string) {
    if (!eventID) return true;
    if (this.seenEventIDs.has(eventID)) return false;
    this.rememberBounded(this.seenEventIDs, eventID);
    return true;
  }

  private rememberBounded(set: Set<string>, value: string) {
    set.add(value);
    if (set.size <= MAX_EVENT_IDS) return;
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }

  private isTodo = (value: unknown): value is Todo => {
    const todo = this.record(value);
    return Boolean(
      todo && typeof todo.id === "string" && typeof todo.content === "string",
    );
  };

  private record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private string(value: unknown) {
    return typeof value === "string" ? value : undefined;
  }

  private number(value: unknown) {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  private errorCategory(error: unknown) {
    if (error instanceof TelegramApiError) {
      return `TelegramApiError${error.errorCode ? `(${error.errorCode})` : ""}`;
    }
    if (error instanceof Error) return this.safeText(error.name, 80);
    return "UnknownError";
  }

  private track(promise: Promise<void>, failureMessage: string) {
    let tracked: Promise<void>;
    tracked = promise
      .catch((error) =>
        this.log("error", failureMessage, {
          error: this.errorCategory(error),
        }),
      )
      .finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  private async log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    try {
      await this.client.app.log({
        body: {
          service: SERVICE,
          level,
          message,
          extra,
        },
      });
    } catch {
      const method =
        level === "error"
          ? console.error
          : level === "warn"
            ? console.warn
            : console.log;
      method(`[${SERVICE}] ${message}`);
    }
  }
}

type RegistryEntry = {
  path: string;
  enabled: boolean;
  addedAt: string;
};

type ProjectRegistry = {
  projects: RegistryEntry[];
};

const EMPTY_REGISTRY: ProjectRegistry = { projects: [] };

function normalizeRegistryPath(path: string) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseRegistry(text: string): ProjectRegistry | undefined {
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

function serializeRegistry(registry: ProjectRegistry) {
  return JSON.stringify(registry, null, 2);
}

function findRegistryEntry(
  registry: ProjectRegistry,
  rootPath: string,
): RegistryEntry | undefined {
  const normalized = normalizeRegistryPath(rootPath);
  return registry.projects.find(
    (entry) => normalizeRegistryPath(entry.path) === normalized,
  );
}

function registerProject(
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
function entryToken(rootPath: string) {
  const normalized = normalizeRegistryPath(rootPath);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function findEntryByToken(
  registry: ProjectRegistry,
  token: string,
): RegistryEntry | undefined {
  return registry.projects.find((entry) => entryToken(entry.path) === token);
}

/**
 * 幂等设值：目标状态与当前一致时返回原引用（无写入）；路径不存在返回 undefined。
 */
function setProjectEnabled(
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
function deleteProjectByPath(
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

class ProjectRegistryStore {
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

async function loadConfig(
  configPath: string,
): Promise<TelegramConfig | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Telegram config must be a JSON object");
  }

  const config = value as Record<string, unknown>;
  if (
    typeof config.botToken !== "string" ||
    !/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.botToken)
  ) {
    throw new Error("Telegram config has an invalid botToken");
  }
  if (typeof config.chatId !== "string" || !/^\d+$/.test(config.chatId)) {
    throw new Error("Telegram config has an invalid chatId");
  }
  let proxy: string | undefined;
  if (config.proxy !== undefined) {
    if (typeof config.proxy !== "string") {
      throw new Error("Telegram config has an invalid proxy");
    }
    try {
      const parsed = new URL(config.proxy);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
      proxy = config.proxy;
    } catch {
      throw new Error("Telegram config has an invalid proxy");
    }
  }

  return {
    botToken: config.botToken,
    chatId: config.chatId,
    proxy,
  };
}

function isMissingFile(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

async function writeInitializationError(
  client: PluginInput["client"],
  message: string,
) {
  try {
    await client.app.log({
      body: {
        service: SERVICE,
        level: "error",
        message,
      },
    });
  } catch {
    console.error(`[${SERVICE}] ${message}`);
  }
}

export default (async ({ client, directory, worktree }) => {
  const root = worktree === "/" ? directory : worktree;
  const otgDir = OTG_DIR;
  const configPath = join(otgDir, "telegram.json");

  let config: TelegramConfig | undefined;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    const category =
      error instanceof SyntaxError ? "invalid JSON" : "invalid configuration";
    await writeInitializationError(
      client,
      `Telegram plugin disabled: ${category}`,
    );
    return {};
  }

  if (!config) return {};

  const registry = new ProjectRegistryStore(
    join(otgDir, "projects.json"),
    (message) =>
      client.app.log({
        body: { service: SERVICE, level: "warn", message },
      }),
  );
  try {
    await registry.ensureDir();
    await registry.mutate((reg) => registerProject(reg, root));
  } catch (error) {
    await writeInitializationError(
      client,
      `Telegram plugin disabled: cannot initialize ~/.otg registry: ${(error as Error).message}`,
    );
    return {};
  }

  const monitor = new TelegramSessionMonitor(client, config, root, registry);
  monitor.initialize();

  return {
    event: async ({ event }) => {
      monitor.accept(event);
    },
    dispose: () => monitor.dispose(),
  };
}) satisfies Plugin;
