export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}
