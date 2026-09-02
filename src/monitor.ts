import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { PluginInput } from "@opencode-ai/plugin";
import type {
  AssistantMessage,
  Part,
  Session,
  SessionStatus,
  Todo,
  ToolPart,
} from "@opencode-ai/sdk";

import {
  ICON_READY,
  ICON_SESSIONS,
  ICON_STATUS,
  IDLE_DEBOUNCE_MS,
  OTG_DIR,
  PLANNED_COMMANDS,
  POLLER_ACQUIRE_INTERVAL_MS,
  POLLER_LOCK_TTL_MS,
  REGISTER_INTERVAL_MS,
  SESSIONS_SCAN_INTERVAL_MS,
  TELEGRAM_POLL_SECONDS,
  TELEGRAM_POLL_TIMEOUT_MS,
  WAITING_NOTIFY_DEBOUNCE_MS,
} from "./constants";
import {
  NPM_PACKAGE_NAME,
  NPM_REGISTRY_BASE,
  OPENCODE_CACHE_MARKERS,
  PLUGIN_VERSION,
  SELF_UPDATE_FETCH_TIMEOUT_MS,
  SERVICE,
  TARGET_OPENCODE_VERSION,
} from "./version";
import { dline } from "./diagnostics";
import {
  buildMenuKeyboard,
  buildSessionPermissionKeyboard,
  PERM_CB_PREFIX,
  childSessions,
  displayState,
  emptyTokens,
  errorCategory,
  escapeHtml,
  fieldRow,
  fieldTable,
  formatStatus,
  formatTerminalNotification,
  formatTodos,
  formatUsage,
  helpText,
  iconForWaitingType,
  limitMessage,
  matchesSessionID,
  menuText,
  number,
  paragraph,
  record,
  rememberBounded,
  safeProgress,
  safeText,
  safeToolTarget,
  sessionLabel,
  sessionTitle,
  shortID,
  status as coerceStatus,
  string,
  summarizeError,
  titleLine,
} from "./format";
import { PollerLock } from "./infra/poller-lock";
import {
  appendSessionRecord,
  deleteProjectByPath,
  findEntryByToken,
  findRegistryEntry,
  markSessionResolved,
  markSessionSent,
  registerProject,
  setProjectEnabled,
  setSessionReply,
  type ProjectRegistry,
  type ProjectRegistryStore,
  type SessionRecord,
} from "./registry";
import {
  TelegramApiError,
  telegramRequest,
  telegramWithRetry,
} from "./telegram";
import type {
  LogLevel,
  RuntimeEvent,
  SessionOutcome,
  SessionProjection,
  SessionState,
  TelegramCallbackQuery,
  TelegramConfig,
  TelegramInlineKeyboard,
  TelegramUpdate,
  ToolProjection,
  WaitingProjection,
} from "./types";

dline("MODULE LOADED");

export class TelegramSessionMonitor {
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
    join(OTG_DIR, "poller.lock"),
    POLLER_LOCK_TTL_MS,
  );
  private pollerRetryTimer?: ReturnType<typeof setTimeout>;
  private registerTimer?: ReturnType<typeof setTimeout>;
  private selfUpdateTimer?: ReturnType<typeof setTimeout>;
  // sessions 扫描 ticker（契约 sessions-relay.md §6.2）：与 poller.lock
  // 同生共死，仅锁持有者运行；sessionsScanInFlight 防止上一轮未跑完时重叠。
  private sessionsScanTimer?: ReturnType<typeof setInterval>;
  private sessionsScanInFlight = false;
  // reply 消费扫描 ticker（契约 sessions-relay.md §13.6）：每个 opencode 实例
  // 独立运行（与 poller.lock 无关），发现 TG 按钮写入的 reply 后调 opencode
  // reply API 应用，成功后置 resolved=true；replyScanInFlight 防止上一轮未跑完
  // 时重叠（决策 #5）。
  private replyScanTimer?: ReturnType<typeof setInterval>;
  private replyScanInFlight = false;

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
    this.startReplyScan();
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
      dline(`self-update: unexpected error: ${errorCategory(error, { root: this.root, botToken: this.config.botToken })}`);
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

    // 2) 校验暂存区内容：package.json 的 version 与目标版本一致。
    //    （bundle 产物 monitor.ts 中 PLUGIN_VERSION 被 bun 改写为 var 形态，
    //     const 字面量断言在拆分后不成立——见 split-contracts §4 兜底决策。）
    const stagedPkgPath = join(stagingDir, "package", "package.json");
    try {
      const staged = JSON.parse(
        await fsReadFile(stagedPkgPath, "utf8"),
      ) as { version?: unknown };
      if (staged.version !== latest) {
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
      const fresh = JSON.parse(
        await fsReadFile(join(currentDir, "package.json"), "utf8"),
      ) as { version?: unknown };
      if (fresh.version !== latest) {
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
      dline(`self-update: download failed: ${errorCategory(error, { root: this.root, botToken: this.config.botToken })}`);
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

    // reply 消费扫描 ticker 清理（契约 sessions-relay.md §13.6：dispose 后无残留 interval）。
    if (this.replyScanTimer) {
      clearInterval(this.replyScanTimer);
      this.replyScanTimer = undefined;
    }
    this.replyScanInFlight = false;

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
    const sessionID = string(properties.sessionID);

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
        const status = coerceStatus(properties.status, { root: this.root, botToken: this.config.botToken });
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
        this.ensureSession(sessionID).pendingError = summarizeError(
          properties.error,
          { root: this.root, botToken: this.config.botToken },
        );
        return;
      }

      case "message.updated": {
        const info = record(properties.info);
        const id = string(info?.id);
        const idFromMessage = string(info?.sessionID);
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
        const messageID = string(properties.messageID);
        if (!sessionID || !messageID) return;
        const session = this.ensureSession(sessionID);
        session.messagesByID.delete(messageID);
        this.recalculateTokens(session);
        return;
      }

      case "message.part.updated": {
        const part = record(properties.part);
        if (!part) return;
        this.applyPart(part as Part);
        return;
      }

      case "message.part.removed": {
        const partID = string(properties.partID);
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
        const requestID = string(properties.id);
        if (!requestID) return;
        const permission =
          string(properties.permission) ??
          string(properties.action) ??
          "permission";
        const tool = record(properties.tool);
        const source = record(properties.source);
        this.addWaiting(sessionID, {
          requestID,
          type: "permission",
          summary: `${safeText(permission, 80, { root: this.root, botToken: this.config.botToken })} permission`,
          toolCallID: string(tool?.callID) ?? string(source?.callID),
        }, properties);
        return;
      }

      case "permission.updated": {
        if (!sessionID) return;
        const requestID = string(properties.id);
        if (!requestID) return;
        const permission = string(properties.type) ?? "permission";
        this.addWaiting(sessionID, {
          requestID,
          type: "permission",
          summary: `${safeText(permission, 80, { root: this.root, botToken: this.config.botToken })} permission`,
          toolCallID: string(properties.callID),
        }, properties);
        return;
      }

      case "permission.replied":
      case "permission.v2.replied": {
        if (!sessionID) return;
        const requestID =
          string(properties.requestID) ??
          string(properties.permissionID);
        if (requestID) {
          const debounceActive = this.waitingNotifyTimers.has(requestID);
          this.cancelWaitingNotify(requestID);
          this.ensureSession(sessionID).waitingByRequestID.delete(requestID);
          if (!debounceActive) {
            // 记录已落盘（去抖窗口已过）：按 request_id 回写 resolved=true
            this.track(
              this.resolveWaitingRecord(requestID),
              "Session resolved mark failed",
            );
          }
        }
        return;
      }

      case "question.asked":
      case "question.v2.asked": {
        if (!sessionID) return;
        const requestID = string(properties.id);
        if (!requestID) return;
        const questions = Array.isArray(properties.questions)
          ? properties.questions
          : [];
        const firstQuestion = record(questions[0]);
        const header = string(firstQuestion?.header);
        const question = string(firstQuestion?.question);
        const tool = record(properties.tool);
        this.addWaiting(sessionID, {
          requestID,
          type: "question",
          summary: safeText(
            header ?? question ?? "OpenCode question",
            120,
            { root: this.root, botToken: this.config.botToken },
          ),
          toolCallID: string(tool?.callID),
        }, properties);
        return;
      }

      case "question.replied":
      case "question.rejected":
      case "question.v2.replied":
      case "question.v2.rejected": {
        if (!sessionID) return;
        const requestID = string(properties.requestID);
        if (requestID) {
          const debounceActive = this.waitingNotifyTimers.has(requestID);
          this.cancelWaitingNotify(requestID);
          this.ensureSession(sessionID).waitingByRequestID.delete(requestID);
          if (!debounceActive) {
            // 记录已落盘（question 立即写入，无去抖窗口）：回写 resolved=true
            this.track(
              this.resolveWaitingRecord(requestID),
              "Session resolved mark failed",
            );
          }
        }
        return;
      }

      case "session.next.agent.switched":
      case "session.next.step.started": {
        if (!sessionID) return;
        const agent = string(properties.agent);
        if (agent)
          this.ensureSession(sessionID).agent = safeText(agent, 80, { root: this.root, botToken: this.config.botToken });
        return;
      }

      case "session.next.tool.input.started": {
        if (!sessionID) return;
        const callID = string(properties.callID);
        if (!callID) return;
        this.upsertTool(
          sessionID,
          callID,
          {
            tool: string(properties.name) ?? "tool",
            state: "pending",
          },
          "v2",
        );
        return;
      }

      case "session.next.tool.called": {
        if (!sessionID) return;
        const callID = string(properties.callID);
        if (!callID) return;
        const tool = string(properties.tool) ?? "tool";
        this.upsertTool(
          sessionID,
          callID,
          {
            tool,
            state: "running",
            target: safeToolTarget(tool, record(properties.input), { root: this.root, botToken: this.config.botToken }),
          },
          "v2",
        );
        return;
      }

      case "session.next.tool.progress": {
        if (!sessionID) return;
        const callID = string(properties.callID);
        if (!callID) return;
        const structured = record(properties.structured);
        const progress = safeProgress(structured, properties.content, { root: this.root, botToken: this.config.botToken });
        if (progress) this.upsertTool(sessionID, callID, { progress }, "v2");
        return;
      }

      case "session.next.tool.success":
      case "session.next.tool.failed": {
        if (!sessionID) return;
        const callID = string(properties.callID);
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
        const attempt = number(properties.attempt) ?? 1;
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
    const sessionID = string(part.sessionID);
    if (!sessionID) return;
    const session = this.ensureSession(sessionID);

    if (part.type === "agent") {
      session.agent = safeText(part.name, 80, { root: this.root, botToken: this.config.botToken });
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
        target: safeToolTarget(toolPart.tool, toolPart.state.input, { root: this.root, botToken: this.config.botToken }),
      },
      "stable",
    );
  }

  private addWaiting(
    sessionID: string,
    waiting: WaitingProjection,
    payload: unknown,
  ) {
    const session = this.ensureSession(sessionID);
    if (this.seenWaitingRequestIDs.has(waiting.requestID)) return;
    rememberBounded(this.seenWaitingRequestIDs, waiting.requestID);
    session.waitingByRequestID.set(waiting.requestID, waiting);
    if (waiting.type === "permission") {
      // opencode's auto-approve mode answers permission requests client-side
      // within milliseconds of publishing permission.asked. Defer the disk
      // write by a short window so auto-approved requests (which arrive with
      // a permission.replied right after) never reach projects.json; only
      // permissions that are still pending after the window are persisted.
      this.scheduleWaitingNotify(sessionID, waiting, payload);
      return;
    }
    // question: 立即写盘（不去抖，决策 #4）；旧直发 notifyWaiting 已停用。
    this.track(
      this.persistWaitingRecord(sessionID, waiting, payload),
      "Waiting record persist failed",
    );
  }

  private scheduleWaitingNotify(
    sessionID: string,
    waiting: WaitingProjection,
    payload: unknown,
  ) {
    dline(`scheduleWaitingNotify(${waiting.requestID}) type=${waiting.type}`);
    const timer = setTimeout(() => {
      this.waitingNotifyTimers.delete(waiting.requestID);
      if (this.disposed) return;
      this.track(
        this.persistWaitingRecord(sessionID, waiting, payload),
        "Waiting record persist failed",
      );
    }, WAITING_NOTIFY_DEBOUNCE_MS);
    this.waitingNotifyTimers.set(waiting.requestID, timer);
  }

  private cancelWaitingNotify(requestID: string) {
    // 语义 = 「取消待写入」：去抖窗口内收到 replied → clearTimeout，
    // 该 request_id 完全不落盘（auto-approve 零落盘，决策 #4）。
    const timer = this.waitingNotifyTimers.get(requestID);
    if (timer) {
      dline(`cancelWaitingNotify(${requestID})`);
      clearTimeout(timer);
      this.waitingNotifyTimers.delete(requestID);
    }
  }

  /**
   * 落盘一条等待记录（契约 sessions-relay.md §5.1/§5.2，决策 #1/#2/#4）。
   * permission 经去抖窗口（scheduleWaitingNotify 回调）触发；question 立即触发。
   * message = 完整事件 properties 的 JSON 字符串；session_name 经
   * ensureSessionInfo 拉取 title，拉不到兜底 sessionID（不阻塞写盘）。
   * 未注册项目（registry 无 root 条目）→ 跳过写盘并 logWarn；
   * mutate 返回 undefined（抢锁超时）→ logWarn，不重试不抛错。
   */
  private async persistWaitingRecord(
    sessionID: string,
    waiting: WaitingProjection,
    payload: unknown,
  ) {
    if (!findRegistryEntry(await this.registry.read(), this.root)) {
      await this.log(
        "warn",
        "Session record not persisted: project not in projects.json registry",
        { requestID: waiting.requestID },
      );
      return;
    }
    const info = await this.ensureSessionInfo(sessionID).catch(() => undefined);
    const title = info?.title;
    const record: SessionRecord = {
      session_id: sessionID,
      session_name: title
        ? safeText(title, 100, {
            root: this.root,
            botToken: this.config.botToken,
          })
        : sessionID,
      type: waiting.type,
      message: JSON.stringify(payload),
      send: false,
      resolved: false,
      request_id: waiting.requestID,
      created_at: new Date().toISOString(),
    };
    const next = await this.registry.mutate((reg) =>
      appendSessionRecord(reg, this.root, record),
    );
    if (next === undefined) {
      await this.log(
        "warn",
        "Session record persist skipped: registry mutate timeout",
        { requestID: waiting.requestID },
      );
    }
  }

  /**
   * replied/rejected 事件回写（决策 #5，契约 §5.3）：按 request_id 置
   * resolved=true。调用方已先 cancelWaitingNotify 并确认去抖窗口已过
   * （waitingNotifyTimers 无该 requestID —— 写入已发生或从未发生）。
   * mutate 返回 undefined（抢锁超时或无匹配记录）→ logWarn，静默容忍。
   */
  private async resolveWaitingRecord(requestID: string) {
    const next = await this.registry.mutate((reg) =>
      markSessionResolved(reg, requestID),
    );
    if (next === undefined) {
      await this.log(
        "warn",
        "Session resolved mark skipped: registry mutate timeout or no matching record",
        { requestID },
      );
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
      fieldRow("Session", sessionLabel(root, { root: this.root, botToken: this.config.botToken })),
      fieldRow("Type", waiting.type),
    ];
    if (source.sessionID !== root.sessionID) {
      rows.push(fieldRow("Subtask", sessionTitle(source, { root: this.root, botToken: this.config.botToken })));
    }
    if (tool) rows.push(fieldRow("Tool", safeText(tool, 80, { root: this.root, botToken: this.config.botToken })));
    rows.push(fieldRow("Request", waiting.summary));
    const parts = [
      titleLine(iconForWaitingType(waiting.type), this.projectLabel),
      fieldTable(rows),
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
    const blockingDescendant = childSessions(sessionID, this.sessions, this.sessionInfo).some(
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
      rememberBounded(this.terminalMessageIDs, terminalMessageID);

    this.lastCompletedSessionID = sessionID;
    if (await this.isProjectEnabled()) {
      this.enqueueMessage(
        formatTerminalNotification(session, outcome, error, { root: this.root, botToken: this.config.botToken, projectLabel: this.projectLabel, sessions: this.sessions, sessionInfo: this.sessionInfo }),
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
      ? summarizeError(currentMessage.error, { root: this.root, botToken: this.config.botToken })
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
    const descendants = childSessions(parentID, this.sessions, this.sessionInfo).filter(
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
        sessionID: shortID(sessionID),
        error: errorCategory(messagesResult.reason, { root: this.root, botToken: this.config.botToken }),
      });
    }

    if (todoResult.status === "fulfilled" && todoResult.value.data) {
      session.todos = todoResult.value.data;
      todosReconciled = true;
    } else if (todoResult.status === "rejected") {
      await this.log("warn", "Session todo reconciliation failed", {
        sessionID: shortID(sessionID),
        error: errorCategory(todoResult.reason, { root: this.root, botToken: this.config.botToken }),
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
      dline(`reconcileStatuses: FAILED ${errorCategory(error, { root: this.root, botToken: this.config.botToken })}`);
      await this.log("warn", "Session status reconciliation failed", {
        error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
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
        sessionID: shortID(sessionID),
        error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
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
      tokens: emptyTokens(),
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
    const totals = emptyTokens();
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
    // 只有锁持有者每秒扫描 projects.json 中的待发送 sessions 记录
    // （契约 sessions-relay.md §6.2）；ticker 生命周期与锁严格同生共死，
    // 任何退出路径（401、异常、abort/dispose）都经 finally 清理。
    this.startSessionsScan();

    try {
      try {
        dline("deleteWebhook: calling");
        await telegramWithRetry("deleteWebhook", {
          drop_pending_updates: true,
        }, { config: this.config, signal: this.abortController.signal });
        dline("deleteWebhook: OK");
        dline("setMyCommands: calling");
        await telegramWithRetry("setMyCommands", {
          commands: [
            { command: "menu", description: "Manage monitored projects" },
            { command: "help", description: "Show available commands" },
          ],
        }, { config: this.config, signal: this.abortController.signal });
        dline("setMyCommands: OK");
      } catch (error) {
        // Don't bail out if the initial webhook/command setup fails (e.g. a flaky
        // proxy). The poll loop below is resilient: getUpdates errors are retried
        // with backoff, so the poller still comes up and can serve Telegram commands.
        await this.log(
          "error",
          "Telegram initialization failed; continuing to poll",
          {
            error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
          },
        );
        dline(`init failed: ${errorCategory(error, { root: this.root, botToken: this.config.botToken })}; continuing to poll`);
      }

      dline("poll loop: starting");
      let backoff = 1_000;
      while (!this.abortController.signal.aborted) {
        try {
          dline("getUpdates: calling");
          const updates = await telegramRequest<TelegramUpdate[]>(
            "getUpdates",
            {
              timeout: TELEGRAM_POLL_SECONDS,
              allowed_updates: ["message", "callback_query"],
              ...(this.telegramUpdateOffset === undefined
                ? {}
                : { offset: this.telegramUpdateOffset }),
            },
            TELEGRAM_POLL_TIMEOUT_MS,
            { config: this.config, signal: this.abortController.signal },
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
            error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
            retryMs: backoff,
          });
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    } finally {
      this.stopSessionsScan();
      await this.pollerLock.release();
    }
  }

  /**
   * 启动 sessions 扫描 ticker（仅由 runTelegram 持锁成功后调用）。
   * 每秒触发一轮 scanSessionQueue；上一轮未跑完时跳过本轮（in-flight 守卫，
   * 防止发送/置位重叠）。ticker 不负责任何决策，只做周期调用。
   */
  private startSessionsScan() {
    if (this.sessionsScanTimer) return;
    dline("sessions scan: starting 1s ticker");
    this.sessionsScanTimer = setInterval(() => {
      if (this.sessionsScanInFlight) return;
      this.sessionsScanInFlight = true;
      this.track(
        (async () => {
          try {
            await this.scanSessionQueue();
          } finally {
            this.sessionsScanInFlight = false;
          }
        })(),
        "Session queue scan failed",
      );
    }, SESSIONS_SCAN_INTERVAL_MS);
  }

  /** 停止并清理 sessions 扫描 ticker（与锁释放成对出现，幂等）。 */
  private stopSessionsScan() {
    if (this.sessionsScanTimer) {
      clearInterval(this.sessionsScanTimer);
      this.sessionsScanTimer = undefined;
    }
  }

  /**
   * 启动 reply 消费扫描 ticker（契约 sessions-relay.md §13.6）：每个 opencode
   * 实例独立运行 1s 扫描自己项目的条目，发现 TG 按钮写入的 reply 后调
   * opencode reply API 应用，成功后置 resolved=true。与 poller.lock 无关
   * （决策 #5）；上一轮未跑完时跳过本轮（in-flight 守卫）。ticker 不负责任何
   * 决策，只做周期调用。
   */
  private startReplyScan() {
    if (this.replyScanTimer || this.disposed) return;
    dline("reply scan: starting 1s ticker");
    this.replyScanTimer = setInterval(() => {
      if (this.replyScanInFlight) return;
      this.replyScanInFlight = true;
      this.track(
        (async () => {
          try {
            await this.scanReplyQueue();
          } finally {
            this.replyScanInFlight = false;
          }
        })(),
        "Reply queue scan failed",
      );
    }, SESSIONS_SCAN_INTERVAL_MS);
  }

  /** 停止并清理 reply 消费扫描 ticker（与 dispose 成对出现，幂等）。 */
  private stopReplyScan() {
    if (this.replyScanTimer) {
      clearInterval(this.replyScanTimer);
      this.replyScanTimer = undefined;
    }
    this.replyScanInFlight = false;
  }

  /**
   * 扫描一轮 reply 队列（可测试入口，契约 sessions-relay.md §13.6；setInterval
   * 只负责周期调用本方法，测试直接调用即可驱动）：
   * registry.read()（不加锁，最终一致）→ findRegistryEntry(reg, this.root)
   * 只看自己条目 → 筛选 type === "permission" && reply != null &&
   * resolved === false → 逐条串行 applySessionReply（单条异常不中断整轮，
   * 失败已由 applySessionReply logWarn，下轮 ticker 重试）。返回本轮成功
   * 应用条数。
   */
  private async scanReplyQueue(): Promise<number> {
    if (this.disposed) return 0;
    const registry = await this.registry.read();
    const entry = findRegistryEntry(registry, this.root);
    const sessions = entry?.sessions;
    if (!sessions) return 0;
    let applied = 0;
    for (const record of sessions) {
      if (record.type !== "permission") continue;
      // reply == null 覆盖缺失与显式 null（未回复）；resolved 双路径跳过
      // （决策 #6：TUI replied 事件可能已先置位）。
      if (record.reply == null || record.resolved) continue;
      try {
        await this.applySessionReply(record);
        applied += 1;
      } catch (error) {
        // 单条失败不中断整轮；applySessionReply 已 logWarn，这里只继续。
        await this.log(
          "warn",
          "applySessionReply failed; will retry on next reply scan",
          {
            requestId: record.request_id,
            error: errorCategory(error, {
              root: this.root,
              botToken: this.config.botToken,
            }),
          },
        );
      }
    }
    return applied;
  }

  /**
   * 把一条 permission 记录的 reply 应用到 opencode 会话（契约 §13.6/§13.8）。
   * 透传语义（决策 #1）：response = record.reply 原样（"once"|"always"|"reject"），
   * 不映射不校验（parse 已保证合法）。SDK 签名已核验（本机 opencode 安装
   * @opencode-ai/sdk types.gen.d.ts）：
   *   client.postSessionIdPermissionsPermissionId({
   *     path: { id: sessionID, permissionID: requestID },
   *     body: { response },
   *   })
   * 成功（API resolve）→ mutate(markSessionResolved)；失败/抛错 → logWarn
   * 不置位（resolved 保持 false，下轮重试）。已 resolved 记录由调用方筛选跳过。
   */
  private async applySessionReply(record: SessionRecord) {
    if (record.reply == null) return;
    try {
      // throwOnError: true —— HTTP 错误（400/404，如 permission 已被 TUI 处理）
      // 会抛错被捕获 → logWarn 不置位，下轮读到 resolved=true 即跳过。
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: record.session_id, permissionID: record.request_id },
        body: { response: record.reply },
        throwOnError: true,
      });
    } catch (error) {
      await this.log(
        "warn",
        "Permission reply apply failed; resolved stays false, will retry on next scan",
        {
          requestId: record.request_id,
          sessionId: record.session_id,
          error: errorCategory(error, {
            root: this.root,
            botToken: this.config.botToken,
          }),
        },
      );
      throw error;
    }
    const next = await this.registry.mutate((reg) =>
      markSessionResolved(reg, record.request_id),
    );
    if (next === undefined) {
      // 抢锁超时或记录已被删除：resolved 未置位属安全重试态，静默容忍。
      await this.log(
        "warn",
        "markSessionResolved skipped (no match or lock timeout); will retry on next scan",
        { requestId: record.request_id },
      );
    }
  }

  /**
   * 扫描一轮 sessions 队列（可测试入口，契约 sessions-relay.md §6.3；
   * setInterval 只负责周期调用本方法，测试直接调用即可驱动）：
   * registry.read()（不加锁，最终一致）→ 遍历全部条目的 sessions →
   * 筛选 send === false && resolved === false → 逐条串行经 sendMessage 发送
   * → 成功置 send=true（markSessionSent）；失败保留 send=false 下轮重试；
   * resolved=true 为终态不补发（决策 #6）。返回本轮处理条数。
   */
  private async scanSessionQueue(): Promise<number> {
    if (this.disposed) return 0;
    const registry = await this.registry.read();
    let handled = 0;
    for (const entry of registry.projects) {
      const sessions = entry.sessions;
      if (!sessions) continue;
      const projectLabel = basename(entry.path) || this.projectLabel;
      for (const record of sessions) {
        // 契约 §13.3（决策 #6 防御）：reply != null 的记录永不发送——已写
        // reply 走消费端 apply 路径；对 question 记录恒真（无 reply 键）。
        if (record.send || record.resolved || record.reply != null) continue;
        try {
          const text = this.formatSessionRecordMessage(record, projectLabel);
          if (record.type === "permission") {
            // permission 记录带三按钮键盘（契约 §13.3）：awaitable 保发送
            // 成功判定/置位语义，不用 fire-and-forget 的 enqueueMessageWithKeyboard。
            const entryID = this.permissionEntryID(record.request_id);
            if (entryID === undefined) {
              // 多字节超限兜底（契约 §13.4）：退化为无键盘普通消息。
              await this.sendMessage(text);
            } else {
              await this.sendMessageWithKeyboard(
                text,
                buildSessionPermissionKeyboard(entryID),
              );
            }
          } else {
            // question 记录维持无键盘发送（决策 #2）。
            await this.sendMessage(text);
          }
        } catch (error) {
          // 发送失败：不置位、记录日志（token 脱敏），下轮 ticker 自然重试。
          await this.log(
            "warn",
            "Session record send failed; will retry on next scan",
            {
              requestId: record.request_id,
              error: errorCategory(error, {
                root: this.root,
                botToken: this.config.botToken,
              }),
            },
          );
          continue;
        }
        const next = await this.registry.mutate((reg) =>
          markSessionSent(reg, record.request_id),
        );
        if (next === undefined) {
          // 抢锁超时或记录已被删除：send 未置位属安全重试态，静默容忍。
          await this.log(
            "warn",
            "markSessionSent skipped (no match or lock timeout); will retry on next scan",
            { requestId: record.request_id },
          );
        }
        handled += 1;
      }
    }
    return handled;
  }

  /**
   * 短 ID → 完整 requestID 的内存映射（契约 sessions-relay.md §13.4）：
   * callback_data 超 64 字节时用 44 字符短 ID 进键盘并在此登记，回调侧据此
   * 还原。只存于 poller 实例内存、不持久化；进程重启后旧按钮点击 → 还原为
   * raw 找不到记录 → §13.5 无匹配分支，可接受降级。字段放 1.2 区间
   * （契约 §13.7），不占用 140-146 字段区（1.3 地盘）。
   */
  private readonly permShortMap = new Map<string, string>();

  /**
   * 进入键盘的 entryID 换算（契约 sessions-relay.md §13.4）：callback_data
   * `otg:perm:<entryID>:<once|always|reject>` 上限 64 字节（UTF-8）。
   * 全量 ≤ 64 → 原样返回；超限 → 截 44 字符 + permShortMap 登记
   * （44 + 9 + 7 = 60 ≤ 64，ASCII 假设）；多字节字符致 44 字符仍超限 →
   * 返回 undefined（该记录不发按钮，退化为无键盘普通消息）。禁止静默截断
   * callback_data。
   */
  private permissionEntryID(requestID: string): string | undefined {
    const ctx = { root: this.root, botToken: this.config.botToken };
    const full = PERM_CB_PREFIX + requestID + ":always";
    if (Buffer.byteLength(full, "utf8") <= 64) return requestID;
    const shortID = requestID.slice(0, 44);
    const shortFull = PERM_CB_PREFIX + shortID + ":always";
    if (Buffer.byteLength(shortFull, "utf8") > 64) {
      void this.log(
        "error",
        "Permission callback_data exceeds 64 bytes; sending without buttons",
        { requestId: safeText(requestID, 100, ctx) },
      );
      return undefined;
    }
    const previous = this.permShortMap.get(shortID);
    if (previous !== undefined && previous !== requestID) {
      void this.log(
        "warn",
        "Permission short ID collision; overwriting permShortMap",
        { requestId: safeText(requestID, 100, ctx) },
      );
    }
    this.permShortMap.set(shortID, requestID);
    return shortID;
  }

  /**
   * 把一条待发送 SessionRecord 组装为 TG 通知文本（复用等待通知样式，
   * 契约 sessions-relay.md §6.2）：titleLine(iconForWaitingType) +
   * fieldTable(Type / Session 字段) + message 节选；整体经 limitMessage 截断。
   * HTML 转义由 fieldRow/paragraph 内部的 escapeHtml 完成，文本先经
   * safeText 去敏（botToken/密钥/路径）再展示。
   */
  private formatSessionRecordMessage(
    record: SessionRecord,
    projectLabel: string,
  ): string {
    const ctx = { root: this.root, botToken: this.config.botToken };
    const rows = [
      fieldRow("Type", record.type),
      fieldRow(
        "Session",
        safeText(record.session_name || shortID(record.session_id), 100, ctx),
      ),
    ];
    const excerpt = paragraph(safeText(record.message, 300, ctx));
    const parts = [
      titleLine(iconForWaitingType(record.type), projectLabel),
      fieldTable(rows),
      excerpt,
    ];
    return limitMessage(parts.join("\n"));
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
        paragraph(`/${command} is planned but not available yet (计划中).`),
      );
      return;
    }

    switch (command) {
      case "menu":
        await this.commandMenu();
        return;
      case "help":
        this.enqueueMessage(helpText());
        return;
      default:
        this.enqueueMessage(
          `Unknown command: /${escapeHtml(command)}\n\n${helpText()}`,
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
      fieldRow("OpenCode target", TARGET_OPENCODE_VERSION),
      fieldRow(
        "OpenCode connection",
        connected ? "available" : "unavailable",
      ),
      fieldRow("Authorization", "verified"),
      fieldRow("Mode", "read-only"),
    ];
    this.enqueueMessage(
      [
        titleLine(ICON_READY, this.projectLabel),
        fieldTable(rows),
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
        paragraph(`${ICON_SESSIONS} ${this.projectLabel}`),
        paragraph("No active sessions."),
      ];
      const last = this.lastCompletedSessionID
        ? this.sessions.get(this.lastCompletedSessionID)
        : undefined;
      if (last) {
        parts.push(
          `<p>Last completed: ${escapeHtml(sessionLabel(last, { root: this.root, botToken: this.config.botToken }))}</p>`,
        );
      }
      this.enqueueMessage(parts.join("\n"));
      return;
    }

    const listItems = active
      .map((session) => {
        const marker = session.sessionID === this.selectedSessionID ? "*" : "-";
        return `<li>${marker} ${shortID(session.sessionID)} | ${displayState(session)} | ${escapeHtml(sessionTitle(session, { root: this.root, botToken: this.config.botToken }))}</li>`;
      })
      .join("");
    this.enqueueMessage(
      [
        paragraph(`${ICON_SESSIONS} ${this.projectLabel}`),
        `<ul>${listItems}</ul>`,
        "<p>Select one with /use &lt;short-id&gt;.</p>",
      ].join("\n"),
    );
  }

  private async commandUse(argument?: string) {
    if (!argument) {
      this.enqueueMessage(paragraph("Usage: /use &lt;short-id&gt;"));
      return;
    }

    await this.reconcileStatuses();
    const matches = [...this.sessions.values()].filter((session) =>
      matchesSessionID(session.sessionID, argument),
    );

    if (matches.length === 0) {
      this.enqueueMessage(
        paragraph(
          `No observed session matches: ${safeText(argument, 40, { root: this.root, botToken: this.config.botToken })}`,
        ),
      );
      return;
    }
    if (matches.length > 1) {
      const listItems = matches
        .slice(0, 10)
        .map(
          (session) =>
            `<li>${shortID(session.sessionID)} | ${escapeHtml(sessionTitle(session, { root: this.root, botToken: this.config.botToken }))}</li>`,
        )
        .join("");
      this.enqueueMessage(
        [paragraph("Session ID is ambiguous:"), `<ul>${listItems}</ul>`].join(
          "\n",
        ),
      );
      return;
    }

    const session = matches[0]!;
    this.selectedSessionID = session.sessionID;
    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(paragraph(`Selected: ${sessionLabel(session, { root: this.root, botToken: this.config.botToken })}`));
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
              `<li>${shortID(item.sessionID)} | ${displayState(item)} | ${escapeHtml(sessionTitle(item, { root: this.root, botToken: this.config.botToken }))}</li>`,
          )
          .join("");
        this.enqueueMessage(
          [
            paragraph(`${ICON_STATUS} No session selected.`),
            `<ul>${listItems}</ul>`,
            paragraph("Select one with /use &lt;short-id&gt;."),
          ].join("\n"),
        );
        return;
      }

      const last = this.lastCompletedSessionID
        ? this.sessions.get(this.lastCompletedSessionID)
        : undefined;
      this.enqueueMessage(
        last
          ? paragraph(
              `${ICON_STATUS} No active sessions.\nLast completed: ${sessionLabel(last, { root: this.root, botToken: this.config.botToken })}`,
            )
          : paragraph(`${ICON_STATUS} No active sessions.`),
      );
      return;
    }

    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(formatStatus(session, { root: this.root, botToken: this.config.botToken, projectLabel: this.projectLabel, sessions: this.sessions, sessionInfo: this.sessionInfo }));
  }

  private async commandTodo() {
    const session = this.selectedSession();
    if (!session) {
      this.enqueueMessage(
        paragraph(
          "No session selected. Use /sessions and /use &lt;short-id&gt; first.",
        ),
      );
      return;
    }
    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(formatTodos(session, { root: this.root, botToken: this.config.botToken, projectLabel: this.projectLabel, sessions: this.sessions, sessionInfo: this.sessionInfo }));
  }

  private async commandUsage() {
    const session = this.selectedSession();
    if (!session) {
      this.enqueueMessage(
        paragraph(
          "No session selected. Use /sessions and /use &lt;short-id&gt; first.",
        ),
      );
      return;
    }
    await this.reconcileSession(session.sessionID);
    this.enqueueMessage(formatUsage(session, { root: this.root, botToken: this.config.botToken, projectLabel: this.projectLabel, sessions: this.sessions, sessionInfo: this.sessionInfo }));
  }

  private async commandMenu() {
    const registry = await this.registry.read();
    this.enqueueMessageWithKeyboard(
      menuText(),
      buildMenuKeyboard(registry),
    );
  }

  private async handleCallback(callback: TelegramCallbackQuery) {
    if (String(callback.from?.id) !== this.config.chatId) return;
    const { id, data, message } = callback;
    if (!id || !data || !message) return;
    // ---- perm 前置分支（契约 §13.5，早于通用正则 §13.4）----
    if (data.startsWith(PERM_CB_PREFIX)) {
      const permMatch = data.match(/^otg:perm:(.+):(once|always|reject)$/);
      if (!permMatch) {
        await this.answerCallback(id, "Unknown action", false);
        return;
      }
      const entryID = permMatch[1]!;
      const value = permMatch[2] as "once" | "always" | "reject";
      // 还原 requestID：缩短映射只存于 poller 实例内存（§13.4）；进程重启后
      // 旧按钮点击 → 还原为 raw 找不到记录 → 无匹配分支，可接受降级。
      const requestID = this.permShortMap.get(entryID) ?? entryID;
      try {
        const next = await this.registry.mutate((reg) =>
          setSessionReply(reg, requestID, value),
        );
        if (next === undefined) {
          // 无匹配记录 / 抢锁超时：提示失效 + 不编辑消息（§13.5）。
          await this.answerCallback(id, "记录不存在或已失效", true);
          await this.log(
            "warn",
            "Permission callback: no matching session record",
            {
              requestId: safeText(requestID, 100, {
                root: this.root,
                botToken: this.config.botToken,
              }),
            },
          );
          return;
        }
        // 有匹配即继续；不读取 resolved/send 状态（纯写入，§13.5）。
        const notice =
          value === "once"
            ? "已允许一次"
            : value === "always"
              ? "已允许总是"
              : "已拒绝";
        await this.answerCallback(id, notice, false);
        // 编辑原消息移除按钮 + 追加结果行；失败 logWarn 不中断（§13.5）。
        await this.editPermissionResultMessage(
          message.chat.id,
          message.message_id,
          message.text ?? "",
          value,
        );
      } catch (error) {
        await this.answerCallback(id, "操作失败，请重试", true).catch(
          () => undefined,
        );
        await this.log("error", "Callback handling failed", {
          error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
        });
      }
      return;
    }
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
        error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
      });
    }
  }

  private async answerCallback(
    callbackQueryID: string,
    text: string,
    alert: boolean,
  ) {
    await telegramWithRetry("answerCallbackQuery", {
      callback_query_id: callbackQueryID,
      text,
      show_alert: alert,
    }, { config: this.config, signal: this.abortController.signal });
  }

  /**
   * 编辑权限消息为结果态（契约 §13.5 step 6）：保留原文、追加结果行，
   * 不传 reply_markup ⇒ 键盘被移除（防重复点击，决策 #4）。编辑失败
   * logWarn 不抛错（answer 已发出，视为已处理）。结果行冻结：once →
   * ✅ Allowed once；always → ✅ Allowed always；reject → ❌ Rejected。
   */
  private async editPermissionResultMessage(
    chatID: number | string,
    messageID: number,
    originalText: string,
    value: "once" | "always" | "reject",
  ) {
    const resultLine =
      value === "once"
        ? "✅ Allowed once"
        : value === "always"
          ? "✅ Allowed always"
          : "❌ Rejected";
    try {
      await telegramWithRetry(
        "editMessageText",
        {
          chat_id: chatID,
          message_id: messageID,
          text: `${originalText}\n${resultLine}`,
        },
        { config: this.config, signal: this.abortController.signal },
      );
    } catch (error) {
      await this.log(
        "warn",
        "Permission result message edit failed",
        {
          error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
        },
      );
    }
  }

  private async editMenuMessage(
    chatID: number | string,
    messageID: number,
    registry: ProjectRegistry,
  ) {
    await telegramWithRetry("editMessageText", {
      chat_id: chatID,
      message_id: messageID,
      text: menuText(),
      reply_markup: buildMenuKeyboard(registry),
    }, { config: this.config, signal: this.abortController.signal });
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
    await telegramWithRetry("sendRichMessage", {
      chat_id: this.config.chatId,
      rich_message: { html: limitMessage(text) },
    }, { config: this.config, signal: this.abortController.signal });
  }

  private async sendMessageWithKeyboard(
    text: string,
    replyMarkup: TelegramInlineKeyboard,
  ) {
    if (this.abortController.signal.aborted) return;
    await telegramWithRetry("sendRichMessage", {
      chat_id: this.config.chatId,
      rich_message: { html: limitMessage(text) },
      reply_markup: replyMarkup,
    }, { config: this.config, signal: this.abortController.signal });
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

  private session(value: unknown): Session | undefined {
    const info = record(value);
    if (!info || typeof info.id !== "string" || typeof info.title !== "string")
      return undefined;
    return info as Session;
  }

  private parseRuntimeEvent(value: unknown): RuntimeEvent | undefined {
    const event = record(value);
    const type = string(event?.type);
    const properties = record(event?.properties);
    if (!event || !type || !properties) return undefined;
    return { id: string(event.id), type, properties };
  }

  private rememberEvent(eventID?: string) {
    if (!eventID) return true;
    if (this.seenEventIDs.has(eventID)) return false;
    rememberBounded(this.seenEventIDs, eventID);
    return true;
  }

  private isTodo = (value: unknown): value is Todo => {
    const todo = record(value);
    return Boolean(
      todo && typeof todo.id === "string" && typeof todo.content === "string",
    );
  };

  private track(promise: Promise<void>, failureMessage: string) {
    let tracked: Promise<void>;
    tracked = promise
      .catch((error) =>
        this.log("error", failureMessage, {
          error: errorCategory(error, { root: this.root, botToken: this.config.botToken }),
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
