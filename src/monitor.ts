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
  QuestionV2Info,
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
  buildQuestionKeyboard,
  buildQuestionStageText,
  buildSessionPermissionKeyboard,
  OTG_Q_CB_PREFIX,
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
  questionInputCancelledText,
  questionInputPromptText,
  questionLabel,
  record,
  rememberBounded,
  safeProgress,
  safeText,
  safeTextKeepPaths,
  safeToolTarget,
  sessionLabel,
  sessionTitle,
  shortID,
  status as coerceStatus,
  string,
  summarizeError,
  titleLine,
  type FormatContext,
} from "./format";
import { PollerLock } from "./infra/poller-lock";
import {
  appendSessionRecord,
  deleteProjectByPath,
  findEntryByToken,
  findRegistryEntry,
  markSessionSent,
  registerProject,
  rejectQuestion,
  removeExpiredSessionRecords,
  removeSessionRecord,
  removeSessionRecordsForSession,
  setProjectEnabled,
  setQuestionDraft,
  setQuestionInput,
  setQuestionMessageID,
  setSessionReply,
  submitQuestionAnswers,
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
        // Round 6（§16）：会话终结 → 删除该 session 的全部落盘记录
        // （path ②）；mutate undefined（锁超时/无记录）由方法内 logWarn 容忍。
        this.track(
          this.cleanupSessionRecords(id),
          "Session deleted records cleanup failed",
        );
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
        const projection = this.ensureSession(sessionID);
        projection.pendingError = summarizeError(
          properties.error,
          { root: this.root, botToken: this.config.botToken },
        );
        if (projection.pendingError?.cancelled) {
          // ESC abort（MessageAbortedError，契约 §16 path ②）：opencode 服务端
          // 对 abort 的取消 finalizer 只清内存 pending map，不发布
          // permission/question 终结事件——插件只收到 session.error 且
          // cancelled=true。镜像 session.deleted 清理（~603-605）：取消去抖
          // 定时器、清 waitingByRequestID，再删除该 session 全部落盘记录。
          for (const requestID of projection.waitingByRequestID.keys() ?? []) {
            this.cancelWaitingNotify(requestID);
          }
          projection.waitingByRequestID.clear();
          this.track(
            this.cleanupSessionRecords(sessionID),
            "Session cancelled records cleanup failed",
          );
        }
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
            // 记录已落盘（去抖窗口已过）：删除该 request_id 的落盘记录
            // （Round 6 §16 supersede：终态 = 删除，不再是置 resolved=true）。
            this.track(
              this.resolveWaitingRecord(requestID),
              "Session resolved record removal failed",
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
            // 记录已落盘（question 立即写入，无去抖窗口）：删除该记录
            // （Round 6 §16 supersede：终态 = 删除，不再是置 resolved=true）。
            this.track(
              this.resolveWaitingRecord(requestID),
              "Session resolved record removal failed",
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
   * replied/rejected 事件回写（决策 #5，契约 §5.3；Round 6 §16 supersede：
   * 终态 = 删除记录而非置 resolved=true）——按 request_id 全局删除该记录
   * （removeSessionRecord 同时清除跨进程竞态产生的同 request_id 副本）。
   * 调用方已先 cancelWaitingNotify 并确认去抖窗口已过（waitingNotifyTimers
   * 无该 requestID —— 写入已发生或从未发生）。
   * mutate 返回 undefined（抢锁超时或无匹配记录）→ logWarn，静默容忍。
   */
  private async resolveWaitingRecord(requestID: string) {
    const next = await this.registry.mutate((reg) =>
      removeSessionRecord(reg, requestID),
    );
    if (next === undefined) {
      await this.log(
        "warn",
        "Session record removal skipped: registry mutate timeout or no matching record",
        { requestID },
      );
    }
  }

  /**
   * 会话终结清理（契约 §16 path ②，Round 6）：删除该 session_id 的全部
   * 落盘记录（session.error cancelled / session.deleted 后调用）。镜像
   * resolveWaitingRecord 风格：mutate 返回 undefined（抢锁超时或无匹配
   * 记录）→ logWarn 一次，静默容忍，不抛错。
   */
  private async cleanupSessionRecords(sessionID: string) {
    const next = await this.registry.mutate((reg) =>
      removeSessionRecordsForSession(reg, sessionID),
    );
    if (next === undefined) {
      await this.log(
        "warn",
        "Session records cleanup skipped: registry mutate timeout or no matching records",
        { sessionID },
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
      if (record.type === "permission") {
        // permission 分支（契约 §13.6 零改动）：reply == null 覆盖缺失与显式
        // null（未回复）；resolved 双路径跳过（决策 #6：TUI replied 事件可能
        // 已先置位）。
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
        continue;
      }
      // question 分支（契约 §14.4.1）：resolved 双路径跳过；未达终态
      // （q_answers 未写入且 q_reject 未置位）跳过；q_answers != null →
      // applyQuestionReply，q_reject === true → applyQuestionReject。
      if (record.type !== "question") continue;
      if (record.resolved || (record.q_answers == null && record.q_reject !== true)) {
        continue;
      }
      try {
        if (record.q_answers != null) {
          await this.applyQuestionReply(record);
        } else {
          await this.applyQuestionReject(record);
        }
        applied += 1;
      } catch (error) {
        // 单条失败不中断整轮；applyQuestion* 已 logWarn，这里只继续。
        await this.log(
          "warn",
          "question apply failed; will retry on next reply scan",
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
   * 成功（API resolve）→ mutate(removeSessionRecord)（Round 6 §16 supersede：
   * 终态 = 删除记录，不再置 resolved=true）；失败/抛错 → logWarn 不置位
   * （下轮重试）。已 resolved 记录由调用方筛选跳过（兼容历史数据）。
   */
  private async applySessionReply(record: SessionRecord) {
    if (record.reply == null) return;
    try {
      // throwOnError: true —— HTTP 错误（400/404，如 permission 已被 TUI 处理）
      // 会抛错被捕获 → logWarn 不删除，下轮读到记录已消失即跳过。
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: record.session_id, permissionID: record.request_id },
        body: { response: record.reply },
        throwOnError: true,
      });
    } catch (error) {
      await this.log(
        "warn",
        "Permission reply apply failed; record kept, will retry on next scan",
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
      removeSessionRecord(reg, record.request_id),
    );
    if (next === undefined) {
      // 抢锁超时或记录已被删除：记录未删除属安全重试态，静默容忍。
      await this.log(
        "warn",
        "removeSessionRecord skipped (no match or lock timeout); will retry on next scan",
        { requestId: record.request_id },
      );
    }
  }

  /** 实例级缓存：question apply 分层通道中首次成功的通道序号（§14.8.1）。 */
  private questionApplyChannel?: 1 | 2 | 3 | undefined;

  /**
   * 把一条 question 记录的 q_answers 应用到 opencode 会话（契约 §14.4.2）。
   * 透传语义（决策 #8）：answers = record.q_answers 原样（不映射不校验，parse
   * 已保证 Array<Array<string>>）。调用通道（§14.8.1，supersede §14.4.3 兜底
   * 形态）：运行时扁平客户端无任何 question 方法（实机实证），改走分层通道
   * ① 扁平方法（typeof 检查，未来 SDK 若有则直用）→ ② v2 会话级路由
   * （POST /api/session/{sessionID}/question/{requestID}/reply，body 顶层
   * { answers }，经 (client as any)._client.post 走同一 transport 继承
   * baseUrl/auth）→ ③ v2 全局路由（/question/{requestID}/reply，
   * query.directory = root）。任一成功即用并缓存通道；某通道抛错判定
   * 「不存在」（§14.8.2）→ 立即终态置 resolved 不重试；非 404 维持
   * logWarn + rethrow 下轮重试。已 resolved 记录由调用方筛选跳过。
   */
  private async applyQuestionReply(record: SessionRecord) {
    if (record.q_answers == null) return;
    await this.questionApply("reply", record);
  }

  /**
   * 把一条 question 记录的 q_reject 应用到 opencode 会话（契约 §14.4.2）。
   * 与 applyQuestionReply 同构（reject API 无 body，路由 .../reject），分层
   * 通道与 404 终态语义一致（§14.8.1/§14.8.2）。
   */
  private async applyQuestionReject(record: SessionRecord) {
    if (record.q_reject !== true) return;
    await this.questionApply("reject", record);
  }

  /**
   * question reply/reject 分层调用（§14.8.1，两方法共用）：每次按序尝试通道
   * （① 扁平方法 typeof → ② v2 会话级 → ③ v2 全局），任一成功即用并缓存已
   * 成功通道（questionApplyChannel，下次先试缓存仍按序降级）；某通道抛错判定
   * 「不存在」→ 立即终态（删除记录 + log info + 不 rethrow，下轮自然跳过，
   * Round 6 §16 supersede：终态 = removeSessionRecord 而非置 resolved）；
   * 全部通道失败且非「不存在」→ logWarn（token 脱敏）+ rethrow（下轮重试）。
   */
  private async questionApply(kind: "reply" | "reject", record: SessionRecord) {
    const ctx = { root: this.root, botToken: this.config.botToken };
    let lastError: unknown;
    for (const channel of this.questionChannels(kind)) {
      try {
        await this.questionApplyViaChannel(channel, kind, record);
        this.questionApplyChannel = channel;
        await this.markQuestionResolved(record);
        return;
      } catch (error) {
        if (this.isQuestionNotFoundError(error)) {
          // §14.8.2 404 终态：问题/session 已不存在 → 删除记录不再重试
          // （Round 6 §16 supersede：终态 = 删除，不再是置 resolved）。
          await this.log(
            "info",
            "question no longer exists; removing session record",
            {
              requestId: record.request_id,
              sessionId: record.session_id,
            },
          );
          await this.markQuestionResolved(record);
          return;
        }
        lastError = error;
      }
    }
    const failedVerb = kind === "reply" ? "reply" : "reject";
    await this.log(
      "warn",
      `Question ${failedVerb} apply failed; record kept, will retry on next scan`,
      {
        requestId: record.request_id,
        sessionId: record.session_id,
        error: errorCategory(lastError, ctx),
      },
    );
    throw lastError;
  }

  /**
   * 分层通道候选（§14.8.1）：① 仅当对应扁平方法存在才纳入；缓存通道优先，
   * 其余仍按序降级。
   */
  private questionChannels(kind: "reply" | "reject"): Array<1 | 2 | 3> {
    const client = this.client as {
      postApiSessionSessionIDQuestionRequestIDReply?: unknown;
      postApiSessionSessionIDQuestionRequestIDReject?: unknown;
    };
    const flatMethod =
      kind === "reply"
        ? client?.postApiSessionSessionIDQuestionRequestIDReply
        : client?.postApiSessionSessionIDQuestionRequestIDReject;
    const base: Array<1 | 2 | 3> =
      typeof flatMethod === "function" ? [1, 2, 3] : [2, 3];
    if (this.questionApplyChannel === undefined) return base;
    return [
      this.questionApplyChannel,
      ...base.filter((ch) => ch !== this.questionApplyChannel),
    ];
  }

  /**
   * 单通道调用（§14.8.1）：②③ 走 (client as any)._client.post（v2 gen 内部
   * 即此形态，同一 transport，自动继承 baseUrl/auth 含代理与根目录配置）。
   * body 为顶层 { answers }（实证，非 §14.4.3 的嵌套形态）；reject 无 body。
   */
  private async questionApplyViaChannel(
    channel: 1 | 2 | 3,
    kind: "reply" | "reject",
    record: SessionRecord,
  ): Promise<void> {
    const client = this.client as any;
    const suffix = kind === "reply" ? "reply" : "reject";
    const body = kind === "reply" ? { answers: record.q_answers } : undefined;
    if (channel === 1) {
      const methodName =
        kind === "reply"
          ? "postApiSessionSessionIDQuestionRequestIDReply"
          : "postApiSessionSessionIDQuestionRequestIDReject";
      if (typeof client[methodName] !== "function") {
        throw new Error(`question flat method ${methodName} not available`);
      }
      const options: Record<string, unknown> = {
        path: { sessionID: record.session_id, requestID: record.request_id },
        throwOnError: true,
      };
      if (body !== undefined) options.body = body;
      await client[methodName](options);
      return;
    }
    if (channel === 2) {
      const options: Record<string, unknown> = {
        url: `/api/session/{sessionID}/question/{requestID}/${suffix}`,
        path: { sessionID: record.session_id, requestID: record.request_id },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      };
      if (body !== undefined) options.body = body;
      await client._client.post(options);
      return;
    }
    const options: Record<string, unknown> = {
      url: `/question/{requestID}/${suffix}`,
      path: { requestID: record.request_id },
      query: { directory: this.root },
      headers: { "Content-Type": "application/json" },
      throwOnError: true,
    };
    if (body !== undefined) options.body = body;
    await client._client.post(options);
  }

  /**
   * 判定 question apply 错误为「对象不存在」（§14.8.2）：error 的
   * status/statusCode === 404（SDK APIError 形态），或 errorCategory 字符串
   * 含 404/QuestionNotFound/SessionNotFound。
   */
  private isQuestionNotFoundError(error: unknown): boolean {
    const status = (error as { status?: unknown; statusCode?: unknown })
      ?.status;
    const statusCode = (error as { status?: unknown; statusCode?: unknown })
      ?.statusCode;
    if (status === 404 || statusCode === 404) return true;
    const category = errorCategory(error, {
      root: this.root,
      botToken: this.config.botToken,
    });
    return (
      category.includes("404") ||
      category.includes("QuestionNotFound") ||
      category.includes("SessionNotFound")
    );
  }

  /**
   * 成功路径与 404 终态共用：removeSessionRecord（Round 6 §16 supersede：
   * 终态 = 删除记录，不再置 resolved=true）。mutate 返回 undefined
   * （抢锁超时/记录消失）→ logWarn（记录未删除属安全重试态）。
   */
  private async markQuestionResolved(record: SessionRecord) {
    const next = await this.registry.mutate((reg) =>
      removeSessionRecord(reg, record.request_id),
    );
    if (next === undefined) {
      await this.log(
        "warn",
        "removeSessionRecord skipped (no match or lock timeout); will retry on next scan",
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
    // TTL 扫除（契约 §16 path ③，Round 6）：先于 read 清掉过期记录，防止
    // 强关孤儿/历史遗留记录被再次扫描。仅在本方法内运行（= poller.lock
    // 持有者每秒一次）；无过期时纯函数返回原 registry 引用，mutate 短路
    // 零写盘。mutate 返回 undefined（抢锁超时）→ logWarn 一次，容忍不抛错。
    const swept = await this.registry.mutate((reg) =>
      removeExpiredSessionRecords(reg, Date.now()),
    );
    if (swept === undefined) {
      await this.log(
        "warn",
        "Session TTL sweep skipped: registry mutate timeout",
      );
    }
    const registry = await this.registry.read();
    let handled = 0;
    for (const entry of registry.projects) {
      const sessions = entry.sessions;
      if (!sessions) continue;
      const projectLabel = basename(entry.path) || this.projectLabel;
      for (const record of sessions) {
        // 契约 §13.3 + §14.2.2（决策 #6 防御）：reply != null 的记录永不发送
        // ——已写 reply 走消费端 apply 路径；question 已提交（q_answers）/已放弃
        // （q_reject）的未发送记录永不发送初始消息（走消费端 apply，§14.4）。
        // 对 permission 记录 q_* 恒空（无键 → == null / !== true），语义零变化。
        if (
          record.send ||
          record.resolved ||
          record.reply != null ||
          record.q_answers != null ||
          record.q_reject === true
        )
          continue;
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
            // question 记录改走向导发送（契约 §14.2.2）：解析 message JSON 的
            // questions → Q1 阶段结构化渲染 + 选项键盘；解析失败 / 非对象 /
            // questions 非数组 / 空数组 / 首元素缺 string 型 question → 退化
            // 原文节选无键盘发送（防御，question 记录永远可达、不中断）。
            await this.sendQuestionRecord(record, projectLabel, text);
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
   * question 记录向导发送（契约 sessions-relay.md §14.2.2，Round 4）：解析
   * record.message JSON 的 questions → Q1 阶段（stage 0）结构化渲染 +
   * 选项键盘（buildQuestionStageText/buildQuestionKeyboard）→
   * sendMessageWithKeyboard；返回 message_id 非 undefined → 回写 q_msg_id
   * （mutate setQuestionMessageID，undefined 静默容忍下轮不补——编辑退化为
   * callback.message.message_id 兜底，§14.3.1）。宽松防御：解析抛错 / parsed
   * 非对象 / questions 非数组 / 空数组 / 首元素缺 string 型 question，或
   * questionEntryID 超限返回 undefined → 退化为原文节选无键盘发送（fallbackText，
   * 同 formatSessionRecordMessage 的 question 路径），question 记录永远可达、
   * 不中断。抛错向上传播——scanSessionQueue 既有 try/catch 处理（不置位下轮重试）。
   */
  private async sendQuestionRecord(
    record: SessionRecord,
    projectLabel: string,
    fallbackText: string,
  ): Promise<void> {
    const ctx: FormatContext = {
      root: this.root,
      botToken: this.config.botToken,
      projectLabel,
      sessions: this.sessions,
      sessionInfo: this.sessionInfo,
    };
    let questions: Array<QuestionV2Info> | undefined;
    try {
      const parsed = JSON.parse(record.message) as unknown;
      const parsedQuestions =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).questions
          : undefined;
      if (
        Array.isArray(parsedQuestions) &&
        parsedQuestions.length > 0 &&
        typeof (parsedQuestions[0] as { question?: unknown })?.question ===
          "string"
      ) {
        questions = parsedQuestions as Array<QuestionV2Info>;
      }
    } catch {
      questions = undefined;
    }
    if (!questions) {
      await this.sendMessage(fallbackText);
      return;
    }
    const draft0 = questions.map(() => [] as string[]);
    const sessionLabel = safeText(
      record.session_name || shortID(record.session_id),
      100,
      ctx,
    );
    const text = buildQuestionStageText(
      projectLabel,
      "question",
      sessionLabel,
      questions,
      0,
      draft0,
      false,
      ctx,
    );
    const entryID = this.questionEntryID(record.request_id);
    if (entryID === undefined) {
      // 多字节超限兜底（契约 §14.2.3）：退化为无键盘普通消息。
      await this.sendMessage(fallbackText);
      return;
    }
    const keyboard = buildQuestionKeyboard(entryID, questions, 0, draft0);
    const messageID = await this.sendMessageWithKeyboard(text, keyboard);
    if (messageID === undefined) {
      await this.log(
        "warn",
        "Question wizard send returned no message_id; edits will fall back to callback message id",
        { requestId: record.request_id },
      );
      return;
    }
    const next = await this.registry.mutate((reg) =>
      setQuestionMessageID(reg, record.request_id, messageID),
    );
    if (next === undefined) {
      // 抢锁超时或记录已被删除：q_msg_id 未回写属安全重试态，静默容忍。
      await this.log(
        "warn",
        "setQuestionMessageID skipped (no match or lock timeout)",
        { requestId: record.request_id },
      );
    }
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
   * question 向导的短 ID → 完整 requestID 内存映射（契约 sessions-relay.md
   * §14.2.3）：与 permShortMap（§13.4）独立，不得混用。只存 poller 实例内存、
   * 不持久化；进程重启后旧按钮点击 → 还原为 raw 找不到记录 → §14.3.1 失效
   * 分支，可接受降级。字段放 1.2 区间（契约 §14.6），不占用 140-146 字段区。
   */
  private readonly qShortMap = new Map<string, string>();

  /**
   * question 向导进入键盘的 entryID 换算（契约 sessions-relay.md §14.2.3）：
   * callback_data `otg:q:<entryID>:<o<idx>|prev|next|cancel|custom|submit>`
   * 上限 64 字节（UTF-8），`:submit` 为最长后缀（7 字节）。全量 ≤ 64 → 原样
   * 返回；超限 → 截 44 字符 + qShortMap 登记（44 + 6 + 7 = 57 ≤ 64，ASCII
   * 假设）；多字节字符致 44 字符仍超限 → logError + undefined（无键盘退化）。
   * 禁止静默截断 callback_data。与 permissionEntryID 同构。
   */
  private questionEntryID(requestID: string): string | undefined {
    const ctx = { root: this.root, botToken: this.config.botToken };
    const full = OTG_Q_CB_PREFIX + requestID + ":submit";
    if (Buffer.byteLength(full, "utf8") <= 64) return requestID;
    const shortID = requestID.slice(0, 44);
    const shortFull = OTG_Q_CB_PREFIX + shortID + ":submit";
    if (Buffer.byteLength(shortFull, "utf8") > 64) {
      void this.log(
        "error",
        "Question callback_data exceeds 64 bytes; sending without buttons",
        { requestId: safeText(requestID, 100, ctx) },
      );
      return undefined;
    }
    const previous = this.qShortMap.get(shortID);
    if (previous !== undefined && previous !== requestID) {
      void this.log(
        "warn",
        "Question short ID collision; overwriting qShortMap",
        { requestId: safeText(requestID, 100, ctx) },
      );
    }
    this.qShortMap.set(shortID, requestID);
    return shortID;
  }

  /**
   * 把一条待发送 SessionRecord 组装为 TG 通知文本（复用等待通知样式，
   * 契约 sessions-relay.md §13.12）：titleLine(iconForWaitingType) +
   * **单张** fieldTable(Type / Session / Permission / Pattern N 同表) +
   * （permission 记录：结构化字段行 | 原文节选）。
   * 结构化字段仅对 type === "permission" 生效：Permission/Pattern 行直接并入
   * Type/Session 所在的同一张表；Pattern 逐项单独一行（单 `Pattern`，多
   * `Pattern 1/2/…`），值经 safeTextKeepPaths 保留真实路径（密钥/token 仍脱敏）；
   * Title 行不再渲染。JSON 解析失败 / 非对象 / Permission 与 Pattern 行均无输出
   * → 在表格之后追加原文节选（300 字符，路径脱敏照旧）；question 记录恒走原文节选。
   * HTML 转义由 fieldRow/paragraph 内部的 escapeHtml 完成。
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

    let excerpt = "";
    if (record.type === "permission") {
      // 结构化渲染（契约 §13.12，supersede §13.11）：JSON.parse(record.message)，
      // 解析失败 → 原文节选。解析结果为普通对象时，按字段来源表宽松渲染
      // Permission/Pattern 行并并入同一张 fieldTable（字段缺失/类型不符即跳过，
      // 不抛错）；Permission 与 Pattern 行均未输出 → 同样退回原文节选。
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(record.message);
      } catch {
        parsed = null;
      }
      const obj =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      let structuredRows = 0;
      if (obj) {
        const permission = obj.permission ?? obj.action ?? obj.type;
        if (typeof permission === "string") {
          rows.push(
            fieldRow(
              "Permission",
              safeTextKeepPaths(permission, 300, ctx),
            ),
          );
          structuredRows += 1;
        }
        const pattern = obj.patterns ?? obj.resources ?? obj.pattern;
        if (pattern !== undefined) {
          const items = (
            Array.isArray(pattern) ? pattern : [pattern]
          ) as unknown[];
          const texts = items.filter(
            (item): item is string => typeof item === "string",
          );
          texts.forEach((item, index) => {
            rows.push(
              fieldRow(
                texts.length === 1 ? "Pattern" : `Pattern ${index + 1}`,
                safeTextKeepPaths(item, 300, ctx),
              ),
            );
            structuredRows += 1;
          });
        }
      }
      if (structuredRows === 0) {
        excerpt = paragraph(safeText(record.message, 300, ctx));
      }
    } else {
      excerpt = paragraph(safeText(record.message, 300, ctx));
    }

    const parts = [
      titleLine(iconForWaitingType(record.type), projectLabel),
      fieldTable(rows),
      excerpt,
    ].filter((part) => part !== "");
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
    if (!match) {
      // 命令正则不匹配 = 纯文本（契约 §14.3.2）：自定义输入捕获；无输入态
      // 记录时静默忽略。chatId 匹配校验已在上方完成。
      await this.handleQuestionTextInput(message.text);
      return;
    }
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
      case "cancel":
        await this.cancelPendingQuestionInputs();
        return;
      default:
        this.enqueueMessage(
          `Unknown command: /${escapeHtml(command)}\n\n${helpText()}`,
        );
    }
  }

  /**
   * 纯文本自定义输入捕获（契约 §14.3.2，命令正则不命中分支）：全局找第一条
   * `type==="question" && resolved===false && q_answers==null && q_input!=null`
   * 的记录（跨全部条目，顺序 = projects 数组序 + sessions 数组序）→ 覆盖式
   * 写入 draft[q_input] → 串行落盘（先清输入态、再推进：多问题 stage+1 /
   * 单问题直接提交）→ 编辑向导消息（**仅** record.q_msg_id；缺失 → 契约
   * §14.8.6（Round 2 修订）发一条新的当前阶段向导消息兜底：多问题含键盘并
   * 回写新 q_msg_id（后续编辑/回调指向新消息）、单问题 ✅ Submitted 终态文本
   * 无键盘；旧消息不动，答案已落盘不受影响）→ enqueueMessage 确认文案
   * `已记录第 {n} 题答案`（n = q_input + 1）。找不到输入态记录 → 静默
   * return（非命令文本保持忽略）。
   */
  private async handleQuestionTextInput(text: string): Promise<void> {
    const reg = await this.registry.read();
    let found: { record: SessionRecord; projectLabel: string } | undefined;
    outer: for (const entry of reg.projects) {
      const entrySessions = entry.sessions ?? [];
      for (const record of entrySessions) {
        if (
          record.type !== "question" ||
          record.resolved === true ||
          record.q_answers != null ||
          record.q_input == null
        ) {
          continue;
        }
        found = {
          record,
          projectLabel: basename(entry.path) || this.projectLabel,
        };
        break outer;
      }
    }
    if (!found) return;
    const { record, projectLabel } = found;
    const requestID = record.request_id;
    const ctx: FormatContext = {
      root: this.root,
      botToken: this.config.botToken,
      projectLabel,
      sessions: this.sessions,
      sessionInfo: this.sessionInfo,
    };
    const questions = this.parseQuestionPayload(record.message);
    if (!questions) {
      await this.log("warn", "Question text input: cannot parse questions", {
        requestId: safeText(requestID, 100, ctx),
      });
      return;
    }
    const index = record.q_input;
    if (index === null || index < 0 || index >= questions.length) {
      // 防御：parse 只保证 q_input 为 number，范围在此校验。
      await this.log("warn", "Question text input: q_input out of range", {
        requestId: safeText(requestID, 100, ctx),
      });
      return;
    }
    const { draft } = this.rebuildQuestionState(record, questions);
    draft[index] = [text.trim()]; // 覆盖式：每次回复覆盖该题草稿（TUI 同款）。
    const answerNumber = index + 1;
    // 落盘顺序冻结（契约 §14.3.2）：先清输入态 → 再推进/提交。
    const cleared = await this.registry.mutate((rec) =>
      setQuestionInput(rec, requestID, null),
    );
    if (cleared === undefined) {
      await this.log(
        "warn",
        "Question text input: clear input skipped (no match)",
        { requestId: safeText(requestID, 100, ctx) },
      );
      return;
    }
    if (questions.length === 1) {
      // 单问题请求：直接提交。
      const next = await this.registry.mutate((rec) =>
        submitQuestionAnswers(rec, requestID, draft),
      );
      if (next === undefined) {
        await this.log(
          "warn",
          "Question text input: submit skipped (no match)",
          { requestId: safeText(requestID, 100, ctx) },
        );
        return;
      }
      const resultText =
        this.questionStageText(
          record,
          projectLabel,
          questions,
          index,
          draft,
          false,
        ) + "\n✅ Submitted";
      if (record.q_msg_id !== undefined) {
        await this.editQuestionWizardMessage(
          this.config.chatId,
          record.q_msg_id,
          resultText,
        );
      } else {
        // 契约 §14.8.6（Round 2 修订）：q_msg_id 缺失 → 发一条新的终态向导
        // 消息（✅ Submitted，无键盘），旧消息不动（按钮仍可用、状态在盘上）；
        // 发送成功后回写新 message_id。发送失败不中断——答案已落盘，消费端
        // 照常 apply，下轮无需重试。
        try {
          // 终态无键盘：reply_markup 传 undefined，经 JSON.stringify 自然忽略
          // （telegram/client.ts），等效无键盘文本发送，同时保留 message_id
          // 返回供回写（§14.8.6「统一走 sendMessageWithKeyboard 亦可行」）。
          const newMsgID = await this.sendMessageWithKeyboard(
            resultText,
            undefined as unknown as TelegramInlineKeyboard,
          );
          if (newMsgID !== undefined) {
            const wrote = await this.registry.mutate((rec) =>
              setQuestionMessageID(rec, requestID, newMsgID),
            );
            if (wrote === undefined) {
              await this.log(
                "warn",
                "Question text input: new message id writeback skipped (no match or lock timeout)",
                { requestId: safeText(requestID, 100, ctx) },
              );
            }
          } else {
            await this.log(
              "warn",
              "Question text input: new message has no message_id",
              { requestId: safeText(requestID, 100, ctx) },
            );
          }
        } catch (error) {
          await this.log("warn", "Question text input: fallback send failed", {
            error: errorCategory(error, {
              root: this.root,
              botToken: this.config.botToken,
            }),
          });
        }
      }
    } else {
      // 多问题：推进（=length 自然进总结）。
      const newStage = Math.min(index + 1, questions.length);
      const next = await this.registry.mutate((rec) =>
        setQuestionDraft(rec, requestID, draft, newStage),
      );
      if (next === undefined) {
        await this.log(
          "warn",
          "Question text input: advance skipped (no match)",
          { requestId: safeText(requestID, 100, ctx) },
        );
        return;
      }
      if (record.q_msg_id !== undefined) {
        await this.renderQuestionStage(
          record,
          projectLabel,
          requestID,
          questions,
          newStage,
          draft,
          false,
          this.config.chatId,
          record.q_msg_id,
        );
      } else {
        // 契约 §14.8.6（Round 2 修订）：q_msg_id 缺失 → 发一条新的当前阶段
        // 向导消息（含键盘），发送成功后回写新 message_id（后续编辑/回调指向
        // 新消息）；旧消息不动（按钮仍可用、状态在盘上）。发送失败不中断——
        // 答案已落盘，消费端照常 apply，下轮无需重试。
        const fallbackText = this.questionStageText(
          record,
          projectLabel,
          questions,
          newStage,
          draft,
          false,
        );
        try {
          let newMsgID: number | undefined;
          const entryID = this.questionEntryID(requestID);
          if (entryID === undefined) {
            // 超限兜底：退化为无键盘文本发送（§14.2.2 步骤 3 同款），无 id 可回写。
            await this.sendMessage(fallbackText);
          } else {
            const keyboard = buildQuestionKeyboard(
              entryID,
              questions,
              newStage,
              draft,
            );
            newMsgID = await this.sendMessageWithKeyboard(
              fallbackText,
              keyboard,
            );
            if (newMsgID !== undefined) {
              const wrote = await this.registry.mutate((rec) =>
                setQuestionMessageID(rec, requestID, newMsgID),
              );
              if (wrote === undefined) {
                await this.log(
                  "warn",
                  "Question text input: new message id writeback skipped (no match or lock timeout)",
                  { requestId: safeText(requestID, 100, ctx) },
                );
              }
            } else {
              await this.log(
                "warn",
                "Question text input: new message has no message_id",
                { requestId: safeText(requestID, 100, ctx) },
              );
            }
          }
        } catch (error) {
          await this.log("warn", "Question text input: fallback send failed", {
            error: errorCategory(error, {
              root: this.root,
              botToken: this.config.botToken,
            }),
          });
        }
      }
    }
    this.enqueueMessage(paragraph(`已记录第 ${answerNumber} 题答案`));
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
        // 编辑原消息移除按钮 + 追加结果行；失败 logWarn 不中断（§13.5、§15.4）。
        let originalText = message.text ?? "";
        let targetRecord: SessionRecord | undefined;
        let projectLabel = this.projectLabel;
        for (const entry of next.projects) {
          const matched = entry.sessions?.find((s) => s.request_id === requestID);
          if (matched) {
            targetRecord = matched;
            projectLabel = basename(entry.path) || this.projectLabel;
            break;
          }
        }
        if (targetRecord) {
          originalText = this.formatSessionRecordMessage(targetRecord, projectLabel);
        }
        await this.editPermissionResultMessage(
          message.chat.id,
          message.message_id,
          originalText,
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
    // ---- q 前置分支（契约 §14.3.1，perm 分支后、通用正则前）----
    if (data.startsWith(OTG_Q_CB_PREFIX)) {
      const qMatch = data.match(
        /^otg:q:(.+):(o\d+|prev|next|cancel|custom|submit)$/,
      );
      if (!qMatch) {
        await this.answerCallback(id, "Unknown action", false);
        return;
      }
      const entryID = qMatch[1]!;
      const qAction = qMatch[2]!;
      // 还原 requestID：qShortMap 只存 poller 实例内存（§14.2.3）；进程重启后
      // 旧按钮点击 → 还原为 raw 找不到记录 → handleQuestionCallback 失效分支，
      // 可接受降级。
      const requestID = this.qShortMap.get(entryID) ?? entryID;
      try {
        await this.handleQuestionCallback(callback, id, requestID, qAction);
      } catch (error) {
        await this.answerCallback(id, "操作失败，请重试", true).catch(
          () => undefined,
        );
        await this.log("error", "Question callback handling failed", {
          error: errorCategory(error, {
            root: this.root,
            botToken: this.config.botToken,
          }),
        });
        return;
      }
      return; // q 分支自行结束，不得落入末尾 editMenuMessage 菜单刷新（§14.3.1）。
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

  /**
   * question 向导回调状态机（契约 sessions-relay.md §14.3.1，Round 4）：
   * 无内存状态——每次回调从盘上 registry 重建 q_draft/q_stage（进程重启后
   * 点旧按钮天然恢复）。流程：全局线性扫描找记录（projects 数组序 + sessions
   * 数组序，与纯函数全局匹配同序）→ 失效/解析防御 → 重建状态（stage 钳制
   * 0..questions.length）→ 按动作分派。每步先 mutate 落盘；返回 undefined
   * → 失效 answer + 不编辑；成功 → answer 文案（§14.3.3）+ 编辑向导消息
   * （q_msg_id ?? 回调消息自身 id；编辑失败 logWarn 不中断）。终态编辑
   * 不传键盘 ⇒ 键盘移除。
   */
  private async handleQuestionCallback(
    callback: TelegramCallbackQuery,
    callbackID: string,
    requestID: string,
    action: string,
  ): Promise<void> {
    const message = callback.message!; // handleCallback 已保证 message 存在
    const ctx: FormatContext = {
      root: this.root,
      botToken: this.config.botToken,
      projectLabel: this.projectLabel,
      sessions: this.sessions,
      sessionInfo: this.sessionInfo,
    };
    const reg = await this.registry.read();
    let found: { record: SessionRecord; projectLabel: string } | undefined;
    outer: for (const entry of reg.projects) {
      const entrySessions = entry.sessions ?? [];
      for (const record of entrySessions) {
        if (record.request_id !== requestID) continue;
        found = {
          record,
          projectLabel: basename(entry.path) || this.projectLabel,
        };
        break outer;
      }
    }
    if (!found) {
      await this.answerCallback(callbackID, "记录不存在或已失效", true);
      await this.log("warn", "Question callback: no matching session record", {
        requestId: safeText(requestID, 100, ctx),
      });
      return;
    }
    const { record, projectLabel } = found;
    // 失效判定：已 resolved / 已提交（q_answers）/ 已放弃（q_reject）→ 不编辑。
    if (
      record.resolved === true ||
      record.q_answers != null ||
      record.q_reject === true
    ) {
      await this.answerCallback(callbackID, "记录不存在或已失效", true);
      await this.log("warn", "Question callback: record already terminal", {
        requestId: safeText(requestID, 100, ctx),
      });
      return;
    }
    const questions = this.parseQuestionPayload(record.message);
    if (!questions) {
      await this.answerCallback(callbackID, "记录不存在或已失效", true);
      await this.log("warn", "Question callback: cannot parse questions", {
        requestId: safeText(requestID, 100, ctx),
      });
      return;
    }
    // 状态重建：draft 归一化到 questions 长度（防长度不符的脏数据）；stage
    // 钳制 0..questions.length（=length 为总结阶段）。
    const { draft, stage } = this.rebuildQuestionState(record, questions);
    const chatID = message.chat.id;
    const messageID = record.q_msg_id ?? message.message_id;

    // o<idx>：选项点击（单选直接覆盖；多选题 toggle）。
    const optionMatch = action.match(/^o(\d+)$/);
    if (optionMatch) {
      const index = Number(optionMatch[1]);
      const current = questions[stage];
      const options =
        current && Array.isArray(current.options) ? current.options : [];
      const option = options[index];
      if (!option || typeof option.label !== "string") {
        await this.answerCallback(callbackID, "选项无效", false);
        return;
      }
      const label = option.label;
      const nextDraft = draft.slice();
      if (current.multiple === true) {
        // 多选：toggle label（保持数组顺序）→ 同 stage 落盘 → 编辑（✓ 刷新）。
        const selected = draft[stage] ?? [];
        nextDraft[stage] = selected.includes(label)
          ? selected.filter((item) => item !== label)
          : [...selected, label];
        const next = await this.registry.mutate((rec) =>
          setQuestionDraft(rec, requestID, nextDraft, stage),
        );
        if (next === undefined) {
          await this.answerCallback(callbackID, "记录不存在或已失效", true);
          return;
        }
        await this.answerCallback(
          callbackID,
          `已选 ${nextDraft[stage]!.length} 项`,
          false,
        );
        await this.renderQuestionStage(
          record,
          projectLabel,
          requestID,
          questions,
          stage,
          nextDraft,
          false,
          chatID,
          messageID,
        );
        return;
      }
      // 单选：覆盖式写入。
      nextDraft[stage] = [label];
      if (questions.length === 1) {
        // 单问题请求：点选项直接提交（决策 #6）。
        const next = await this.registry.mutate((rec) =>
          submitQuestionAnswers(rec, requestID, nextDraft),
        );
        if (next === undefined) {
          await this.answerCallback(callbackID, "记录不存在或已失效", true);
          return;
        }
        await this.answerCallback(callbackID, "已提交", false);
        const baseText = this.questionStageText(
          record,
          projectLabel,
          questions,
          stage,
          nextDraft,
          false,
        );
        await this.editQuestionWizardMessage(
          chatID,
          messageID,
          baseText + "\x0a✅ Submitted",
        );
        return;
      }
      // 多问题单选：自动跳下一题（=length 自然进总结）。
      const newStage = Math.min(stage + 1, questions.length);
      const next = await this.registry.mutate((rec) =>
        setQuestionDraft(rec, requestID, nextDraft, newStage),
      );
      if (next === undefined) {
        await this.answerCallback(callbackID, "记录不存在或已失效", true);
        return;
      }
      await this.answerCallback(callbackID, `已选「${label}」`, false);
      await this.renderQuestionStage(
        record,
        projectLabel,
        requestID,
        questions,
        newStage,
        nextDraft,
        false,
        chatID,
        messageID,
      );
      return;
    }

    // prev / next：阶段钳制跳转（next 上限=总结阶段；prev 下限 0；答案保留）。
    if (action === "prev" || action === "next") {
      const delta = action === "next" ? 1 : -1;
      const newStage = Math.min(Math.max(stage + delta, 0), questions.length);
      const next = await this.registry.mutate((rec) =>
        setQuestionDraft(rec, requestID, draft, newStage),
      );
      if (next === undefined) {
        await this.answerCallback(callbackID, "记录不存在或已失效", true);
        return;
      }
      await this.answerCallback(callbackID, "已跳转", false);
      await this.renderQuestionStage(
        record,
        projectLabel,
        requestID,
        questions,
        newStage,
        draft,
        false,
        chatID,
        messageID,
      );
      return;
    }

    // custom：进入输入模式（键盘保留 + 追加输入提示行）。
    // 契约 §14.8.4（Round 2 修订）：custom 恒可用——真实 question payload 从不带
    // `custom: true`，移除「该题不支持自定义输入」防御；current 判空保留为失效
    // 兜底（state 重建已钳制，理论不可达）。
    if (action === "custom") {
      const current = questions[stage];
      if (!current) {
        await this.answerCallback(callbackID, "记录不存在或已失效", true);
        return;
      }
      await this.cancelPendingQuestionInputs(requestID);
      const next = await this.registry.mutate((rec) =>
        setQuestionInput(rec, requestID, stage),
      );
      if (next === undefined) {
        await this.answerCallback(callbackID, "记录不存在或已失效", true);
        return;
      }
      await this.answerCallback(
        callbackID,
        safeTextKeepPaths(
          questionInputPromptText(projectLabel, current, ctx),
          200,
          ctx,
        ),
        false,
      );
      await this.renderQuestionStage(
        record,
        projectLabel,
        requestID,
        questions,
        stage,
        draft,
        true,
        chatID,
        messageID,
      );
      // Round 2（实机反馈）：弹窗 toast 一闪即逝，追加一条独立持久提示消息作为
      // 纯文本输入的锚点；与取消消息同通道（enqueueMessage 入队 sendTail 串行，
      // 多记录取消场景「A 取消消息 → 本提示消息」顺序天然正确）。
      this.enqueueMessage(
        paragraph(questionInputPromptText(projectLabel, current, ctx)),
      );
      return;
    }

    // submit：任意阶段可用（Phase 1.5 修订——单问题多选恒 stage=0 也需提交路径，
    // 键盘层多问题仍只在总结阶段显示 Submit，回调层不再依赖 stage 守卫）；
    // 未全答 → 提示题号、不提交不编辑。
    if (action === "submit") {
      const emptyIndex = draft.findIndex((answers) => answers.length === 0);
      if (emptyIndex !== -1) {
        await this.answerCallback(
          callbackID,
          `第 ${emptyIndex + 1} 题未作答，请先作答`,
          false,
        );
        return;
      }
      const next = await this.registry.mutate((rec) =>
        submitQuestionAnswers(rec, requestID, draft),
      );
      if (next === undefined) {
        await this.answerCallback(callbackID, "记录不存在或已失效", true);
        return;
      }
      await this.answerCallback(callbackID, "已提交", false);
      const baseText = this.questionStageText(
        record,
        projectLabel,
        questions,
        stage,
        draft,
        false,
      );
      await this.editQuestionWizardMessage(
        chatID,
        messageID,
        baseText + "\x0a✅ Submitted",
      );
      return;
    }

    // cancel：任意阶段放弃整个向导。
    if (action === "cancel") {
      const next = await this.registry.mutate((rec) =>
        rejectQuestion(rec, requestID),
      );
      if (next === undefined) {
        await this.answerCallback(callbackID, "记录不存在或已失效", true);
        return;
      }
      await this.answerCallback(callbackID, "已取消", false);
      const baseText = this.questionStageText(
        record,
        projectLabel,
        questions,
        stage,
        draft,
        false,
      );
      await this.editQuestionWizardMessage(
        chatID,
        messageID,
        baseText + "\x0a❌ Cancelled",
      );
      return;
    }

    // 正则已收窄到 o\d+|prev|next|cancel|custom|submit，理论不可达。
    await this.answerCallback(callbackID, "Unknown action", false);
  }

  /**
   * 单活取消（契约 §14.9.2）：扫描全部待输入 question 记录，失效记录静默清，
   * 活记录清 q_input + 发取消消息 + 重渲染回正常阶段视图。
   */
  private async cancelPendingQuestionInputs(
    excludeRequestID?: string,
  ): Promise<number> {
    const reg = await this.registry.read();
    const matches: Array<{ record: SessionRecord; projectLabel: string }> = [];
    for (const entry of reg.projects) {
      const entrySessions = entry.sessions ?? [];
      for (const record of entrySessions) {
        if (
          record.type === "question" &&
          record.q_input != null &&
          record.request_id !== excludeRequestID
        ) {
          matches.push({
            record,
            projectLabel: basename(entry.path) || this.projectLabel,
          });
        }
      }
    }

    let count = 0;
    for (const { record, projectLabel } of matches) {
      const isInvalid =
        record.resolved === true ||
        record.q_answers != null ||
        record.q_reject === true;

      if (isInvalid) {
        await this.registry.mutate((rec) =>
          setQuestionInput(rec, record.request_id, null),
        );
        continue;
      }

      const ctx: FormatContext = {
        root: this.root,
        botToken: this.config.botToken,
        projectLabel,
        sessions: this.sessions,
        sessionInfo: this.sessionInfo,
      };

      const cleared = await this.registry.mutate((rec) =>
        setQuestionInput(rec, record.request_id, null),
      );
      if (cleared === undefined) {
        await this.log(
          "warn",
          "Cancel question input: clear input skipped (no match)",
          {
            requestId: safeText(record.request_id, 100, ctx),
          },
        );
        continue;
      }

      const questions = this.parseQuestionPayload(record.message);
      const targetQuestion =
        questions && typeof record.q_input === "number"
          ? questions[record.q_input]
          : undefined;

      this.enqueueMessage(
        paragraph(
          questionInputCancelledText(projectLabel, targetQuestion, ctx),
        ),
      );

      if (questions && typeof record.q_msg_id === "number") {
        const { draft, stage } = this.rebuildQuestionState(record, questions);
        await this.renderQuestionStage(
          record,
          projectLabel,
          record.request_id,
          questions,
          stage,
          draft,
          false,
          this.config.chatId,
          record.q_msg_id,
        );
      }

      count += 1;
    }

    return count;
  }

  /**
   * 状态重建 helper（契约 §14.9.4）：草稿归一化 + stage 钳制 0..questions.length。
   */
  private rebuildQuestionState(
    record: SessionRecord,
    questions: Array<QuestionV2Info>,
  ): { draft: Array<Array<string>>; stage: number } {
    const rawDraft = record.q_draft ?? [];
    const draft = questions.map((_, index) =>
      Array.isArray(rawDraft[index]) ? [...rawDraft[index]!] : [],
    );
    const stage =
      typeof record.q_stage === "number"
        ? Math.min(Math.max(record.q_stage, 0), questions.length)
        : 0;
    return { draft, stage };
  }

  /**
   * 解析 question 记录 message JSON 的 questions（契约 §14.3.1 同款防御：
   * 解析抛错 / parsed 非对象 / questions 非数组 / 空数组 / 首元素缺 string 型
   * question → undefined。与发送端 sendQuestionRecord 的校验完全一致）。
   */
  private parseQuestionPayload(
    message: string,
  ): Array<QuestionV2Info> | undefined {
    try {
      const parsed = JSON.parse(message) as unknown;
      const parsedQuestions =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).questions
          : undefined;
      if (
        Array.isArray(parsedQuestions) &&
        parsedQuestions.length > 0 &&
        typeof (parsedQuestions[0] as { question?: unknown })?.question ===
          "string"
      ) {
        return parsedQuestions as Array<QuestionV2Info>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /**
   * question 阶段文本（ctx/sessionLabel 组装；回调与纯文本路径重渲染共用）。
   */
  private questionStageText(
    record: SessionRecord,
    projectLabel: string,
    questions: Array<QuestionV2Info>,
    stage: number,
    draft: Array<Array<string>>,
    inputPending: boolean,
  ): string {
    const ctx: FormatContext = {
      root: this.root,
      botToken: this.config.botToken,
      projectLabel,
      sessions: this.sessions,
      sessionInfo: this.sessionInfo,
    };
    const sessionLabel = safeText(
      record.session_name || shortID(record.session_id),
      100,
      ctx,
    );
    return buildQuestionStageText(
      projectLabel,
      "question",
      sessionLabel,
      questions,
      stage,
      draft,
      inputPending,
      ctx,
    );
  }

  /**
   * 非终态编辑：完整重渲染当前阶段文本 + 键盘（契约 §14.3.1 末）。键盘经
   * questionEntryID 重建（与发送端同源；超限 undefined → 无键盘纯文本编辑，
   * 对应发送端无键盘退化，可接受）。编辑失败 logWarn 不中断。
   */
  private async renderQuestionStage(
    record: SessionRecord,
    projectLabel: string,
    requestID: string,
    questions: Array<QuestionV2Info>,
    stage: number,
    draft: Array<Array<string>>,
    inputPending: boolean,
    chatID: number | string,
    messageID: number,
  ): Promise<void> {
    const text = this.questionStageText(
      record,
      projectLabel,
      questions,
      stage,
      draft,
      inputPending,
    );
    const entryID = this.questionEntryID(requestID);
    const keyboard =
      entryID === undefined
        ? undefined
        : buildQuestionKeyboard(entryID, questions, stage, draft);
    await this.editQuestionWizardMessage(chatID, messageID, text, keyboard);
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
   * 统一富文本编辑 helper（契约 sessions-relay.md §15.3，Round 5）：
   * 内部 wire 形态为 §15.2 探针赢家形态（editMessageText + rich_message.html）。
   * text 经 limitMessage 限长；keyboard 可选，undefined 时不携带 reply_markup
   * （键盘移除）；失败 logWarn 不抛错。
   */
  private async richEditMessage(
    chatID: number | string,
    messageID: number,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    try {
      await telegramWithRetry(
        "editMessageText",
        {
          chat_id: chatID,
          message_id: messageID,
          rich_message: { html: limitMessage(text) },
          ...(keyboard ? { reply_markup: keyboard } : {}),
        },
        { config: this.config, signal: this.abortController.signal },
      );
    } catch (error) {
      await this.log("warn", "Rich message edit failed", {
        error: errorCategory(error, {
          root: this.root,
          botToken: this.config.botToken,
        }),
      });
    }
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
    await this.richEditMessage(
      chatID,
      messageID,
      originalText + "\x0a" + resultLine,
    );
  }

  /**
   * 编辑向导消息（契约 §14.3.1 冻结签名、§15.3）：text = 完整新渲染文本
   * （buildQuestionStageText）或 原文本 + 结果行；keyboard 不传/undefined
   * ⇒ 键盘移除（终态，决策 #4 同款）。走 richEditMessage 统一富文本编辑，
   * 不传 reply_markup ⇒ 键盘被移除。编辑失败 logWarn 不抛错。
   * 结果行冻结：submit 成功 → ✅ Submitted；cancel → ❌ Cancelled。
   */
  private async editQuestionWizardMessage(
    chatID: number | string,
    messageID: number,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ) {
    await this.richEditMessage(chatID, messageID, text, keyboard);
  }

  private async editMenuMessage(
    chatID: number | string,
    messageID: number,
    registry: ProjectRegistry,
  ) {
    await this.richEditMessage(
      chatID,
      messageID,
      menuText(),
      buildMenuKeyboard(registry),
    );
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

  /** 实例级 flag：sendMessageWithKeyboard 首次响应键名诊断已记录（§14.8.3）。 */
  private sendRichMessageKeysLogged = false;

  private async sendMessageWithKeyboard(
    text: string,
    replyMarkup: TelegramInlineKeyboard,
  ): Promise<number | undefined> {
    if (this.abortController.signal.aborted) return undefined;
    const response = await telegramWithRetry<{
      result?: {
        message_id?: number;
        message?: { message_id?: number };
        messageId?: number;
      };
    }>("sendRichMessage", {
      chat_id: this.config.chatId,
      rich_message: { html: limitMessage(text) },
      reply_markup: replyMarkup,
    }, { config: this.config, signal: this.abortController.signal });
    // 契约 §14.8.3：三形态防御解析（官方/非官方通道响应键名形态不同；实机
    // 观察 sendRichMessage 无 result.message_id 导致 q_msg_id 缺失）。既有
    // 调用点（permission 键盘发送）忽略返回值，兼容。
    const messageID =
      response?.result?.message_id ??
      response?.result?.message?.message_id ??
      (response as { result?: { messageId?: number } } | undefined)?.result
        ?.messageId ??
      undefined;
    // 首次发送成功时记录响应键名形态（仅键名、不含任何内容，天然脱敏）
    // 供诊断响应形态演进。
    if (!this.sendRichMessageKeysLogged) {
      this.sendRichMessageKeysLogged = true;
      dline(
        "sendMessageWithKeyboard response keys: " +
          Object.keys(response?.result ?? {}).join(","),
      );
    }
    return messageID;
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
