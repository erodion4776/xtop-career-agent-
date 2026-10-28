const API = "https://api.telegram.org";

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return t;
}

// ── Send message (with optional inline keyboard) ───────
export async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: any
): Promise<any> {
  const body: Record<string, any> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(`${API}/bot${token()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (e) {
    console.error("sendMessage error:", e);
    return null;
  }
}

// ── Answer callback query (required by Telegram) ───────
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  const body: Record<string, any> = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  try {
    await fetch(`${API}/bot${token()}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* ignore expired callbacks */
  }
}

// ── Edit existing message text + buttons ───────────────
export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: any
): Promise<any> {
  const body: Record<string, any> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(`${API}/bot${token()}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch {
    return null;
  }
}
