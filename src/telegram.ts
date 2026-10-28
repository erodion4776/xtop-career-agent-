const API = "https://api.telegram.org";

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return t;
}

// ── Send message ───────────────────────────────────────
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
    const data = await res.json();
    if (!data.ok) {
      console.error("sendMessage failed:", data.description);
      // Retry without Markdown if parse error
      if (data.description?.includes("parse")) {
        body.parse_mode = undefined;
        const retry = await fetch(`${API}/bot${token()}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return retry.json();
      }
    }
    return data;
  } catch (e) {
    console.error("sendMessage error:", e);
    return null;
  }
}

// ── Answer callback query ──────────────────────────────
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
    /* ignore */
  }
}

// ── Edit message text ─────────────────────────────────
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
    const data = await res.json();
    if (!data.ok) {
      console.error("editMessageText failed:", data.description);
      // If Markdown parse error, retry without it
      if (data.description?.includes("parse")) {
        body.parse_mode = undefined;
        const retry = await fetch(`${API}/bot${token()}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const retryData = await retry.json();
        if (!retryData.ok) {
          console.error("editMessageText retry failed:", retryData.description);
          // Last resort: send a new message instead of editing
          const newMsg = await sendMessage(chatId, text, replyMarkup);
          return newMsg;
        }
        return retryData;
      }
      // "message is not modified" is fine, ignore it
      if (data.description?.includes("not modified")) {
        return data;
      }
      // For any other error, send new message
      const newMsg = await sendMessage(chatId, text, replyMarkup);
      return newMsg;
    }
    return data;
  } catch (e) {
    console.error("editMessageText error:", e);
    // Fallback: send new message
    return sendMessage(chatId, text, replyMarkup);
  }
}
