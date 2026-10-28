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
import {
  addProspect,
  listProspects,
  getCrmStats,
  searchProspects,
} from "./crm.js";

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

  // ── HELP ──────────────────────────────────────

  if (lower === "/start" || lower === "/help") {
    await sendMessage(
      chatId,
      [
        "🤖 *XTOP Retail Workforce*",
        "",
        "*Operations:*",
        "/status — System health check",
        "/tasks — Recent task history",
        "/discover — Find remote software jobs",
        "/report — Task completion report",
        "",
        "*CRM:*",
        "/crm — Pipeline dashboard",
        "/addprospect — Add a business prospect",
        "/prospects — List or search prospects",
        "/find \\<keyword\\> — Search prospects",
        "",
        "More features coming in future stages.",
      ].join("\n"),
      { parseMode: "Markdown" }
    );
    return;
  }

  // ── STATUS ────────────────────────────────────

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

  // ── TASKS ─────────────────────────────────────

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

  // ── DISCOVER ──────────────────────────────────

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

  // ── REPORT ────────────────────────────────────

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

  // ── CRM: DASHBOARD ────────────────────────────

  if (lower === "/crm") {
    try {
      const stats = await getCrmStats();

      const statusLines = Object.entries(stats.byStatus)
        .map(([s, count]) => `  ${escapeMd(s)}: ${count}`)
        .join("\n");

      const recentLines = stats.recentProspects.length > 0
        ? stats.recentProspects
            .map(
              (p) =>
                `  ${escapeMd(p.business_name)} (score: ${p.score}, ${escapeMd(p.status)})`
            )
            .join("\n")
        : "  No prospects yet.";

      await sendMessage(
        chatId,
        [
          "📊 *CRM Dashboard*",
          "",
          `Total prospects: ${stats.total}`,
          `Pending outreach: ${stats.pendingOutreach}`,
          "",
          "*By status:*",
          statusLines || "  None",
          "",
          "*Recent prospects:*",
          recentLines,
          "",
          "Use /addprospect to add a new prospect.",
          "Use /prospects to see the full list.",
        ].join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(
        chatId,
        `❌ CRM error: ${escapeMd(msg)}`
      );
    }
    return;
  }

  // ── CRM: ADD PROSPECT ─────────────────────────

  if (lower.startsWith("/addprospect")) {
    const raw = text.slice("/addprospect".length).trim();

    if (!raw) {
      await sendMessage(
        chatId,
        [
          "📝 *Add a Prospect*",
          "",
          "Format:",
          "`/addprospect Business Name | email | phone`",
          "",
          "Example:",
          "`/addprospect Ero Bakery | ero@email.com | 08012345678`",
          "",
          "Only the business name is required.",
        ].join("\n"),
        { parseMode: "Markdown" }
      );
      return;
    }

    const parts = raw.split("|").map((s) => s.trim());
    const businessName = parts[0];
    const email = parts[1] || undefined;
    const phone = parts[2] || undefined;
    const website = parts[3] || undefined;

    if (!businessName) {
      await sendMessage(chatId, "❌ Business name is required.");
      return;
    }

    try {
      const prospect = await addProspect({
        business_name: businessName,
        email,
        phone,
        website,
        source: "telegram",
      });

      await sendMessage(
        chatId,
        [
          "✅ *Prospect Added*",
          "",
          `Business: ${escapeMd(prospect.business_name)}`,
          `Score: ${prospect.score}/100`,
          `Status: ${escapeMd(prospect.status)}`,
          `City: ${escapeMd(prospect.city)}`,
          email ? `Email: ${escapeMd(email)}` : "",
          phone ? `Phone: ${escapeMd(phone)}` : "",
          "",
          "Use /crm to see your pipeline.",
        ]
          .filter(Boolean)
          .join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(
        chatId,
        `❌ Could not add prospect: ${escapeMd(msg)}`
      );
    }
    return;
  }

  // ── CRM: LIST / SEARCH PROSPECTS ──────────────

  if (lower.startsWith("/prospects")) {
    const query = text.slice("/prospects".length).trim();

    try {
      const prospects = query
        ? await searchProspects(query)
        : await listProspects(10);

      if (prospects.length === 0) {
        await sendMessage(
          chatId,
          query
            ? `🔍 No prospects matching "${escapeMd(query)}".`
            : "📋 No prospects yet. Use /addprospect to add one."
        );
        return;
      }

      const lines = prospects.map((p) => {
        const icon =
          p.status === "won"
            ? "🏆"
            : p.status === "lost"
              ? "❌"
              : p.status === "negotiating"
                ? "🤝"
                : p.status === "proposal_sent"
                  ? "📄"
                  : p.status === "contacted"
                    ? "📞"
                    : "🆕";
        return `${icon} ${escapeMd(p.business_name)}\n   Score: ${p.score} | ${escapeMd(p.status)} | ${escapeMd(p.city)}`;
      });

      await sendMessage(
        chatId,
        `📋 *Prospects*\n\n${lines.join("\n\n")}`,
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(
        chatId,
        `❌ Could not load prospects: ${escapeMd(msg)}`
      );
    }
    return;
  }

  // ── CRM: FIND ─────────────────────────────────

  if (lower.startsWith("/find ")) {
    const query = text.slice("/find ".length).trim();

    if (!query) {
      await sendMessage(
        chatId,
        "Usage: `/find business name or keyword`",
        { parseMode: "Markdown" }
      );
      return;
    }

    try {
      const results = await searchProspects(query);

      if (results.length === 0) {
        await sendMessage(
          chatId,
          `🔍 No prospects found for "${escapeMd(query)}".`
        );
        return;
      }

      const lines = results.map(
        (p) =>
          `• ${escapeMd(p.business_name)} (${escapeMd(p.status)}, score: ${p.score})`
      );

      await sendMessage(
        chatId,
        `🔍 *Search Results*\n\n${lines.join("\n")}`,
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(
        chatId,
        `❌ Search error: ${escapeMd(msg)}`
      );
    }
    return;
  }

  // ── NATURAL LANGUAGE: AUTO-DETECT PROSPECTS ───

  // Detect patterns like:
  //   "Ruth empire / ruth@email.com / 08012345678"
  //   "Ruth empire | ruth@email.com | 08012345678"
  //   "Ruth empire, ruth@email.com, 08012345678"
  const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const phonePattern = /(?:\+?234|0)\d{9,10}/;
  const hasEmail = emailPattern.test(text);
  const hasPhone = phonePattern.test(text);

  // If the message contains an email or phone and looks like
  // it has a business name before it, treat it as a prospect.
  if (hasEmail || hasPhone) {
    // Split on common separators: / | ,
    const parts = text.split(/[/|,]/).map((s) => s.trim()).filter(Boolean);

    if (parts.length >= 1) {
      const businessName = parts[0].replace(emailPattern, "").replace(phonePattern, "").trim();
      const email = parts.find((p) => emailPattern.test(p))?.match(emailPattern)?.[0];
      const phone = parts.find((p) => phonePattern.test(p))?.match(phonePattern)?.[0];

      if (businessName.length >= 2) {
        try {
          const prospect = await addProspect({
            business_name: businessName,
            email,
            phone,
            source: "telegram_natural",
          });

          await sendMessage(
            chatId,
            [
              "✅ *Prospect Added* (auto-detected)",
              "",
              `Business: ${escapeMd(prospect.business_name)}`,
              `Score: ${prospect.score}/100`,
              `Status: ${escapeMd(prospect.status)}`,
              `City: ${escapeMd(prospect.city)}`,
              email ? `Email: ${escapeMd(email)}` : "",
              phone ? `Phone: ${escapeMd(phone)}` : "",
              "",
              "Tip: Use /addprospect Name | email | phone for more control.",
            ]
              .filter(Boolean)
              .join("\n"),
            { parseMode: "Markdown" }
          );
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : "unknown";
          await sendMessage(
            chatId,
            `⚠️ Tried to add a prospect but failed: ${escapeMd(msg)}`
          );
          return;
        }
      }
    }
  }

  // ── NATURAL LANGUAGE FALLBACK ─────────────────

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
