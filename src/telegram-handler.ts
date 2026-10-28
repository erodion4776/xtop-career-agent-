import { sendMessage } from "./telegram.js";
import { supabase } from "./supabase.js";
import { getPendingTasks } from "./task-engine.js";
import {
  getInfraReport,
  getGithubHealth,
  getRenderStatus,
  getDbStats,
} from "./infra-monitor.js";
import { handleDevCommand } from "./dev-commands.js";

function escapeMd(s: string): string {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function parseCmd(text: string): { cmd: string; args: string } {
  const trimmed = text.trim();
  const space = trimmed.indexOf(" ");
  if (space === -1) return { cmd: trimmed.toLowerCase(), args: "" };
  return {
    cmd: trimmed.slice(0, space).toLowerCase(),
    args: trimmed.slice(space + 1).trim(),
  };
}

async function handleStart(chatId: number) {
  const lines = [
    "🤖 *XTOP Career Agent*",
    "",
    "*Operations:*",
    "/status — System health",
    "/tasks — Pending task queue",
    "/discover — Run job discovery",
    "/report — Daily summary",
    "",
    "*Infrastructure:*",
    "/infra — Full infra report",
    "/github — GitHub repo health",
    "/render — Render service status",
    "/dbstatus — Database stats",
    "",
    "*CRM:*",
    "/crm — CRM dashboard",
    "/addprospect — Add a prospect",
    "/prospects — List all prospects",
    "/find <query> — Search prospects",
    "/prospect <id> — View prospect",
    "/updatestatus <id> <status> — Update",
    "",
    "*Outreach:*",
    "/draft <prospect\\_id> — Create draft",
    "/outreach — List drafts",
    "/approve <id> — Approve draft",
    "/reject <id> — Reject draft",
    "/send <id> — Send approved draft",
    "",
    "*Dev Agent:*",
    "/repos — List GitHub repos",
    "/browse <repo> \\[path\\] — Browse files",
    "/readfile <repo> <path> — Read a file",
    "/analyze <repo> <problem> — AI diagnosis",
    "/fix <repo> <problem> — Auto fix + PR",
    "/watch <repo> — Check CI + auto-fix",
    "/newsite <name> <type> — Create website",
    "/netlify — List all Netlify sites",
    "/deploy render|netlify <site> — Deploy",
    "/ci \\[repo\\] — CI status",
    "/devstatus — Dev activity log",
    "",
    "👇 *Or use the buttons below:*",
  ];

  const buttons = [
    [
      { text: "📦 GitHub", callback_data: "gr:0" },
      { text: "🌐 Netlify", callback_data: "nl:0" },
    ],
    [
      { text: "📇 CRM", callback_data: "cr:0" },
      { text: "📬 Outreach", callback_data: "ol:0" },
    ],
    [
      { text: "🌐 New Site", callback_data: "ns:start" },
      { text: "🚀 Deploy", callback_data: "dp:menu" },
    ],
    [
      { text: "🔧 Infra", callback_data: "m:infra" },
      { text: "📋 Tasks", callback_data: "m:tasks" },
    ],
  ];

  await sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons });
}

async function handleStatus(chatId: number) {
  await sendMessage(chatId, `🟢 *XTOP Agent Online*\n\nUptime: ${escapeMd(process.uptime().toFixed(0))}s\nNode: ${escapeMd(process.version)}`);
}

async function handleTasks(chatId: number) {
  try {
    const tasks = await getPendingTasks();
    if (!tasks.length) { await sendMessage(chatId, "✅ No pending tasks."); return; }
    const lines = tasks.slice(0, 10).map((t: any) => `• ${escapeMd(t.task_type)} — ${escapeMd(t.status)}`);
    await sendMessage(chatId, `📋 *Pending Tasks (${tasks.length})*\n\n${lines.join("\n")}`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleDiscover(chatId: number) {
  await sendMessage(chatId, "🔍 Job discovery triggered.");
  await supabase.from("tasks").insert({ task_type: "job_discovery", status: "pending", payload: { triggered_by: "telegram" } });
}

async function handleReport(chatId: number) {
  try {
    const { count } = await supabase.from("job_leads").select("id", { count: "exact", head: true });
    const { data: tasks } = await supabase.from("tasks").select("status").in("status", ["pending", "running"]);
    await sendMessage(chatId, `📊 *Report*\n\nLeads: ${count || 0}\nActive tasks: ${tasks?.length || 0}`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleInfra(chatId: number) {
  try {
    await sendMessage(chatId, "🔧 Gathering report...");
    await sendMessage(chatId, escapeMd(await getInfraReport()));
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleGithubCmd(chatId: number) {
  try { await sendMessage(chatId, escapeMd(await getGithubHealth())); } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleRenderCmd(chatId: number) {
  try { await sendMessage(chatId, escapeMd(await getRenderStatus())); } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleDbStatus(chatId: number) {
  try { await sendMessage(chatId, escapeMd(await getDbStats())); } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleCrm(chatId: number) {
  try {
    const { count: total } = await supabase.from("prospects").select("id", { count: "exact", head: true });
    const { data: byStatus } = await supabase.from("prospects").select("status");
    const counts: Record<string, number> = {};
    for (const p of byStatus || []) { const s = (p as any).status || "unknown"; counts[s] = (counts[s] || 0) + 1; }
    const lines = ["📇 *CRM Dashboard*", "", `Total: ${total || 0}`, "", ...Object.entries(counts).map(([s, c]) => `  ${escapeMd(s)}: ${c}`)];
    await sendMessage(chatId, lines.join("\n"));
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleAddProspect(chatId: number, args: string) {
  try {
    if (!args) { await sendMessage(chatId, "Usage: `/addprospect Name | email | phone | notes`"); return; }
    const parts = args.split("|").map((s) => s.trim());
    if (parts.length < 2) { await sendMessage(chatId, "Need at least name and email separated by |"); return; }
    const { data, error } = await supabase.from("prospects").insert({
      business_name: parts[0], email: parts[1] || null, phone: parts[2] || null, notes: parts[3] || null, status: "new",
    }).select().single();
    if (error) throw new Error(error.message);
    await sendMessage(chatId, `✅ Prospect added!\nID: \`${escapeMd((data as any).id)}\``);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleProspects(chatId: number) {
  try {
    const { data, error } = await supabase.from("prospects").select("id, business_name, email, status").order("created_at", { ascending: false }).limit(10);
    if (error) throw new Error(error.message);
    if (!data?.length) { await sendMessage(chatId, "No prospects yet."); return; }
    const lines = (data as any[]).map((p) => `• *${escapeMd(p.business_name)}* | ${escapeMd(p.status)} | \`${escapeMd(p.id.slice(0, 8))}\``);
    await sendMessage(chatId, `📇 *Prospects*\n\n${lines.join("\n")}`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleFind(chatId: number, args: string) {
  try {
    if (!args) { await sendMessage(chatId, "Usage: `/find search term`"); return; }
    const { data } = await supabase.from("prospects").select("id, business_name, status").ilike("business_name", `%${args}%`).limit(10);
    if (!(data as any[])?.length) { await sendMessage(chatId, `No results for "${escapeMd(args)}".`); return; }
    const lines = (data as any[]).map((p) => `• ${escapeMd(p.business_name)} — ${escapeMd(p.status)}`);
    await sendMessage(chatId, `🔍 *Results*\n\n${lines.join("\n")}`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleProspect(chatId: number, args: string) {
  try {
    if (!args) { await sendMessage(chatId, "Usage: `/prospect <id-prefix>`"); return; }
    const { data } = await supabase.from("prospects").select("*").order("created_at", { ascending: false }).limit(50);
    const match = (data as any[])?.find((p) => p.id.startsWith(args));
    if (!match) { await sendMessage(chatId, "Not found."); return; }
    await sendMessage(chatId, `📇 *${escapeMd(match.business_name)}*\n\nEmail: ${escapeMd(match.email || "N/A")}\nPhone: ${escapeMd(match.phone || "N/A")}\nStatus: ${escapeMd(match.status)}\nNotes: ${escapeMd(match.notes || "None")}`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleUpdateStatus(chatId: number, args: string) {
  try {
    const parts = args.split(/\s+/);
    if (parts.length < 2) { await sendMessage(chatId, "Usage: `/updatestatus <id> <status>`"); return; }
    const { data: all } = await supabase.from("prospects").select("id, business_name").limit(50);
    const match = (all as any[])?.find((p) => p.id.startsWith(parts[0]));
    if (!match) { await sendMessage(chatId, "Not found."); return; }
    const newStatus = parts.slice(1).join(" ");
    await supabase.from("prospects").update({ status: newStatus }).eq("id", match.id);
    await sendMessage(chatId, `✅ ${escapeMd(match.business_name)} → ${escapeMd(newStatus)}`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleDraft(chatId: number, args: string) {
  try {
    if (!args) { await sendMessage(chatId, "Usage: `/draft <prospect-id-prefix>`"); return; }
    const { data: all } = await supabase.from("prospects").select("id, business_name, email").order("created_at", { ascending: false }).limit(50);
    const prospect = (all as any[])?.find((p) => p.id.startsWith(args));
    if (!prospect) { await sendMessage(chatId, "Prospect not found."); return; }
    if (!prospect.email) { await sendMessage(chatId, "⚠️ No email address."); return; }
    const { data: existing } = await supabase.from("outreach").select("id").eq("prospect_id", prospect.id).in("status", ["draft", "approved"]);
    if ((existing as any[])?.length) { await sendMessage(chatId, "⚠️ Draft already exists."); return; }
    const subject = "Partnership Opportunity — XTOP Digital Solutions";
    const body = `Dear ${prospect.business_name} Team,\n\nI hope this message finds you well. I'm reaching out from XTOP Digital Solutions to explore how we can help you with a professional website.\n\nBest regards,\nXTOP Digital Solutions`;
    const { data: draft, error } = await supabase.from("outreach").insert({ prospect_id: prospect.id, subject, body, status: "draft" }).select().single();
    if (error) throw new Error(error.message);
    await sendMessage(chatId, `📝 Draft created!\nID: \`${escapeMd((draft as any).id.slice(0, 8))}\`\nUse /approve then /send.`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleOutreach(chatId: number) {
  try {
    const { data: drafts } = await supabase.from("outreach").select("id, prospect_id, status, created_at").order("created_at", { ascending: false }).limit(10);
    if (!(drafts as any[])?.length) { await sendMessage(chatId, "No drafts."); return; }
    const ids = [...new Set((drafts as any[]).map((d) => d.prospect_id))];
    const { data: prospects } = await supabase.from("prospects").select("id, business_name").in("id", ids);
    const nm = new Map(((prospects as any[]) || []).map((p) => [p.id, p.business_name]));
    const lines = (drafts as any[]).map((d) => {
      const icon = d.status === "sent" ? "✅" : d.status === "approved" ? "👍" : "📝";
      return `${icon} ${escapeMd(nm.get(d.prospect_id) || "?")} — ${escapeMd(d.status)} \`${d.id.slice(0, 8)}\``;
    });
    await sendMessage(chatId, `📬 *Outreach*\n\n${lines.join("\n")}`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleApprove(chatId: number, args: string) {
  try {
    if (!args) { await sendMessage(chatId, "Usage: `/approve <id>`"); return; }
    const { data: drafts } = await supabase.from("outreach").select("id").eq("status", "draft").limit(20);
    const draft = (drafts as any[])?.find((d) => d.id.startsWith(args));
    if (!draft) { await sendMessage(chatId, "No draft found."); return; }
    await supabase.from("outreach").update({ status: "approved" }).eq("id", draft.id);
    await sendMessage(chatId, `✅ Approved. Use /send ${args} to send.`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleReject(chatId: number, args: string) {
  try {
    if (!args) { await sendMessage(chatId, "Usage: `/reject <id>`"); return; }
    const { data: drafts } = await supabase.from("outreach").select("id").in("status", ["draft", "approved"]).limit(20);
    const draft = (drafts as any[])?.find((d) => d.id.startsWith(args));
    if (!draft) { await sendMessage(chatId, "Not found."); return; }
    await supabase.from("outreach").update({ status: "rejected" }).eq("id", draft.id);
    await sendMessage(chatId, `🚫 Rejected.`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function handleSend(chatId: number, args: string) {
  try {
    if (!args) { await sendMessage(chatId, "Usage: `/send <id>`"); return; }
    const { data: drafts } = await supabase.from("outreach").select("id, prospect_id, subject, body").eq("status", "approved").limit(20);
    const draft = (drafts as any[])?.find((d) => d.id.startsWith(args));
    if (!draft) { await sendMessage(chatId, "No approved draft found."); return; }
    const { data: p } = await supabase.from("prospects").select("email").eq("id", draft.prospect_id).single();
    if (!(p as any)?.email) { await sendMessage(chatId, "⚠️ No email."); return; }
    let sent = false;
    try { const o = await import("./outreach-engine.js") as any; const fn = o.sendEmail || o.sendDraft || o.send; if (fn) { await fn(draft.id, (p as any).email, draft.subject, draft.body); sent = true; } } catch {}
    if (!sent) { try { const g = await import("./gmail.js") as any; const fn = g.sendEmail || g.sendMail || g.send; if (fn) { await fn((p as any).email, draft.subject, draft.body); sent = true; } } catch {} }
    if (!sent) { await sendMessage(chatId, "⚠️ No email send function available."); return; }
    await supabase.from("outreach").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", draft.id);
    await sendMessage(chatId, `✅ Sent to ${escapeMd((p as any).email)}!`);
  } catch (e: any) { await sendMessage(chatId, `❌ ${escapeMd(e.message)}`); }
}

async function detectProspect(chatId: number, text: string): Promise<boolean> {
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phoneMatch = text.match(/(?:\+?234|0)\d{9,10}/);
  if (!emailMatch && !phoneMatch) return false;
  const name = text.split("\n")[0]?.trim() || "Unknown";
  const { data, error } = await supabase.from("prospects").insert({
    business_name: name.slice(0, 100), email: emailMatch?.[0] || null, phone: phoneMatch?.[0] || null, notes: text.slice(0, 500), status: "new",
  }).select().single();
  if (error) return false;
  await sendMessage(chatId, `📇 Auto-detected: *${escapeMd((data as any).business_name)}* saved.`);
  return true;
}

export async function handleUpdate(update: any) {
  const message = update?.message;
  if (!message?.text) return;
  const chatId: number = message.chat?.id;
  const text: string = message.text;
  const from = message.from;
  if (!chatId || !text) return;

  // Session-aware text input
  if (from?.id && !text.startsWith("/")) {
    try {
      const { getSession, clearSession } = await import("./session-store.js");
      const session = await getSession(chatId, from.id);
      if (session) {
        if (session.workflow === "analyze" && session.state?.repo) {
          await clearSession(chatId, from.id);
          await handleDevCommand(chatId, "/analyze", `${session.state.repo} ${text}`, text);
          return;
        }
        if (session.workflow === "fix" && session.state?.repo) {
          await clearSession(chatId, from.id);
          await handleDevCommand(chatId, "/fix", `${session.state.repo} ${text}`, text);
          return;
        }
        if (session.workflow === "newsite" && session.state?.step) {
          await clearSession(chatId, from.id);
          const s = session.state;
          if (s.step === "description") {
            await handleDevCommand(chatId, "/newsite", `${s.name} ${s.type} ${text}`, text);
            return;
          }
        }
      }
    } catch {}
  }

  const { cmd, args } = parseCmd(text);

  if (cmd === "/start" || cmd === "/help") return handleStart(chatId);
  if (cmd === "/status") return handleStatus(chatId);
  if (cmd === "/tasks") return handleTasks(chatId);
  if (cmd === "/discover") return handleDiscover(chatId);
  if (cmd === "/report") return handleReport(chatId);
  if (cmd === "/infra") return handleInfra(chatId);
  if (cmd === "/github") return handleGithubCmd(chatId);
  if (cmd === "/render") return handleRenderCmd(chatId);
  if (cmd === "/dbstatus") return handleDbStatus(chatId);
  if (cmd === "/crm") return handleCrm(chatId);
  if (cmd === "/addprospect") return handleAddProspect(chatId, args);
  if (cmd === "/prospects") return handleProspects(chatId);
  if (cmd === "/find") return handleFind(chatId, args);
  if (cmd === "/prospect") return handleProspect(chatId, args);
  if (cmd === "/updatestatus") return handleUpdateStatus(chatId, args);
  if (cmd === "/draft") return handleDraft(chatId, args);
  if (cmd === "/outreach") return handleOutreach(chatId);
  if (cmd === "/approve") return handleApprove(chatId, args);
  if (cmd === "/reject") return handleReject(chatId, args);
  if (cmd === "/send") return handleSend(chatId, args);

  const devCmds = ["/repos", "/browse", "/readfile", "/analyze", "/fix", "/watch", "/newsite", "/netlify", "/deploy", "/ci", "/devstatus"];
  if (devCmds.includes(cmd)) { await handleDevCommand(chatId, cmd, args, text); return; }

  const detected = await detectProspect(chatId, text);
  if (!detected) {
    await sendMessage(chatId, "🤔 I didn't recognize that. Send /start to see commands.");
  }
}
