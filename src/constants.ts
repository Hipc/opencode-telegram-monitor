import { homedir } from "node:os";
import { join } from "node:path";

export const OTG_DIR = join(homedir(), ".otg");
export const DIAG_PATH = join(OTG_DIR, "tgdiag.log");

export const DEFAULT_TTL_MS = 60_000;

export const IDLE_DEBOUNCE_MS = 5_000;
export const WAITING_NOTIFY_DEBOUNCE_MS = 1_000;
export const TELEGRAM_POLL_SECONDS = 25;
export const TELEGRAM_POLL_TIMEOUT_MS = 35_000;
export const TELEGRAM_SEND_TIMEOUT_MS = 15_000;
export const TELEGRAM_SEND_ATTEMPTS = 3;
export const TELEGRAM_MESSAGE_LIMIT = 3_500;
export const MAX_EVENT_IDS = 2_000;
export const MENU_MAX_PROJECTS = 20;
export const POLLER_ACQUIRE_INTERVAL_MS = 20_000;
export const POLLER_LOCK_TTL_MS = 60_000;
export const REGISTER_INTERVAL_MS = 5 * 60_000;
// 暂时停用的命令（计划中，尚未开放）。路由收到这些命令时回复计划中提示；
// 对应实现方法保留，将来恢复只需从这里删除命令名并恢复 setMyCommands/helpText。
export const PLANNED_COMMANDS = new Set([
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
export const ICON_COMPLETED = "✅";
export const ICON_FAILED = "❌";
export const ICON_CANCELLED = "❎";
export const ICON_PERMISSION = "⚠️";
export const ICON_QUESTION = "❓";
export const ICON_RUNNING = "🟢";
export const ICON_RETRYING = "🔁";
export const ICON_IDLE = "💤";
export const ICON_WAITING = "⏳";
export const ICON_USAGE = "📊";
export const ICON_TODO = "📋";
export const ICON_HELP = "💁";
export const ICON_SESSIONS = "🗂️";
export const ICON_READY = "🟢";
export const ICON_STATUS = "📊";
