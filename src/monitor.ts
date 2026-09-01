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
  deleteProjectByPath,
  findEntryByToken,
  registerProject,
  setProjectEnabled,
  type ProjectRegistry,
  type ProjectRegistryStore,
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
        });
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
        });
        return;
      }

      case "permission.replied":
      case "permission.v2.replied": {
        if (!sessionID) return;
        const requestID =
          string(properties.requestID) ??
          string(properties.permissionID);
        if (requestID) {
          this.cancelWaitingNotify(requestID);
          this.ensureSession(sessionID).waitingByRequestID.delete(requestID);
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
        });
        return;
      }

      case "question.replied":
      case "question.rejected":
      case "question.v2.replied":
      case "question.v2.rejected": {
        if (!sessionID) return;
        const requestID = string(properties.requestID);
        if (requestID) {
          this.cancelWaitingNotify(requestID);
          this.ensureSession(sessionID).waitingByRequestID.delete(requestID);
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

  private addWaiting(sessionID: string, waiting: WaitingProjection) {
    const session = this.ensureSession(sessionID);
    if (this.seenWaitingRequestIDs.has(waiting.requestID)) return;
    rememberBounded(this.seenWaitingRequestIDs, waiting.requestID);
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
      menuText(registry),
      buildMenuKeyboard(registry),
    );
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

  private async editMenuMessage(
    chatID: number | string,
    messageID: number,
    registry: ProjectRegistry,
  ) {
    await telegramWithRetry("editMessageText", {
      chat_id: chatID,
      message_id: messageID,
      text: menuText(registry),
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
