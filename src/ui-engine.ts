import { sendMessage, editMessageText, answerCallbackQuery } from "./telegram.js";

// ── Types ──────────────────────────────────────────────
export interface Btn {
  text: string;
  callback_data: string;
}

export interface Keyboard {
  inline_keyboard: Btn[][];
}

// ── Build inline keyboard ──────────────────────────────
export function kb(rows: Btn[][]): Keyboard {
  return { inline_keyboard: rows };
}

// ── Single button ──────────────────────────────────────
export function btn(text: string, callbackData: string): Btn {
  // Telegram limits callback_data to 64 bytes
  const safe = callbackData.length > 60 ? callbackData.slice(0, 60) : callbackData;
  return { text, callback_data: safe };
}

// ── Navigation row ─────────────────────────────────────
export function navRow(backData?: string, homeData = "m:main"): Btn[] {
  const row: Btn[] = [];
  if (backData) row.push(btn("⬅️ Back", backData));
  row.push(btn("🏠 Home", homeData));
  return row;
}

// ── Pagination row ─────────────────────────────────────
export function pageRow(prefix: string, page: number, totalPages: number): Btn[] {
  const row: Btn[] = [];
  if (page > 0) row.push(btn("◀️ Prev", `${prefix}:${page - 1}`));
  row.push(btn(`${page + 1}/${totalPages}`, `noop:${page}`));
  if (page < totalPages - 1) row.push(btn("Next ▶️", `${prefix}:${page + 1}`));
  return row;
}

// ── Confirmation keyboard ──────────────────────────────
export function confirmKb(yesData: string, noData: string): Keyboard {
  return kb([[btn("✅ Yes", yesData), btn("❌ No", noData)]]);
}

// ── Send menu with buttons ─────────────────────────────
export async function sendMenu(
  chatId: number,
  text: string,
  buttons: Btn[][]
): Promise<any> {
  return sendMessage(chatId, text, kb(buttons));
}

// ── Edit existing message ──────────────────────────────
export async function editMenu(
  chatId: number,
  messageId: number,
  text: string,
  buttons: Btn[][]
): Promise<any> {
  return editMessageText(chatId, messageId, text, kb(buttons));
}

// ── Paginated list builder ─────────────────────────────
export function paginateList<T>(
  items: T[],
  page: number,
  pageSize: number,
  labelFn: (item: T, index: number) => string,
  callbackPrefix: string
): { text: string; buttons: Btn[][] } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  const slice = items.slice(start, start + pageSize);

  const lines = slice.map((item, i) => labelFn(item, start + i));
  const buttons: Btn[][] = [];

  // Item buttons (2 per row)
  for (let i = 0; i < slice.length; i += 2) {
    const row: Btn[] = [];
    row.push(btn(
      labelFn(slice[i], start + i).replace(/[*_`]/g, "").slice(0, 30),
      `${callbackPrefix}:${start + i}`
    ));
    if (slice[i + 1]) {
      row.push(btn(
        labelFn(slice[i + 1], start + i + 1).replace(/[*_`]/g, "").slice(0, 30),
        `${callbackPrefix}:${start + i + 1}`
      ));
    }
    buttons.push(row);
  }

  // Pagination
  if (totalPages > 1) {
    buttons.push(pageRow(callbackPrefix.replace(/:\d+$/, ""), safePage, totalPages));
  }

  buttons.push(navRow());

  return {
    text: lines.join("\n") + `\n\nPage ${safePage + 1}/${totalPages}`,
    buttons,
  };
}

// ── Answer callback ────────────────────────────────────
export async function ackCallback(queryId: string, text?: string) {
  try {
    await answerCallbackQuery(queryId, text);
  } catch { /* ignore */ }
}

// ── Escape for Markdown ───────────────────────────────
export function esc(s: string): string {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
