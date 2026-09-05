/**
 * Error type for Telegram Update parsing failures.
 *
 * Kept in its own module so route handlers can catch the error without
 * depending on the parser internals.
 */

export class TelegramUpdateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramUpdateParseError";
  }
}
