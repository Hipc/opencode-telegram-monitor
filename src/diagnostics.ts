import { OTG_DIR, DIAG_PATH } from "./constants";
import { appendFileSync, mkdirSync } from "node:fs";

mkdirSync(OTG_DIR, { recursive: true });

export function dline(message: string): void {
  try {
    appendFileSync(
      DIAG_PATH,
      `${new Date().toISOString()} [${process.pid}] ${message}\n`,
    );
  } catch {
    /* diagnostics must never break the plugin */
  }
}
