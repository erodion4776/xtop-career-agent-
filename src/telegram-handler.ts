import {
  isOwner,
  sendMessage,
  answerCallback,
} from "./telegram.js";
import {
  createTask,
  listRecentTasks,
  getTask,
} from "./task-engine.js";
import { processPendingTasks } from "./task-runner.js";
import { logAction } from "./audit-log.js";

/** Track processed update IDs to avoid duplicates. */
const processed = new Set<number>();
const MAX_TRACKED = 5000;

function isDuplicate(updateId: number): boolean {
  if (processed.has(updateId)) return true;
  processed.add(updateId);

  if (processed.size > MAX_TRACKED) {
    const arr = [...processed];
    for (let i = 0; i < Math.floor(arr.length / 2); i++) {
      processed.delete(arr[i]);
    }
  }

  return false;
}

/**
 * Escape Telegram Markdown v1 special characters in
 * dynamic content so underscores, asterisks, etc. in
 * task names and error messages don't break parsing.
 */
function escapeMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export async function handleUpdate(
  update: Record<string, unknown>
): Promise<void> {
  const updateId = update.update_id as number;
  if (typeof updateId !== "number") return;
  if (isDuplicate(updateId)) return;

  // Handle callback queries (button presses)
  const callback = update.callback_query as
    | Record<string, unknown>
    | undefined;

  if (callback) {
    await handleCallback(callback);
    return;
  }

  // Handle text messages
  const message = update.message as
    | Record<string, unknown>
    | undefined;

  if (!message) return;

  const from = message.from as
    | Record<string, unknown>
    | undefined;
  const chat = message.chat as
    | Record<string, unknown>
    | undefined;

  if (!from || !chat) return;

  const userId = from.id as number;
  const chatId = chat.id as number;
  const text = (message.text as string)?.trim();

  if (typeof userId !== "number" || typeof chatId !== "number")
    return;

  // Reject unauthorised users
  if (!isOwner(userId)) {
    await sendMessage(
      chatId,
      "⛔ Unauthorised. This bot is private."
    );
    await logAction("unauthorised_access", {
      userId,
      chatId,
    });
    return;
  }

  if (!text) {
    await sendMessage(
      chatId,
      "I can only process text messages and commands."
    );
    return;
  }

  await routeCommand(chatId, text);
}

async function routeCommand(
  chatId: number,
  text: string
): Promise<void> {
  const lower = text.toLowerCase();

  if (lower === "/start" || lower === "/help") {
    await sendMessage(
      chatId,
      [
        "🤖 *XTOP Retail Workforce*",
        "",
        "Available commands:",
        "/status — System health check",
        "/tasks — Recent task history",
        "/discover — Find remote software jobs",
        "/report — Task completion report",
        "/help — Show this message",
        "",
        "You can also type natural language instructions.",
        "More features coming in future stages.",
      ].join("\n"),
      { parseMode: "Markdown" }
    );
    return;
  }

  if (lower === "/status") {
    await sendMessage(chatId, "⏳ Checking system health...");

    try {
      const task = await createTask(
        "health_check",
        {},
        "telegram"
      );
      await processPendingTasks();
      const result = await getTask(task.id);

      if (result?.status === "completed" && result.result) {
        const r = result.result;
        await sendMessage(
          chatId,
          [
            "✅ *System Status*",
            "",
            `Server: ${escapeMd(String(r.server || "online"))}`,
            `Database: ${escapeMd(String(r.database || "connected"))}`,
            `Saved jobs: ${r.jobCount ?? "?"}`,
            `Time: ${escapeMd(String(r.timestamp || new Date().toISOString()))}`,
          ].join("\n"),
          { parseMode: "Markdown" }
        );
      } else {
        await sendMessage(
          chatId,
          "⚠️ Health check task created but not yet completed. Try /status again in a moment."
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      await sendMessage(
        chatId,
        `❌ Health check failed: ${escapeMd(msg)}`
      );
    }
    return;
  }

  if (lower === "/tasks") {
    try {
      const tasks = await listRecentTasks(5);

      if (tasks.length === 0) {
        await sendMessage(chatId, "📋 No tasks recorded yet.");
        return;
      }

      const lines = tasks.map((t) => {
        const icon =
          t.status === "completed"
            ? "✅"
            : t.status === "failed"
              ? "❌"
              : t.status === "running"
                ? "🔄"
                : t.status === "pending"
                  ? "⏳"
                  : "📌";
        const time = new Date(t.created_at).toLocaleString();
        return `${icon} ${escapeMd(t.task_type)} — ${escapeMd(t.status)}\n   ${escapeMd(time)}`;
      });

      await sendMessage(
        chatId,
        `📋 *Recent Tasks*\n\n${lines.join("\n\n")}`,
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(
        chatId,
        `❌ Could not load tasks: ${escapeMd(msg)}`
      );
    }
    return;
  }

  if (lower === "/discover") {
    await sendMessage(
      chatId,
      "🔍 Starting job discovery. This may take 30–60 seconds..."
    );

    try {
      const task = await createTask(
        "discover_jobs",
        {},
        "telegram"
      );
      await processPendingTasks();
      const result = await getTask(task.id);

      if (result?.status === "completed" && result.result) {
        const r = result.result;
        await sendMessage(
          chatId,
          [
            "✅ *Job Discovery Complete*",
            "",
            `Matched: ${r.matched ?? "?"}`,
            `Saved: ${r.saved ?? "?"}`,
            `Updated: ${r.updated ?? "?"}`,
            `High fit: ${r.highSuitability ?? "?"}`,
            `Nigeria eligible: ${r.nigeriaEligible ?? "?"}`,
            "",
            "Open the dashboard for full details.",
          ].join("\n"),
          { parseMode: "Markdown" }
        );
      } else if (result?.status === "failed") {
        await sendMessage(
          chatId,
          `❌ Discovery failed: ${escapeMd(result.error || "unknown error")}`
        );
      } else {
        await sendMessage(
          chatId,
          "⏳ Discovery task is still running. Check /tasks later."
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(
        chatId,
        `❌ Discovery error: ${escapeMd(msg)}`
      );
    }
    return;
  }

  if (lower === "/report") {
    try {
      const task = await createTask(
        "task_report",
        {},
        "telegram"
      );
      await processPendingTasks();
      const result = await getTask(task.id);

      if (result?.status === "completed" && result.result) {
        const r = result.result;
        const taskList = (r.tasks as Array<Record<string, unknown>>) || [];

        if (taskList.length === 0) {
          await sendMessage(
            chatId,
            "📊 No tasks completed yet."
          );
          return;
        }

        const lines = taskList.map(
          (t) =>
            `${t.status === "completed" ? "✅" : "⏳"} ${escapeMd(String(t.type))} (${escapeMd(String(t.status))})`
        );

        await sendMessage(
          chatId,
          `📊 *Task Report*\n\n${lines.join("\n")}`,
          { parseMode: "Markdown" }
        );
      } else {
        await sendMessage(
          chatId,
          "⏳ Report is being generated. Try again shortly."
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(
        chatId,
        `❌ Report error: ${escapeMd(msg)}`
      );
    }
    return;
  }

  // Natural language fallback
  await sendMessage(
    chatId,
    [
      "📝 I received your message:",
      `"${escapeMd(text.slice(0, 200))}"`,
      "",
      "Natural language task processing will improve in future stages.",
      "For now, use /help to see available commands.",
    ].join("\n")
  );

  await logAction("unrecognised_command", {
    text: text.slice(0, 200),
  });
}

async function handleCallback(
  callback: Record<string, unknown>
): Promise<void> {
  const from = callback.from as
    | Record<string, unknown>
    | undefined;
  const data = callback.data as string | undefined;
  const queryId = callback.id as string;

  if (!from || !queryId) return;

  const userId = from.id as number;

  if (!isOwner(userId)) {
    await answerCallback(queryId, "Unauthorised.");
    return;
  }

  if (!data) {
    await answerCallback(queryId, "No action data.");
    return;
  }

  // Future: handle approval buttons here
  await answerCallback(
    queryId,
    `Action "${data}" received. Button handlers coming in Stage 2.`
  );
}
