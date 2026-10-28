import { supabase } from "./supabase.js";
import { sendMessage } from "./telegram.js";
import * as ui from "./ui-engine.js";
import * as gh from "./github-client.js";
import * as nf from "./netlify-client.js";
import { getSession, setSession, clearSession } from "./session-store.js";

const e = ui.esc;

// ── Main entry point ───────────────────────────────────
export async function handleCallback(update: any) {
  const cq = update.callback_query;
  if (!cq?.data) return;

  const queryId: string = cq.id;
  const chatId: number = cq.message?.chat?.id;
  const messageId: number = cq.message?.message_id;
  const userId: number = cq.from?.id;
  const data: string = cq.data;

  if (!chatId || !userId) return;
  await ui.ackCallback(queryId);

  // No-op buttons (page indicators)
  if (data.startsWith("noop:")) return;

  try {
    const [prefix, ...rest] = data.split(":");
    const param = rest.join(":");

    switch (prefix) {
      case "m": return handleMainMenu(chatId, messageId, param);
      case "gr": return handleGithubRepos(chatId, messageId, param);
      case "ga": return handleGithubActions(chatId, messageId, param);
      case "gb": return handleGithubBrowse(chatId, messageId, param);
      case "gf": return handleGithubFile(chatId, messageId, param);
      case "gi": return handleGithubIssues(chatId, messageId, param);
      case "gc": return handleGithubCommits(chatId, messageId, param);
      case "gp": return handleGithubPRs(chatId, messageId, param);
      case "nl": return handleNetlifyList(chatId, messageId, param);
      case "nd": return handleNetlifyDeploy(chatId, messageId, param);
      case "cr": return handleCrmList(chatId, messageId, param);
      case "ca": return handleCrmActions(chatId, messageId, param);
      case "ol": return handleOutreachList(chatId, messageId, param);
      case "dp": return handleDeploy(chatId, messageId, param);
      case "cf": return handleConfirm(chatId, messageId, userId, param);
      case "ip": return handleInputPrompt(chatId, messageId, userId, param);
      default:
        await ui.editMenu(chatId, messageId, "Unknown action.", [[ui.btn("🏠 Home", "m:main")]]);
    }
  } catch (err: any) {
    await ui.editMenu(
      chatId, messageId,
      `❌ ${e(err.message?.slice(0, 100) || "Error")}`,
      [[ui.btn("🏠 Home", "m:main")]]
    );
  }
}

// ── Main Menu ──────────────────────────────────────────
async function handleMainMenu(chatId: number, msgId: number, action: string) {
  if (action === "main" || !action) {
    const text = "🤖 *XTOP Agent — Main Menu*\n\nSelect a category:";
    const buttons: ui.Btn[][] = [
      [ui.btn("📦 GitHub", "gr:0"), ui.btn("🌐 Netlify", "nl:0")],
      [ui.btn("📇 CRM", "cr:0"), ui.btn("📬 Outreach", "ol:0")],
      [ui.btn("🔧 Infra", "m:infra"), ui.btn("🚀 Deploy", "dp:menu")],
      [ui.btn("📊 Report", "m:report"), ui.btn("📋 Tasks", "m:tasks")],
    ];
    await ui.editMenu(chatId, msgId, text, buttons);
    return;
  }

  if (action === "infra") {
    const { getInfraReport } = await import("./infra-monitor.js");
    const report = await getInfraReport();
    await ui.editMenu(chatId, msgId, e(report), [ui.navRow("m:main")]);
    return;
  }

  if (action === "report") {
    const { count } = await supabase.from("job_leads").select("id", { count: "exact", head: true });
    const { data: tasks } = await supabase.from("tasks").select("status").in("status", ["pending", "running"]);
    const text = `📊 *Report*\n\nLeads: ${count || 0}\nActive tasks: ${tasks?.length || 0}`;
    await ui.editMenu(chatId, msgId, text, [ui.navRow("m:main")]);
    return;
  }

  if (action === "tasks") {
    const { getPendingTasks } = await import("./task-engine.js");
    const tasks = await getPendingTasks();
    if (!tasks.length) {
      await ui.editMenu(chatId, msgId, "✅ No pending tasks.", [ui.navRow("m:main")]);
      return;
    }
    const lines = tasks.slice(0, 8).map((t: any) => `• ${e(t.task_type)} — ${e(t.status)}`);
    await ui.editMenu(chatId, msgId, `📋 *Tasks*\n\n${lines.join("\n")}`, [ui.navRow("m:main")]);
  }
}

// ── GitHub Repos ───────────────────────────────────────
async function handleGithubRepos(chatId: number, msgId: number, param: string) {
  const page = parseInt(param, 10) || 0;
  const repos = await gh.listRepos(10);
  if (!repos.length) {
    await ui.editMenu(chatId, msgId, "No repos found.", [ui.navRow("m:main")]);
    return;
  }

  const { text, buttons } = ui.paginateList(
    repos, page, 5,
    (r: any) => `${r.full_name} (${r.private ? "🔒" : "🌐"})`,
    "ga"
  );
  await ui.editMenu(chatId, msgId, `📦 *GitHub Repos*\n\n${text}`, buttons);
}

// ── GitHub Repo Actions ────────────────────────────────
async function handleGithubActions(chatId: number, msgId: number, param: string) {
  const idx = parseInt(param, 10);
  const repos = await gh.listRepos(10);
  const repo = repos[idx];
  if (!repo) {
    await ui.editMenu(chatId, msgId, "Repo not found.", [ui.navRow("gr:0")]);
    return;
  }

  const name = repo.full_name;
  const text = `📦 *${e(name)}*\n\n${e(repo.description || "No description")}\n⭐ ${repo.stargazers_count} | ${e(repo.language || "?")} | ${repo.private ? "🔒 Private" : "🌐 Public"}`;
  const buttons: ui.Btn[][] = [
    [ui.btn("📂 Browse Files", `gb:${name}:`), ui.btn("📄 Issues", `gi:${name}:0`)],
    [ui.btn("🔀 PRs", `gp:${name}:0`), ui.btn("📝 Commits", `gc:${name}:0`)],
    [ui.btn("🔍 Analyze", `ip:analyze:${name}`), ui.btn("🔧 Fix", `ip:fix:${name}`)],
    ui.navRow("gr:0"),
  ];
  await ui.editMenu(chatId, msgId, text, buttons);
}

// ── GitHub Browse Files ────────────────────────────────
async function handleGithubBrowse(chatId: number, msgId: number, param: string) {
  // param format: owner/repo:path/to/dir
  const colonIdx = param.indexOf(":");
  const repoName = colonIdx > 0 ? param.slice(0, colonIdx) : param;
  const path = colonIdx > 0 ? param.slice(colonIdx + 1) : "";

  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) {
    await ui.editMenu(chatId, msgId, "Invalid repo.", [ui.navRow("gr:0")]);
    return;
  }

  const contents = await gh.getContents(owner, repo, path);
  const items = Array.isArray(contents) ? contents : [contents];

  const dirs = items.filter((i: any) => i.type === "dir");
  const files = items.filter((i: any) => i.type === "file");
  const sorted = [...dirs, ...files];

  if (!sorted.length) {
    await ui.editMenu(chatId, msgId, `📂 Empty: ${e(path || "/")}`, [ui.navRow(`ga:0`)]);
    return;
  }

  const lines = sorted.slice(0, 10).map((item: any) => {
    const icon = item.type === "dir" ? "📁" : "📄";
    return `${icon} ${e(item.name)}`;
  });

  const buttons: ui.Btn[][] = [];
  for (let i = 0; i < Math.min(sorted.length, 10); i += 2) {
    const row: ui.Btn[] = [];
    const item1 = sorted[i];
    const p1 = path ? `${path}/${item1.name}` : item1.name;
    if (item1.type === "dir") {
      row.push(ui.btn(`📁 ${item1.name.slice(0, 20)}`, `gb:${repoName}:${p1}`));
    } else {
      row.push(ui.btn(`📄 ${item1.name.slice(0, 20)}`, `gf:${repoName}:${p1}`));
    }
    if (sorted[i + 1]) {
      const item2 = sorted[i + 1];
      const p2 = path ? `${path}/${item2.name}` : item2.name;
      if (item2.type === "dir") {
        row.push(ui.btn(`📁 ${item2.name.slice(0, 20)}`, `gb:${repoName}:${p2}`));
      } else {
        row.push(ui.btn(`📄 ${item2.name.slice(0, 20)}`, `gf:${repoName}:${p2}`));
      }
    }
    buttons.push(row);
  }

  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const backData = path ? `gb:${repoName}:${parentPath}` : `ga:0`;
  buttons.push(ui.navRow(backData, "gr:0"));

  const header = path ? `${repoName}/${path}` : repoName;
  await ui.editMenu(chatId, msgId, `📂 *${e(header)}*\n\n${lines.join("\n")}`, buttons);
}

// ── GitHub File View ───────────────────────────────────
async function handleGithubFile(chatId: number, msgId: number, param: string) {
  const colonIdx = param.indexOf(":");
  const repoName = colonIdx > 0 ? param.slice(0, colonIdx) : param;
  const filePath = colonIdx > 0 ? param.slice(colonIdx + 1) : "";

  const [owner, repo] = repoName.split("/");
  const file = await gh.getFile(owner, repo, filePath);
  const preview = file.content.length > 2000 ? file.content.slice(0, 2000) + "\n..." : file.content;

  const text = `📄 *${e(filePath)}* (${file.size} bytes)\n\`\`\`\n${preview}\n\`\`\``;
  const parentPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const buttons = [ui.navRow(`gb:${repoName}:${parentPath}`, "gr:0")];
  await ui.editMenu(chatId, msgId, text, buttons);
}

// ── GitHub Issues ──────────────────────────────────────
async function handleGithubIssues(chatId: number, msgId: number, param: string) {
  const parts = param.split(":");
  const repoName = `${parts[0]}/${parts[1]}`;
  const [owner, repo] = repoName.split("/");
  const issues = await gh.getIssues(owner, repo);

  if (!issues.length) {
    await ui.editMenu(chatId, msgId, `No open issues for ${e(repoName)}.`, [ui.navRow(`ga:0`)]);
    return;
  }

  const lines = issues.slice(0, 8).map((i: any) =>
    `#${i.number} ${e(i.title.slice(0, 40))} — ${e(i.state)}`
  );
  await ui.editMenu(
    chatId, msgId,
    `📄 *Issues: ${e(repoName)}*\n\n${lines.join("\n")}`,
    [ui.navRow(`ga:0`)]
  );
}

// ── GitHub Commits ─────────────────────────────────────
async function handleGithubCommits(chatId: number, msgId: number, param: string) {
  const parts = param.split(":");
  const repoName = `${parts[0]}/${parts[1]}`;
  const [owner, repo] = repoName.split("/");
  const commits = await gh.getCommits(owner, repo, "main", 8);

  const lines = commits.map((c: any) =>
    `\`${c.sha.slice(0, 7)}\` ${e(c.commit.message.split("\n")[0].slice(0, 40))}`
  );
  await ui.editMenu(
    chatId, msgId,
    `📝 *Commits: ${e(repoName)}*\n\n${lines.join("\n")}`,
    [ui.navRow(`ga:0`)]
  );
}

// ── GitHub PRs ─────────────────────────────────────────
async function handleGithubPRs(chatId: number, msgId: number, param: string) {
  const parts = param.split(":");
  const repoName = `${parts[0]}/${parts[1]}`;
  const [owner, repo] = repoName.split("/");
  const prs = await gh.getPRs(owner, repo);

  if (!prs.length) {
    await ui.editMenu(chatId, msgId, `No open PRs for ${e(repoName)}.`, [ui.navRow(`ga:0`)]);
    return;
  }

  const lines = prs.slice(0, 8).map((p: any) =>
    `#${p.number} ${e(p.title.slice(0, 40))} — ${e(p.state)}`
  );
  await ui.editMenu(
    chatId, msgId,
    `🔀 *PRs: ${e(repoName)}*\n\n${lines.join("\n")}`,
    [ui.navRow(`ga:0`)]
  );
}

// ── Netlify Sites ──────────────────────────────────────
async function handleNetlifyList(chatId: number, msgId: number, param: string) {
  if (!nf.isConfigured()) {
    await ui.editMenu(chatId, msgId, "❌ NETLIFY\\_AUTH\\_TOKEN not set.", [ui.navRow("m:main")]);
    return;
  }

  const sites = await nf.listSites();
  if (!sites.length) {
    await ui.editMenu(chatId, msgId, "No Netlify sites found.", [ui.navRow("m:main")]);
    return;
  }

  const lines = sites.map((s: any, i: number) => {
    const status = s.published_deploy?.state || "unknown";
    const icon = status === "ready" ? "✅" : "❌";
    return `${icon} ${i + 1}. ${e(s.name || "unnamed")}\n  ${e(s.ssl_url || s.url || "")}`;
  });

  const buttons: ui.Btn[][] = sites.slice(0, 6).map((s: any, i: number) => [
    ui.btn(`🚀 Deploy ${s.name?.slice(0, 15) || i + 1}`, `nd:${s.id.slice(0, 20)}`),
  ]);
  buttons.push(ui.navRow("m:main"));

  await ui.editMenu(chatId, msgId, `🌐 *Netlify Sites*\n\n${lines.join("\n\n")}`, buttons);
}

// ── Netlify Deploy ─────────────────────────────────────
async function handleNetlifyDeploy(chatId: number, msgId: number, siteIdPrefix: string) {
  const sites = await nf.listSites();
  const site = sites.find((s: any) => s.id.startsWith(siteIdPrefix));
  if (!site) {
    await ui.editMenu(chatId, msgId, "Site not found.", [ui.navRow("nl:0")]);
    return;
  }

  await ui.editMenu(
    chatId, msgId,
    `🚀 Deploy *${e(site.name)}*?\n\nThis will trigger a new build.`,
    [
      [ui.btn("✅ Deploy Now", `cf:ndeploy:${site.id.slice(0, 20)}`), ui.btn("❌ Cancel", "nl:0")],
    ]
  );
}

// ── CRM Prospects ──────────────────────────────────────
async function handleCrmList(chatId: number, msgId: number, param: string) {
  const page = parseInt(param, 10) || 0;
  const { data } = await supabase
    .from("prospects")
    .select("id, business_name, email, status")
    .order("created_at", { ascending: false })
    .limit(20);

  const prospects = data as any[] || [];
  if (!prospects.length) {
    await ui.editMenu(chatId, msgId, "No prospects. Use /addprospect.", [ui.navRow("m:main")]);
    return;
  }

  const { text, buttons } = ui.paginateList(
    prospects, page, 5,
    (p: any) => `${p.business_name} (${p.status})`,
    "ca"
  );
  await ui.editMenu(chatId, msgId, `📇 *Prospects*\n\n${text}`, buttons);
}

// ── CRM Prospect Actions ───────────────────────────────
async function handleCrmActions(chatId: number, msgId: number, param: string) {
  const idx = parseInt(param, 10);
  const { data } = await supabase
    .from("prospects")
    .select("id, business_name, email, phone, status, notes")
    .order("created_at", { ascending: false })
    .limit(20);

  const prospect = (data as any[])?.[idx];
  if (!prospect) {
    await ui.editMenu(chatId, msgId, "Prospect not found.", [ui.navRow("cr:0")]);
    return;
  }

  const text = [
    `📇 *${e(prospect.business_name)}*`,
    ``,
    `*Email:* ${e(prospect.email || "N/A")}`,
    `*Phone:* ${e(prospect.phone || "N/A")}`,
    `*Status:* ${e(prospect.status)}`,
    `*Notes:* ${e(prospect.notes || "None")}`,
  ].join("\n");

  const buttons: ui.Btn[][] = [
    [ui.btn("📝 Draft Email", `ip:draft:${prospect.id.slice(0, 8)}`)],
    [
      ui.btn("✅ Active", `ca:status:${prospect.id.slice(0, 8)}:active`),
      ui.btn("❄️ Cold", `ca:status:${prospect.id.slice(0, 8)}:cold`),
    ],
    ui.navRow("cr:0"),
  ];
  await ui.editMenu(chatId, msgId, text, buttons);
}

// ── Outreach List ──────────────────────────────────────
async function handleOutreachList(chatId: number, msgId: number, param: string) {
  const { data: drafts } = await supabase
    .from("outreach")
    .select("id, prospect_id, subject, status, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (!(drafts as any[])?.length) {
    await ui.editMenu(chatId, msgId, "No drafts. Use /draft.", [ui.navRow("m:main")]);
    return;
  }

  const prospectIds = [...new Set((drafts as any[]).map((d) => d.prospect_id))];
  const { data: prospects } = await supabase.from("prospects").select("id, business_name").in("id", prospectIds);
  const nameMap = new Map(((prospects as any[]) || []).map((p) => [p.id, p.business_name]));

  const lines = (drafts as any[]).map((d) => {
    const icon = d.status === "sent" ? "✅" : d.status === "approved" ? "👍" : "📝";
    const name = nameMap.get(d.prospect_id) || "?";
    return `${icon} ${e(name)} — ${e(d.status)} \`${d.id.slice(0, 8)}\``;
  });

  const buttons: ui.Btn[][] = (drafts as any[]).slice(0, 5).map((d) => {
    const row: ui.Btn[] = [];
    if (d.status === "draft") row.push(ui.btn("✅ Approve", `cf:approve:${d.id.slice(0, 8)}`));
    if (d.status === "approved") row.push(ui.btn("📤 Send", `cf:send:${d.id.slice(0, 8)}`));
    row.push(ui.btn("🚫 Reject", `cf:reject:${d.id.slice(0, 8)}`));
    return row;
  });
  buttons.push(ui.navRow("m:main"));

  await ui.editMenu(chatId, msgId, `📬 *Outreach*\n\n${lines.join("\n")}`, buttons);
}

// ── Deploy Menu ────────────────────────────────────────
async function handleDeploy(chatId: number, msgId: number, param: string) {
  if (param === "menu") {
    const buttons: ui.Btn[][] = [
      [ui.btn("🖥️ Deploy Render", "cf:rdeploy:main")],
      [ui.btn("🌐 Deploy Netlify", "nl:0")],
      ui.navRow("m:main"),
    ];
    await ui.editMenu(chatId, msgId, "🚀 *Deploy*\n\nSelect target:", buttons);
  }
}

// ── Confirmation Handler ───────────────────────────────
async function handleConfirm(chatId: number, msgId: number, userId: number, param: string) {
  const [action, target] = param.split(":");

  if (action === "rdeploy") {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID || "srv-dbf6gi0ae00c73ev0l9g";
    if (!apiKey) {
      await ui.editMenu(chatId, msgId, "❌ RENDER\\_API\\_KEY not set.", [ui.navRow("m:main")]);
      return;
    }
    const res = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) {
      await ui.editMenu(chatId, msgId, `❌ Deploy failed: ${res.status}`, [ui.navRow("m:main")]);
      return;
    }
    const data = await res.json();
    await ui.editMenu(chatId, msgId, `✅ Render deploy triggered!\nID: \`${e(data.id || "?")}\``, [ui.navRow("m:main")]);
  }

  if (action === "ndeploy") {
    try {
      const result = await nf.triggerDeploy(target);
      await ui.editMenu(chatId, msgId, `✅ Netlify deploy triggered via ${e(result.method)}!`, [ui.navRow("nl:0")]);
    } catch (err: any) {
      await ui.editMenu(chatId, msgId, `❌ ${e(err.message)}`, [ui.navRow("nl:0")]);
    }
  }

  if (action === "approve") {
    const { data: drafts } = await supabase.from("outreach").select("id").eq("status", "draft").limit(20);
    const draft = (drafts as any[])?.find((d) => d.id.startsWith(target));
    if (draft) {
      await supabase.from("outreach").update({ status: "approved" }).eq("id", draft.id);
      await ui.editMenu(chatId, msgId, `✅ Draft approved!`, [ui.navRow("ol:0")]);
    }
  }

  if (action === "reject") {
    const { data: drafts } = await supabase.from("outreach").select("id").in("status", ["draft", "approved"]).limit(20);
    const draft = (drafts as any[])?.find((d) => d.id.startsWith(target));
    if (draft) {
      await supabase.from("outreach").update({ status: "rejected" }).eq("id", draft.id);
      await ui.editMenu(chatId, msgId, `🚫 Draft rejected.`, [ui.navRow("ol:0")]);
    }
  }

  if (action === "send") {
    await ui.editMenu(chatId, msgId, `📤 Use /send ${e(target)} to send (requires Gmail setup).`, [ui.navRow("ol:0")]);
  }
}

// ── Input Prompt Handler ───────────────────────────────
async function handleInputPrompt(chatId: number, msgId: number, userId: number, param: string) {
  const [action, target] = param.split(":");

  if (action === "analyze") {
    await setSession(chatId, userId, "analyze", { repo: target });
    await ui.editMenu(
      chatId, msgId,
      `🔍 *Analyze ${e(target)}*\n\nType the problem description:\n\nExample: "Build failing with TypeScript errors"`,
      [[ui.btn("❌ Cancel", "m:main")]]
    );
  }

  if (action === "fix") {
    await setSession(chatId, userId, "fix", { repo: target });
    await ui.editMenu(
      chatId, msgId,
      `🔧 *Fix ${e(target)}*\n\nType the problem description:`,
      [[ui.btn("❌ Cancel", "m:main")]]
    );
  }

  if (action === "draft") {
    await ui.editMenu(
      chatId, msgId,
      `📝 Use /draft ${e(target)} to create a draft email.`,
      [ui.navRow("cr:0")]
    );
  }
}
