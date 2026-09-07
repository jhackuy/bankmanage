/**
 * Forward-compatible Telegram Update parser.
 *
 * Accepts the raw JSON payload delivered by the Bot API and produces the
 * strongly-typed `TelegramUpdateEnvelope` used by the bot service. The
 * parser never throws for unknown fields; it throws only when the payload
 * is fundamentally malformed (missing `update_id` or non-object root).
 *
 * This file lives at the service layer so the worker route handler can
 * share the same parser that the FakeTelegramAdapter's tests rely on.
 */

import { TelegramUpdateParseError } from "./update-parser-errors.js";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdateEnvelope } from "./update-envelope.js";

function readString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new TelegramUpdateParseError(`Update field '${field}' must be a string`);
}

function readNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TelegramUpdateParseError(`Update field '${field}' must be a number`);
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new TelegramUpdateParseError(`Update field '${field}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, field: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  throw new TelegramUpdateParseError(`Update field '${field}' must be an array`);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseUser(raw: unknown): TelegramMessage["from"] | null {
  if (raw === undefined || raw === null) return null;
  const obj = readObject(raw, "from");
  const id = readNumber(obj["id"], "from.id");
  const isBot = obj["is_bot"] === true;
  const firstName = readString(obj["first_name"] ?? "", "from.first_name");
  const lastName = readOptionalString(obj["last_name"]);
  const username = readOptionalString(obj["username"]);
  return { id, isBot, firstName, lastName, username };
}

function parseChat(raw: unknown): TelegramMessage["chat"] {
  const obj = readObject(raw, "chat");
  const id = readNumber(obj["id"], "chat.id");
  const type = readString(obj["type"] ?? "", "chat.type");
  return { id, type };
}

function parseMessage(raw: unknown): TelegramMessage | null {
  if (raw === undefined || raw === null) return null;
  const obj = readObject(raw, "message");
  const messageId = readNumber(obj["message_id"], "message.message_id");
  const chat = parseChat(obj["chat"]);
  const from = parseUser(obj["from"]);
  const date = readNumber(obj["date"], "message.date");
  const text = readString(obj["text"] ?? "", "message.text");
  const entitiesRaw = obj["entities"] ?? [];
  const entities = readArray(entitiesRaw, "message.entities").map((entity, index) => {
    if (entity === null || typeof entity !== "object") {
      throw new TelegramUpdateParseError(`entities[${index}] must be an object`);
    }
    const e = entity as Record<string, unknown>;
    return {
      type: readString(e["type"], `entities[${index}].type`),
      offset: readNumber(e["offset"], `entities[${index}].offset`),
      length: readNumber(e["length"], `entities[${index}].length`),
    };
  });
  return { messageId, chat, from, date, text, entities };
}

function parseCallbackQuery(raw: unknown): TelegramCallbackQuery | null {
  if (raw === undefined || raw === null) return null;
  const obj = readObject(raw, "callback_query");
  const id = readString(obj["id"], "callback_query.id");
  const fromRaw = obj["from"];
  const fromObj = readObject(fromRaw, "callback_query.from");
  const fromId = readNumber(fromObj["id"], "callback_query.from.id");
  const from: TelegramCallbackQuery["from"] = {
    id: fromId,
    isBot: fromObj["is_bot"] === true,
    firstName: readString(fromObj["first_name"] ?? "", "callback_query.from.first_name"),
    lastName: readOptionalString(fromObj["last_name"]),
    username: readOptionalString(fromObj["username"]),
  };
  const chatInstance = readString(obj["chat_instance"], "callback_query.chat_instance");
  const data = readString(obj["data"] ?? "", "callback_query.data");
  const message = parseMessage(obj["message"]);
  return { id, from, chatInstance, data, message };
}

export function parseTelegramUpdate(raw: unknown): TelegramUpdateEnvelope {
  if (raw === null || typeof raw !== "object") {
    throw new TelegramUpdateParseError("Update payload must be a JSON object");
  }
  const obj = readObject(raw, "update");
  const updateId = readNumber(obj["update_id"], "update_id");
  const message = parseMessage(obj["message"]);
  const callbackQuery = parseCallbackQuery(obj["callback_query"]);
  return { updateId, message, callbackQuery };
}

export function parseMessageUpdate(envelope: TelegramUpdateEnvelope): TelegramMessage | null {
  return envelope.message;
}

export function parseCallbackQueryFromEnvelope(
  envelope: TelegramUpdateEnvelope
): TelegramCallbackQuery | null {
  return envelope.callbackQuery;
}

// Re-export from the dedicated error module for ergonomic backward imports.
export { TelegramUpdateParseError } from "./update-parser-errors.js";
