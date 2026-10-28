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

// ── Helpers ────────────────────────────────────────────
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

// ── /start ─────────────────────────────────────────────
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
    "/deploy render|netlify — Deploy",
    "/ci \\[repo\\] — CI status",
    "/devstatus — Dev activity log",
  ];
  await sendMessage(chatId, lines.join("\n"));
}

// ── /status ────────────────────────────────────────────
async function handleStatus(chatId: number) {
  const lines = [
    "🟢 *XTOP Agent Online*",
    "",
    `Uptime: ${escapeMd(process.uptime().toFixed(0))}s`,
    `Node: ${escapeMd(process.version)}`,
    `Env: ${escapeMd(process.env.NODE_ENV || "production")}`,
    "",
    "Use /tasks to see pending work.",
  ];
  await sendMessage(chatId, lines.join("\n"));
}

// ── /tasks ─────────────────────────────────────────────
async function handleTasks(chatId: number) {
  try {
    const tasks = await getPendingTasks();
    if (!tasks.length) {
      await sendMessage(chatId, "✅ No pending tasks.");
      return;
    }
    const lines = tasks.slice(0, 10).map((t: any) =>
      `• ${escapeMd(t.task_type)} — ${escapeMd(t.status)} (retries: ${t.retry_count})`
    );
    await sendMessage(chatId, `📋 *Pending Tasks (${tasks.length})*\n\n${lines.join("\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /discover ──────────────────────────────────────────
async function handleDiscover(chatId: number) {
  await sendMessage(chatId, "🔍 Job discovery triggered. Check /tasks for progress.");
  await supabase.from("tasks").insert({
    task_type: "job_discovery",
    status: "pending",
    payload: { triggered_by: "telegram" },
  });
}

// ── /report ────────────────────────────────────────────
async function handleReport(chatId: number) {
  try {
    const { data: leads, count } = await supabase
      .from("job_leads")
      .select("id", { count: "exact", head: true });

    const { data: tasks } = await supabase
      .from("tasks")
      .select("status")
      .in("status", ["pending", "running"]);

    const lines = [
      "📊 *Daily Report*",
      "",
      `Total leads: ${count || 0}`,
      `Active tasks: ${tasks?.length || 0}`,
      `Uptime: ${process.uptime().toFixed(0)}s`,
    ];
    await sendMessage(chatId, lines.join("\n"));
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /infra ─────────────────────────────────────────────
async function handleInfra(chatId: number) {
  try {
    await sendMessage(chatId, "🔧 Gathering infrastructure report...");
    const report = await getInfraReport();
    await sendMessage(chatId, escapeMd(report));
  } catch (e: any) {
    await sendMessage(chatId, `❌ Infra report failed: ${escapeMd(e.message)}`);
  }
}

// ── /github ────────────────────────────────────────────
async function handleGithub(chatId: number) {
  try {
    const report = await getGithubHealth();
    await sendMessage(chatId, escapeMd(report));
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /render ────────────────────────────────────────────
async function handleRenderCmd(chatId: number) {
  try {
    const report = await getRenderStatus();
    await sendMessage(chatId, escapeMd(report));
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /dbstatus ──────────────────────────────────────────
async function handleDbStatus(chatId: number) {
  try {
    const report = await getDbStats();
    await sendMessage(chatId, escapeMd(report));
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /crm ───────────────────────────────────────────────
async function handleCrm(chatId: number) {
  try {
    const { count: total } = await supabase
      .from("prospects")
      .select("id", { count: "exact", head: true });

    const { data: byStatus } = await supabase
      .from("prospects")
      .select("status");

    const counts: Record<string, number> = {};
    for (const p of byStatus || []) {
      const s = p.status || "unknown";
      counts[s] = (counts[s] || 0) + 1;
    }

    const lines = [
      "📇 *CRM Dashboard*",
      "",
      `Total prospects: ${total || 0}`,
      "",
      "*By Status:*",
      ...Object.entries(counts).map(
        ([s, c]) => `  ${escapeMd(s)}: ${c}`
      ),
      "",
      "Use /addprospect to add new contacts.",
    ];
    await sendMessage(chatId, lines.join("\n"));
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /addprospect ───────────────────────────────────────
async function handleAddProspect(chatId: number, args: string) {
  try {
    if (!args) {
      await sendMessage(
        chatId,
        "Usage: `/addprospect Name | email@example.com | 08012345678 | description`"
      );
      return;
    }
    const parts = args.split("|").map((s) => s.trim());
    if (parts.length < 2) {
      await sendMessage(chatId, "Need at least name and email separated by |");
      return;
    }

    const { data, error } = await supabase
      .from("prospects")
      .insert({
        business_name: parts[0],
        email: parts[1] || null,
        phone: parts[2] || null,
        notes: parts[3] || null,
        status: "new",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    await sendMessage(
      chatId,
      `✅ Prospect added!\nID: \`${escapeMd(data.id)}\`\nName: ${escapeMd(data.business_name)}`
    );
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /prospects ─────────────────────────────────────────
async function handleProspects(chatId: number) {
  try {
    const { data, error } = await supabase
      .from("prospects")
      .select("id, business_name, email, status")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw new Error(error.message);
    if (!data?.length) {
      await sendMessage(chatId, "No prospects yet. Use /addprospect.");
      return;
    }

    const lines = data.map(
      (p: any) =>
        `• *${escapeMd(p.business_name)}*\n  ${escapeMd(p.email || "no email")} | ${escapeMd(p.status)} | \`${escapeMd(p.id.slice(0, 8))}\``
    );
    await sendMessage(chatId, `📇 *Recent Prospects*\n\n${lines.join("\n\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /find ──────────────────────────────────────────────
async function handleFind(chatId: number, args: string) {
  try {
    if (!args) {
      await sendMessage(chatId, "Usage: `/find search term`");
      return;
    }
    const { data, error } = await supabase
      .from("prospects")
      .select("id, business_name, email, status")
      .ilike("business_name", `%${args}%`)
      .limit(10);

    if (error) throw new Error(error.message);
    if (!data?.length) {
      await sendMessage(chatId, `No prospects matching "${escapeMd(args)}".`);
      return;
    }

    const lines = data.map(
      (p: any) =>
        `• *${escapeMd(p.business_name)}* — ${escapeMd(p.status)} \`${escapeMd(p.id.slice(0, 8))}\``
    );
    await sendMessage(chatId, `🔍 *Search Results*\n\n${lines.join("\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /prospect ──────────────────────────────────────────
async function handleProspect(chatId: number, args: string) {
  try {
    const idPrefix = args.trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/prospect <id-prefix>`");
      return;
    }

    const { data, error } = await supabase
      .from("prospects")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);
    const match = data?.find((p: any) => p.id.startsWith(idPrefix));
    if (!match) {
      await sendMessage(chatId, `No prospect found matching \`${escapeMd(idPrefix)}\`.`);
      return;
    }

    const lines = [
      `📇 *${escapeMd(match.business_name)}*`,
      "",
      `*Email:* ${escapeMd(match.email || "N/A")}`,
      `*Phone:* ${escapeMd(match.phone || "N/A")}`,
      `*Status:* ${escapeMd(match.status)}`,
      `*Notes:* ${escapeMd(match.notes || "None")}`,
      `*ID:* \`${escapeMd(match.id)}\``,
    ];
    await sendMessage(chatId, lines.join("\n"));
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /updatestatus ──────────────────────────────────────
async function handleUpdateStatus(chatId: number, args: string) {
  try {
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, "Usage: `/updatestatus <id-prefix> <new-status>`");
      return;
    }
    const idPrefix = parts[0];
    const newStatus = parts.slice(1).join(" ");

    const { data: all } = await supabase
      .from("prospects")
      .select("id, business_name")
      .limit(50);

    const match = all?.find((p: any) => p.id.startsWith(idPrefix));
    if (!match) {
      await sendMessage(chatId, `No prospect found matching \`${escapeMd(idPrefix)}\`.`);
      return;
    }

    const { error } = await supabase
      .from("prospects")
      .update({ status: newStatus })
      .eq("id", match.id);

    if (error) throw new Error(error.message);
    await sendMessage(
      chatId,
      `✅ ${escapeMd(match.business_name)} status → ${escapeMd(newStatus)}`
    );
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /draft ─────────────────────────────────────────────
async function handleDraft(chatId: number, args: string) {
  try {
    const idPrefix = args.trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/draft <prospect-id-prefix>`");
      return;
    }

    // Find prospect (JS filter to avoid UUID LIKE issue)
    const { data: allProspects } = await supabase
      .from("prospects")
      .select("id, business_name, email, notes")
      .order("created_at", { ascending: false })
      .limit(50);

    const prospect = allProspects?.find((p: any) => p.id.startsWith(idPrefix));
    if (!prospect) {
      await sendMessage(chatId, `No prospect found matching \`${escapeMd(idPrefix)}\`.`);
      return;
    }
    if (!prospect.email) {
      await sendMessage(chatId, `⚠️ ${escapeMd(prospect.business_name)} has no email address.`);
      return;
    }

    // Check for existing drafts
    const { data: existing } = await supabase
      .from("outreach")
      .select("id, status")
      .eq("prospect_id", prospect.id)
      .in("status", ["draft", "approved"]);

    if (existing?.length) {
      await sendMessage(
        chatId,
        `⚠️ Draft already exists for this prospect (\`${escapeMd(existing[0].id.slice(0, 8))}\`, status: ${escapeMd(existing[0].status)}).`
      );
      return;
    }

    // Generate draft content
    const subject = `Partnership Opportunity — XTOP Digital Solutions`;
    const body = [
      `Dear ${prospect.business_name} Team,`,
      "",
      `I hope this message finds you well. I'm reaching out from XTOP Digital Solutions to explore how we can help you with a professional website and digital presence.`,
      "",
      `We specialize in building modern, mobile-friendly websites and digital tools for businesses like yours.`,
      "",
      `Would you be open to a brief conversation about how we can support your growth?`,
      "",
      `Best regards,`,
      `XTOP Digital Solutions`,
    ].join("\n");

    const { data: draft, error } = await supabase
      .from("outreach")
      .insert({
        prospect_id: prospect.id,
        subject,
        body,
        status: "draft",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    const lines = [
      `📝 *Draft Created*`,
      "",
      `*To:* ${escapeMd(prospect.email)}`,
      `*Subject:* ${escapeMd(subject)}`,
      `*ID:* \`${escapeMd(draft.id.slice(0, 8))}\``,
      "",
      `Use /approve ${draft.id.slice(0, 8)} to approve, then /send ${draft.id.slice(0, 8)} to send.`,
    ];
    await sendMessage(chatId, lines.join("\n"));
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /outreach ──────────────────────────────────────────
async function handleOutreach(chatId: number) {
  try {
    const { data: drafts, error } = await supabase
      .from("outreach")
      .select("id, prospect_id, subject, status, created_at")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw new Error(error.message);
    if (!drafts?.length) {
      await sendMessage(chatId, "No outreach drafts. Use /draft <prospect-id>.");
      return;
    }

    // Fetch prospect names separately (avoid join issues)
    const prospectIds = [...new Set(drafts.map((d: any) => d.prospect_id))];
    const { data: prospects } = await supabase
      .from("prospects")
      .select("id, business_name")
      .in("id", prospectIds);

    const nameMap = new Map(
      (prospects || []).map((p: any) => [p.id, p.business_name])
    );

    const lines = drafts.map((d: any) => {
      const icon =
        d.status === "sent" ? "✅" : d.status === "approved" ? "👍" : "📝";
      const name = nameMap.get(d.prospect_id) || "Unknown";
      return `${icon} *${escapeMd(name)}* — ${escapeMd(d.status)}\n  \`${escapeMd(d.id.slice(0, 8))}\` | ${escapeMd(d.created_at?.slice(0, 10) || "?")}`;
    });

    await sendMessage(chatId, `📬 *Outreach Drafts*\n\n${lines.join("\n\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /approve ───────────────────────────────────────────
async function handleApprove(chatId: number, args: string) {
  try {
    const idPrefix = args.trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/approve <draft-id-prefix>`");
      return;
    }

    // Fetch recent drafts and filter in JS (UUID LIKE fails in Postgres)
    const { data: drafts, error: fetchErr } = await supabase
      .from("outreach")
      .select("id, status, prospect_id, subject")
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(20);

    if (fetchErr) throw new Error(fetchErr.message);
    const draft = drafts?.find((d: any) => d.id.startsWith(idPrefix));
    if (!draft) {
      await sendMessage(chatId, `No draft found matching \`${escapeMd(idPrefix)}\` with status "draft".`);
      return;
    }

    const { error } = await supabase
      .from("outreach")
      .update({ status: "approved" })
      .eq("id", draft.id);

    if (error) throw new Error(error.message);
    await sendMessage(
      chatId,
      `✅ Draft \`${escapeMd(draft.id.slice(0, 8))}\` approved.\nUse /send ${draft.id.slice(0, 8)} to send it.`
    );
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /reject ────────────────────────────────────────────
async function handleReject(chatId: number, args: string) {
  try {
    const idPrefix = args.trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/reject <draft-id-prefix>`");
      return;
    }

    const { data: drafts, error: fetchErr } = await supabase
      .from("outreach")
      .select("id, status")
      .in("status", ["draft", "approved"])
      .order("created_at", { ascending: false })
      .limit(20);

    if (fetchErr) throw new Error(fetchErr.message);
    const draft = drafts?.find((d: any) => d.id.startsWith(idPrefix));
    if (!draft) {
      await sendMessage(chatId, `No active draft found matching \`${escapeMd(idPrefix)}\`.`);
      return;
    }

    const { error } = await supabase
      .from("outreach")
      .update({ status: "rejected" })
      .eq("id", draft.id);

    if (error) throw new Error(error.message);
    await sendMessage(chatId, `🚫 Draft \`${escapeMd(draft.id.slice(0, 8))}\` rejected.`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /send ──────────────────────────────────────────────
async function handleSend(chatId: number, args: string) {
  try {
    const idPrefix = args.trim();
    if (!idPrefix) {
      await sendMessage(chatId, "Usage: `/send <draft-id-prefix>`");
      return;
    }

    // Step 1: Find the draft
    await sendMessage(chatId, "Step 1/3: Finding draft...");
    const { data: drafts, error: fetchErr } = await supabase
      .from("outreach")
      .select("id, status, prospect_id, subject, body")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(20);

    if (fetchErr) throw new Error(`Fetch error: ${fetchErr.message}`);
    const draft = drafts?.find((d: any) => d.id.startsWith(idPrefix));
    if (!draft) {
      await sendMessage(
        chatId,
        `No approved draft found matching \`${escapeMd(idPrefix)}\`. Use /approve first.`
      );
      return;
    }

    // Step 2: Get prospect email (separate query to avoid join issues)
    await sendMessage(chatId, "Step 2/3: Looking up prospect...");
    const { data: prospect, error: prospectErr } = await supabase
      .from("prospects")
      .select("business_name, email")
      .eq("id", draft.prospect_id)
      .single();

    if (prospectErr) throw new Error(`Prospect lookup failed: ${prospectErr.message}`);
    if (!prospect?.email) {
      await sendMessage(chatId, "⚠️ Prospect has no email address.");
      return;
    }

    // Step 3: Send via Gmail
    await sendMessage(chatId, `Step 3/3: Sending to ${escapeMd(prospect.email)}...`);

    try {
      const { sendEmail } = await import("./outreach-engine.js");
      await sendEmail(draft.id, prospect.email, draft.subject, draft.body);
    } catch (sendErr: any) {
      throw new Error(`Send failed: ${sendErr.message}`);
    }

    await supabase
      .from("outreach")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", draft.id);

    await sendMessage(
      chatId,
      `✅ Email sent to ${escapeMd(prospect.email)}!\nDraft: \`${escapeMd(draft.id.slice(0, 8))}\``
    );
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── Natural Language Prospect Detection ────────────────
async function detectProspect(chatId: number, text: string): Promise<boolean> {
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phoneMatch = text.match(/(?:\+?234|0)\d{9,10}/);

  if (!emailMatch && !phoneMatch) return false;

  const lines = text.split("\n").filter((l) => l.trim());
  const name = lines[0]?.trim() || "Unknown";

  const { data, error } = await supabase
    .from("prospects")
    .insert({
      business_name: name.slice(0, 100),
      email: emailMatch?.[0] || null,
      phone: phoneMatch?.[0] || null,
      notes: text.slice(0, 500),
      status: "new",
    })
    .select()
    .single();

  if (error) return false;

  await sendMessage(
    chatId,
    `📇 Auto-detected prospect!\n*${escapeMd(data.business_name)}* saved.\nID: \`${escapeMd(data.id.slice(0, 8))}\``
  );
  return true;
}

// ── Main Router ────────────────────────────────────────
export async function handleMessage(
  chatId: number,
  text: string,
  from?: { id?: number; first_name?: string }
) {
  const { cmd, args } = parseCmd(text);

  // ── Operations ──
  if (cmd === "/start" || cmd === "/help") return handleStart(chatId);
  if (cmd === "/status") return handleStatus(chatId);
  if (cmd === "/tasks") return handleTasks(chatId);
  if (cmd === "/discover") return handleDiscover(chatId);
  if (cmd === "/report") return handleReport(chatId);

  // ── Infrastructure ──
  if (cmd === "/infra") return handleInfra(chatId);
  if (cmd === "/github") return handleGithub(chatId);
  if (cmd === "/render") return handleRenderCmd(chatId);
  if (cmd === "/dbstatus") return handleDbStatus(chatId);

  // ── CRM ──
  if (cmd === "/crm") return handleCrm(chatId);
  if (cmd === "/addprospect") return handleAddProspect(chatId, args);
  if (cmd === "/prospects") return handleProspects(chatId);
  if (cmd === "/find") return handleFind(chatId, args);
  if (cmd === "/prospect") return handleProspect(chatId, args);
  if (cmd === "/updatestatus") return handleUpdateStatus(chatId, args);

  // ── Outreach ──
  if (cmd === "/draft") return handleDraft(chatId, args);
  if (cmd === "/outreach") return handleOutreach(chatId);
  if (cmd === "/approve") return handleApprove(chatId, args);
  if (cmd === "/reject") return handleReject(chatId, args);
  if (cmd === "/send") return handleSend(chatId, args);

  // ── Dev Agent ──
  const devCmds = [
    "/repos",
    "/browse",
    "/readfile",
    "/analyze",
    "/fix",
    "/deploy",
    "/ci",
    "/devstatus",
  ];
  if (devCmds.includes(cmd)) {
    await handleDevCommand(chatId, cmd, args, text);
    return;
  }

  // ── Natural Language ──
  const detected = await detectProspect(chatId, text);
  if (!detected) {
    await sendMessage(
      chatId,
      "🤔 I didn't recognize that command. Send /start to see what I can do."
    );
  }
}
