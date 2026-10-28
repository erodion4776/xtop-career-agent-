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
import {
  generateDraft,
  listDrafts,
  approveDraft,
  rejectDraft,
  sendDraft,
  findProspectByName,
  getProspectWithHistory,
  changeProspectStatus,
} from "./outreach-engine.js";
import { supabase } from "./supabase.js";
import {
  getFullInfraStatus,
  getRepoInfo,
  getRecentCommits,
  getRenderService,
  getRenderDeploys,
  getSupabaseHealth,
} from "./infra-monitor.js";

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

function escapeMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export async function handleUpdate(
  update: Record<string, unknown>
): Promise<void> {
  const updateId = update.update_id as number;
  if (typeof updateId !== "number") return;
  if (isDuplicate(updateId)) return;

  const callback = update.callback_query as Record<string, unknown> | undefined;
  if (callback) {
    await handleCallback(callback);
    return;
  }

  const message = update.message as Record<string, unknown> | undefined;
  if (!message) return;

  const from = message.from as Record<string, unknown> | undefined;
  const chat = message.chat as Record<string, unknown> | undefined;
  if (!from || !chat) return;

  const userId = from.id as number;
  const chatId = chat.id as number;
  const text = (message.text as string)?.trim();

  if (typeof userId !== "number" || typeof chatId !== "number") return;

  if (!isOwner(userId)) {
    await sendMessage(chatId, "⛔ Unauthorised. This bot is private.");
    await logAction("unauthorised_access", { userId, chatId });
    return;
  }

  if (!text) {
    await sendMessage(chatId, "I can only process text messages and commands.");
    return;
  }

  await routeCommand(chatId, text);
}

async function routeCommand(chatId: number, text: string): Promise<void> {
  const lower = text.toLowerCase();

  // ── HELP ──────────────────────────────────────

  if (lower === "/start" || lower === "/help") {
    await sendMessage(
      chatId,
      [
        "🤖 *XTOP Retail Workforce*",
        "",
        "*Operations:*",
        "/status — System health",
        "/tasks — Task history",
        "/discover — Find remote jobs",
        "/report — Task report",
        "",
        "*Infrastructure:*",
        "/infra — Full infrastructure status",
        "/github — Repository health",
        "/render — Render service status",
        "/dbstatus — Database details",
        "",
        "*CRM:*",
        "/crm — Pipeline dashboard",
        "/addprospect — Add a prospect",
        "/prospects — List prospects",
        "/find \\<keyword\\> — Search prospects",
        "/prospect \\<name\\> — Prospect details",
        "/updatestatus \\<name\\> \\<status\\>",
        "",
        "*Outreach:*",
        "/draft \\<name\\> — Generate email draft",
        "/outreach — List pending drafts",
        "/approve \\<id\\> — Approve a draft",
        "/reject \\<id\\> — Reject a draft",
        "/send \\<id\\> — Send approved draft",
        "",
        "Or type: Business / email / phone",
      ].join("\n"),
      { parseMode: "Markdown" }
    );
    return;
  }

  // ── STATUS ────────────────────────────────────

  if (lower === "/status") {
    await sendMessage(chatId, "⏳ Checking system health...");
    try {
      const task = await createTask("health_check", {}, "telegram");
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
        await sendMessage(chatId, "⚠️ Health check not yet complete. Try again shortly.");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      await sendMessage(chatId, `❌ Health check failed: ${escapeMd(msg)}`);
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
        const icon = t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : t.status === "running" ? "🔄" : t.status === "pending" ? "⏳" : "📌";
        const time = new Date(t.created_at).toLocaleString();
        return `${icon} ${escapeMd(t.task_type)} — ${escapeMd(t.status)}\n   ${escapeMd(time)}`;
      });
      await sendMessage(chatId, `📋 *Recent Tasks*\n\n${lines.join("\n\n")}`, { parseMode: "Markdown" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Could not load tasks: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── DISCOVER ──────────────────────────────────

  if (lower === "/discover") {
    await sendMessage(chatId, "🔍 Starting job discovery. This may take 30–60 seconds...");
    try {
      const task = await createTask("discover_jobs", {}, "telegram");
      await processPendingTasks();
      const result = await getTask(task.id);
      if (result?.status === "completed" && result.result) {
        const r = result.result;
        await sendMessage(
          chatId,
          ["✅ *Job Discovery Complete*", "", `Matched: ${r.matched ?? "?"}`, `Saved: ${r.saved ?? "?"}`, `Updated: ${r.updated ?? "?"}`, `High fit: ${r.highSuitability ?? "?"}`, `Nigeria eligible: ${r.nigeriaEligible ?? "?"}`, "", "Open the dashboard for full details."].join("\n"),
          { parseMode: "Markdown" }
        );
      } else if (result?.status === "failed") {
        await sendMessage(chatId, `❌ Discovery failed: ${escapeMd(result.error || "unknown error")}`);
      } else {
        await sendMessage(chatId, "⏳ Discovery still running. Check /tasks later.");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Discovery error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── REPORT ────────────────────────────────────

  if (lower === "/report") {
    try {
      const task = await createTask("task_report", {}, "telegram");
      await processPendingTasks();
      const result = await getTask(task.id);
      if (result?.status === "completed" && result.result) {
        const r = result.result;
        const taskList = (r.tasks as Array<Record<string, unknown>>) || [];
        if (taskList.length === 0) {
          await sendMessage(chatId, "📊 No tasks completed yet.");
          return;
        }
        const lines = taskList.map((t) => `${t.status === "completed" ? "✅" : "⏳"} ${escapeMd(String(t.type))} (${escapeMd(String(t.status))})`);
        await sendMessage(chatId, `📊 *Task Report*\n\n${lines.join("\n")}`, { parseMode: "Markdown" });
      } else {
        await sendMessage(chatId, "⏳ Report generating. Try again shortly.");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Report error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── INFRASTRUCTURE: FULL STATUS ───────────────

  if (lower === "/infra") {
    await sendMessage(chatId, "⏳ Checking all infrastructure...");
    try {
      const status = await getFullInfraStatus();
      const lines = [
        "🏗️ *Infrastructure Status*",
        "",
        `${status.github.ok ? "✅" : "❌"} *GitHub:* ${escapeMd(status.github.message)}`,
        `${status.render.ok ? "✅" : "❌"} *Render:* ${escapeMd(status.render.message)}`,
        `${status.supabase.ok ? "✅" : "❌"} *Supabase:* ${escapeMd(status.supabase.message)}`,
        "",
        `Time: ${escapeMd(new Date().toISOString())}`,
      ];
      await sendMessage(chatId, lines.join("\n"), { parseMode: "Markdown" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Infra check failed: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── INFRASTRUCTURE: GITHUB ────────────────────

  if (lower === "/github") {
    await sendMessage(chatId, "⏳ Checking GitHub...");
    try {
      const repo = await getRepoInfo("erodion4776", "xtop-career-agent-");
      const commits = await getRecentCommits("erodion4776", "xtop-career-agent-", 3);

      const commitLines = commits.length > 0
        ? commits.map((c) => `  \`${c.sha}\` ${escapeMd(c.message)}\n   by ${escapeMd(c.author)} — ${c.date.slice(0, 10)}`)
        : "  No recent commits.";

      await sendMessage(
        chatId,
        [
          `🐙 *GitHub: ${escapeMd(repo.fullName)}*`,
          "",
          `Branch: ${escapeMd(repo.defaultBranch)}`,
          `Open issues: ${repo.openIssues}`,
          `Visibility: ${repo.private ? "Private" : "Public"}`,
          `Updated: ${escapeMd(repo.updatedAt.slice(0, 10))}`,
          "",
          "*Recent commits:*",
          commitLines.join("\n"),
        ].join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ GitHub error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── INFRASTRUCTURE: RENDER ────────────────────

  if (lower === "/render") {
    await sendMessage(chatId, "⏳ Checking Render...");
    try {
      const svc = await getRenderService("srv-dbf6gi0ae00c73ev0l9g");
      const deploys = await getRenderDeploys("srv-dbf6gi0ae00c73ev0l9g", 3);

      const deployLines = deploys.length > 0
        ? deploys.map((d) => {
            const icon = d.status === "live" ? "✅" : d.status === "build_failed" ? "❌" : d.status === "created" ? "🔄" : "📌";
            return `  ${icon} ${escapeMd(d.status)} — ${d.commitId || "N/A"} (${d.createdAt.slice(0, 10)})`;
          })
        : ["  No recent deploys."];

      await sendMessage(
        chatId,
        [
          `🖥️ *Render: ${escapeMd(svc.name)}*`,
          "",
          `Type: ${escapeMd(svc.type)}`,
          `Status: ${escapeMd(svc.status)}`,
          `Updated: ${escapeMd(svc.updatedAt.slice(0, 10))}`,
          "",
          "*Recent deploys:*",
          deployLines.join("\n"),
        ].join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Render error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── INFRASTRUCTURE: DATABASE ──────────────────

  if (lower === "/dbstatus") {
    await sendMessage(chatId, "⏳ Checking database...");
    try {
      const health = await getSupabaseHealth();

      if (!health.connected) {
        await sendMessage(chatId, `❌ Database disconnected: ${escapeMd(health.error || "unknown")}`);
        return;
      }

      const lines = health.tables.map((t) => {
        const icon = t.count >= 0 ? "📊" : "⚠️";
        const countStr = t.count >= 0 ? String(t.count) : "error";
        return `  ${icon} ${escapeMd(t.table)}: ${countStr} rows`;
      });

      await sendMessage(
        chatId,
        ["✅ *Supabase Database*", "", lines.join("\n"), "", `Checked: ${escapeMd(new Date().toISOString())}`].join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ DB error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── CRM: DASHBOARD ────────────────────────────

  if (lower === "/crm") {
    try {
      const stats = await getCrmStats();
      const statusLines = Object.entries(stats.byStatus).map(([s, count]) => `  ${escapeMd(s)}: ${count}`).join("\n");
      const recentLines = stats.recentProspects.length > 0
        ? stats.recentProspects.map((p) => `  ${escapeMd(p.business_name)} (score: ${p.score}, ${escapeMd(p.status)})`).join("\n")
        : "  No prospects yet.";
      await sendMessage(
        chatId,
        ["📊 *CRM Dashboard*", "", `Total prospects: ${stats.total}`, `Pending outreach: ${stats.pendingOutreach}`, "", "*By status:*", statusLines || "  None", "", "*Recent prospects:*", recentLines].join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ CRM error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── CRM: ADD PROSPECT ─────────────────────────

  if (lower.startsWith("/addprospect")) {
    const raw = text.slice("/addprospect".length).trim();
    if (!raw) {
      await sendMessage(chatId, ["📝 *Add a Prospect*", "", "Format:", "`/addprospect Business Name | email | phone`"].join("\n"), { parseMode: "Markdown" });
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
      const prospect = await addProspect({ business_name: businessName, email, phone, website, source: "telegram" });
      await sendMessage(
        chatId,
        ["✅ *Prospect Added*", "", `Business: ${escapeMd(prospect.business_name)}`, `Score: ${prospect.score}/100`, `Status: ${escapeMd(prospect.status)}`, `City: ${escapeMd(prospect.city)}`, email ? `Email: ${escapeMd(email)}` : "", phone ? `Phone: ${escapeMd(phone)}` : "", "", `Next: /draft ${escapeMd(prospect.business_name)}`].filter(Boolean).join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Could not add prospect: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── CRM: LIST PROSPECTS ───────────────────────

  if (lower.startsWith("/prospects")) {
    const query = text.slice("/prospects".length).trim();
    try {
      const prospects = query ? await searchProspects(query) : await listProspects(10);
      if (prospects.length === 0) {
        await sendMessage(chatId, query ? `🔍 No prospects matching "${escapeMd(query)}".` : "📋 No prospects yet. Use /addprospect to add one.");
        return;
      }
      const lines = prospects.map((p) => {
        const icon = p.status === "won" ? "🏆" : p.status === "lost" ? "❌" : p.status === "negotiating" ? "🤝" : p.status === "proposal_sent" ? "📄" : p.status === "contacted" ? "📞" : "🆕";
        return `${icon} ${escapeMd(p.business_name)}\n   Score: ${p.score} | ${escapeMd(p.status)} | ${escapeMd(p.city)}`;
      });
      await sendMessage(chatId, `📋 *Prospects*\n\n${lines.join("\n\n")}`, { parseMode: "Markdown" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Could not load prospects: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── CRM: FIND ─────────────────────────────────

  if (lower.startsWith("/find ")) {
    const query = text.slice("/find ".length).trim();
    if (!query) {
      await sendMessage(chatId, "Usage: `/find keyword`", { parseMode: "Markdown" });
      return;
    }
    try {
      const results = await searchProspects(query);
      if (results.length === 0) {
        await sendMessage(chatId, `🔍 No prospects found for "${escapeMd(query)}".`);
        return;
      }
      const lines = results.map((p) => `• ${escapeMd(p.business_name)} (${escapeMd(p.status)}, score: ${p.score})`);
      await sendMessage(chatId, `🔍 *Search Results*\n\n${lines.join("\n")}`, { parseMode: "Markdown" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Search error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── CRM: PROSPECT DETAILS ─────────────────────

  if (lower.startsWith("/prospect ")) {
    const name = text.slice("/prospect ".length).trim();
    if (!name) {
      await sendMessage(chatId, "Usage: `/prospect Business Name`", { parseMode: "Markdown" });
      return;
    }
    try {
      const prospect = await findProspectByName(name);
      if (!prospect) {
        await sendMessage(chatId, `🔍 No prospect found matching "${escapeMd(name)}".`);
        return;
      }
      const { outreach } = await getProspectWithHistory(prospect.id);
      const outreachLines = outreach.length > 0
        ? outreach.map((o) => `  ${o.status === "sent" ? "📤" : o.status === "approved" ? "✅" : o.status === "draft" ? "📝" : "❌"} ${escapeMd(o.type)} — ${escapeMd(o.status)} (${new Date(o.created_at).toLocaleDateString()})`).join("\n")
        : "  No outreach yet.";
      await sendMessage(
        chatId,
        [`🏢 *${escapeMd(prospect.business_name)}*`, "", `Contact: ${escapeMd(prospect.contact_name || "N/A")}`, `Email: ${escapeMd(prospect.email || "N/A")}`, `Phone: ${escapeMd(prospect.phone || "N/A")}`, `Website: ${escapeMd(prospect.website || "N/A")}`, `City: ${escapeMd(prospect.city)}`, `Industry: ${escapeMd(prospect.industry || "N/A")}`, `Score: ${prospect.score}/100`, `Status: ${escapeMd(prospect.status)}`, `Services: ${prospect.services_needed.length > 0 ? escapeMd(prospect.services_needed.join(", ")) : "N/A"}`, "", "*Outreach history:*", outreachLines, "", `ID: \`${prospect.id.slice(0, 8)}\``].join("\n"),
        { parseMode: "Markdown" }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── CRM: UPDATE STATUS ────────────────────────

  if (lower.startsWith("/updatestatus ")) {
    const raw = text.slice("/updatestatus ".length).trim();
    const parts = raw.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, ["Usage: `/updatestatus BusinessName newstatus`", "", "Statuses: new, contacted, qualified, proposal\\_sent, negotiating, won, lost"].join("\n"), { parseMode: "Markdown" });
      return;
    }
    const newStatus = parts[parts.length - 1].toLowerCase();
    const name = parts.slice(0, -1).join(" ");
    try {
      const prospect = await findProspectByName(name);
      if (!prospect) {
        await sendMessage(chatId, `🔍 No prospect found matching "${escapeMd(name)}".`);
        return;
      }
      await changeProspectStatus(prospect.id, newStatus);
      await sendMessage(chatId, `✅ ${escapeMd(prospect.business_name)} status updated to *${escapeMd(newStatus)}*.`, { parseMode: "Markdown" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ ${escapeMd(msg)}`);
    }
    return;
  }

  // ── OUTREACH: GENERATE DRAFT ──────────────────

  if (lower.startsWith("/draft ")) {
    const name = text.slice("/draft ".length).trim();
    if (!name) {
      await sendMessage(chatId, "Usage: `/draft Business Name`", { parseMode: "Markdown" });
      return;
    }
    await sendMessage(chatId, `⏳ Generating outreach draft for "${escapeMd(name)}"...`);
    try {
      const prospect = await findProspectByName(name);
      if (!prospect) {
        await sendMessage(chatId, `🔍 No prospect found matching "${escapeMd(name)}". Add them first with /addprospect.`);
        return;
      }
      if (!prospect.email) {
        await sendMessage(chatId, `⚠️ ${escapeMd(prospect.business_name)} has no email address.`);
        return;
      }
      const draft = await generateDraft(prospect.id);
      await sendMessage(
        chatId,
        ["📝 *Outreach Draft Ready*", "", `To: ${escapeMd(prospect.email)}`, `Subject: ${escapeMd(draft.subject || "(none)")}`, "", escapeMd(draft.body || "(empty)"), "", `Draft ID: \`${draft.id.slice(0, 8)}\``, "", "Next steps:", `/approve ${draft.id.slice(0, 8)} — approve for sending`, `/reject ${draft.id.slice(0, 8)} — discard this draft`].join("\n"),
        { parseMode: "Markdown" }
      );
      await logAction("draft_generated", { prospectId: prospect.id, draftId: draft.id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Draft error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── OUTREACH: LIST DRAFTS ─────────────────────

  if (lower === "/outreach") {
    try {
      const drafts = await listDrafts();
      const approved = await listDrafts("approved");
      if (drafts.length === 0 && approved.length === 0) {
        await sendMessage(chatId, "📋 No pending drafts. Use `/draft Business Name` to create one.", { parseMode: "Markdown" });
        return;
      }
      const lines: string[] = [];
      if (approved.length > 0) {
        lines.push("*Approved (ready to send):*");
        for (const d of approved) {
          lines.push(`  ✅ ${escapeMd(d.business_name || "Unknown")} — "${escapeMd(d.subject || "(no subject)")}"`, `     /send ${d.id.slice(0, 8)}`);
        }
        lines.push("");
      }
      if (drafts.length > 0) {
        lines.push("*Drafts (awaiting approval):*");
        for (const d of drafts) {
          lines.push(`  📝 ${escapeMd(d.business_name || "Unknown")} — "${escapeMd(d.subject || "(no subject)")}"`, `     /approve ${d.id.slice(0, 8)}`);
        }
      }
      await sendMessage(chatId, `📋 *Outreach Queue*\n\n${lines.join("\n")}`, { parseMode: "Markdown" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await sendMessage(chatId, `❌ Outreach error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── OUTREACH: APPROVE ─────────────────────────

  if (lower.startsWith("/approve ")) {
    const idPrefix = text.slice("/approve ".length).trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/approve draft-id`", { parseMode: "Markdown" });
      return;
    }
    try {
      const { data: drafts, error } = await supabase.from("outreach").select("id, subject, status").eq("status", "draft").order("created_at", { ascending: false }).limit(20);
      if (error) throw new Error(error.message);
      const match = (drafts || []).find((d) => d.id.startsWith(idPrefix));
      if (!match) {
        await sendMessage(chatId, `🔍 No draft found with ID "${escapeMd(idPrefix)}". Check /outreach.`);
        return;
      }
      await approveDraft(match.id);
      await sendMessage(chatId, ["✅ Draft approved.", `Subject: ${escapeMd(match.subject || "(none)")}`, "", `Send it with: /send ${idPrefix}`].join("\n"), { parseMode: "Markdown" });
      await logAction("draft_approved", { draftId: match.id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await sendMessage(chatId, `❌ Approve error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── OUTREACH: REJECT ──────────────────────────

  if (lower.startsWith("/reject ")) {
    const idPrefix = text.slice("/reject ".length).trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/reject draft-id`", { parseMode: "Markdown" });
      return;
    }
    try {
      const { data: drafts, error } = await supabase.from("outreach").select("id, subject, status").in("status", ["draft", "approved"]).order("created_at", { ascending: false }).limit(20);
      if (error) throw new Error(error.message);
      const match = (drafts || []).find((d) => d.id.startsWith(idPrefix));
      if (!match) {
        await sendMessage(chatId, `🔍 No active draft found with ID "${escapeMd(idPrefix)}".`);
        return;
      }
      await rejectDraft(match.id);
      await sendMessage(chatId, `❌ Draft rejected: "${escapeMd(match.subject || "(none)")}".`, { parseMode: "Markdown" });
      await logAction("draft_rejected", { draftId: match.id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await sendMessage(chatId, `❌ Reject error: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── OUTREACH: SEND ────────────────────────────

  if (lower.startsWith("/send ")) {
    const idPrefix = text.slice("/send ".length).trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/send draft-id`", { parseMode: "Markdown" });
      return;
    }
    await sendMessage(chatId, "⏳ Sending email...");
    try {
      const { data: drafts, error } = await supabase.from("outreach").select("id").eq("status", "approved").order("created_at", { ascending: false }).limit(20);
      if (error) throw new Error(error.message);
      const match = (drafts || []).find((d) => d.id.startsWith(idPrefix));
      if (!match) {
        await sendMessage(chatId, `🔍 No approved draft found with ID "${escapeMd(idPrefix)}". Approve it first.`);
        return;
      }
      const result = await sendDraft(match.id);
      await sendMessage(chatId, ["✅ *Email Sent*", "", `To: ${escapeMd(result.recipient)}`, `Subject: ${escapeMd(result.subject)}`, "", "The prospect status has been updated to 'contacted'."].join("\n"), { parseMode: "Markdown" });
      await logAction("email_sent", { draftId: match.id, recipient: result.recipient });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await sendMessage(chatId, `❌ Send failed: ${escapeMd(msg)}`);
    }
    return;
  }

  // ── NATURAL LANGUAGE: AUTO-DETECT PROSPECTS ───

  const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const phonePattern = /(?:\+?234|0)\d{9,10}/;
  const hasEmail = emailPattern.test(text);
  const hasPhone = phonePattern.test(text);

  if (hasEmail || hasPhone) {
    const parts = text.split(/[/|,]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 1) {
      const businessName = parts[0].replace(emailPattern, "").replace(phonePattern, "").trim();
      const email = parts.find((p) => emailPattern.test(p))?.match(emailPattern)?.[0];
      const phone = parts.find((p) => phonePattern.test(p))?.match(phonePattern)?.[0];
      if (businessName.length >= 2) {
        try {
          const prospect = await addProspect({ business_name: businessName, email, phone, source: "telegram_natural" });
          await sendMessage(
            chatId,
            ["✅ *Prospect Added* (auto-detected)", "", `Business: ${escapeMd(prospect.business_name)}`, `Score: ${prospect.score}/100`, `Status: ${escapeMd(prospect.status)}`, email ? `Email: ${escapeMd(email)}` : "", phone ? `Phone: ${escapeMd(phone)}` : "", "", `Next: /draft ${escapeMd(prospect.business_name)}`].filter(Boolean).join("\n"),
            { parseMode: "Markdown" }
          );
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : "unknown";
          await sendMessage(chatId, `⚠️ Auto-detect failed: ${escapeMd(msg)}`);
          return;
        }
      }
    }
  }

  // ── NATURAL LANGUAGE FALLBACK ─────────────────

  await sendMessage(
    chatId,
    ["📝 I received your message:", `"${escapeMd(text.slice(0, 200))}"`, "", "Use /help to see available commands."].join("\n")
  );
  await logAction("unrecognised_command", { text: text.slice(0, 200) });
}

async function handleCallback(callback: Record<string, unknown>): Promise<void> {
  const from = callback.from as Record<string, unknown> | undefined;
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
  await answerCallback(queryId, `Action "${data}" received. Button handlers coming soon.`);
}
