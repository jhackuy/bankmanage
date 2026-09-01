/**
 * Worker environment bindings.
 * Mirrors wrangler.jsonc binding names.
 * Secrets (TELEGRAM_BOT_TOKEN etc.) are never logged or exposed.
 */
export interface Env {
  // D1 database
  DB: D1Database;
  // R2 private document bucket
  DOCUMENTS: R2Bucket;
  // Static assets (Vite-built UI)
  ASSETS?: Fetcher;
  // Non-secret vars
  APP_ENV: string;
  LOG_LEVEL?: string;
  // Secrets — present at runtime but never surfaced in responses or logs
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
}
