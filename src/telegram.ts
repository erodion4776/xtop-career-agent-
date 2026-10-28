const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const OWNER_ID = process.env.TELEGRAM_OWNER_ID?.trim();
const API = "https://api.telegram.org";

export function isConfigured(): boolean {
  return Boolean(BOT_TOKEN && OWNER_ID);
}

export function isOwner(userId: number): boolean {
  return String(userId) === OWNER_ID;
}

async function call(
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN not configured.");
  }

  const res = await fetch(`${API}/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: unknown;
  };

  if (!data.ok) {
    throw new Error(
      `Telegram ${method}: ${data.description || "unknown error"}`
    );
  }

  return data;
}

export async function sendMessage(
  chatId: number,
  text: string,
  options?: {
    parseMode?: "Markdown" | "HTML";
    replyMarkup?: Record<string, unknown>;
  }
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4096),
  };

  if (options?.parseMode) body.parse_mode = options.parseMode;
  if (options?.replyMarkup) body.reply_markup = options.replyMarkup;

  await call("sendMessage", body);
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  options?: {
    parseMode?: "Markdown" | "HTML";
    replyMarkup?: Record<string, unknown>;
  }
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4096),
  };

  if (options?.parseMode) body.parse_mode = options.parseMode;
  if (options?.replyMarkup) body.reply_markup = options.replyMarkup;

  await call("editMessageText", body);
}

export async function answerCallback(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text?.slice(0, 200),
  });
}

export async function setWebhook(
  url: string,
  secretToken?: string
): Promise<void> {
  const body: Record<string, unknown> = { url };
  if (secretToken) body.secret_token = secretToken;
  await call("setWebhook", body);
}

export async function deleteWebhook(): Promise<void> {
  await call("deleteWebhook", {});
}

export async function getMe(): Promise<Record<string, unknown>> {
  return call("getMe", {});
}
