import { supabase } from "./supabase.js";
import { sendMessage } from "./telegram.js";
import * as ui from "./ui-engine.js";
import * as gh from "./github-client.js";
import * as nf from "./netlify-client.js";
import { setSession } from "./session-store.js";

const e = ui.esc;

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
      case "ns": return handleNewSite(chatId, messageId, userId, param);
      case "wt": return handleWatch(chatId, messageId, param);
      case "cf": return handleConfirm(chatId, messageId, param);
      case "ip": return handleInputPrompt(chatId, messageId, userId, param);
      default:
        await ui.editMenu(chatId, messageId, "Unknown action.", [[ui.btn("🏠 Home", "m:main")]]);
    }
  } catch (err: any) {
    await ui.editMenu(chatId, messageId, `❌ ${e(err.message?.slice(0, 100) || "Error")}`, [[ui.btn("🏠 Home", "m:main")]]);
  }
}

async function handleMainMenu(chatId: number, msgId: number, action: string) {
  if (action === "main" || !action) {
    await ui.editMenu(chatId, msgId, "🤖 *XTOP Agent — Main Menu*", [
      [ui.btn("📦 GitHub", "gr:0"), ui.btn("🌐 Netlify", "nl:0")],
      [ui.btn("📇 CRM", "cr:0"), ui.btn("📬 Outreach", "ol:0")],
      [ui.btn("🌐 New Site", "ns:start"), ui.btn("🚀 Deploy", "dp:menu")],
      [ui.btn("🔧 Infra", "m:infra"), ui.btn("📋 Tasks", "m:tasks")],
    ]);
    return;
  }
  if (action === "infra") {
    const { getInfraReport } = await import("./infra-monitor.js");
    await ui.editMenu(chatId, msgId, e(await getInfraReport()), [ui.navRow("m:main")]);
    return;
  }
  if (action === "report") {
    const { count } = await supabase.from("job_leads").select("id", { count: "exact", head: true });
    await ui.editMenu(chatId, msgId, `📊 Leads: ${count || 0}`, [ui.navRow("m:main")]);
    return;
  }
  if (action === "tasks") {
    const { getPendingTasks } = await import("./task-engine.js");
    const tasks = await getPendingTasks();
    const text = tasks.length ? tasks.slice(0, 5).map((t: any) => `• ${e(t.task_type)}`).join("\n") : "✅ No pending tasks.";
    await ui.editMenu(chatId, msgId, `📋 *Tasks*\n\n${text}`, [ui.navRow("m:main")]);
  }
}

async function handleGithubRepos(chatId: number, msgId: number, param: string) {
  const page = parseInt(param, 10) || 0;
  const repos = await gh.listRepos(10);
  if (!repos.length) { await ui.editMenu(chatId, msgId, "No repos.", [ui.navRow("m:main")]); return; }
  const { text, buttons } = ui.paginateList(repos, page, 5, (r: any) => `${r.full_name}`, "ga");
  await ui.editMenu(chatId, msgId, `📦 *GitHub Repos*\n\n${text}`, buttons);
}

async function handleGithubActions(chatId: number, msgId: number, param: string) {
  const idx = parseInt(param, 10);
  const repos = await gh.listRepos(10);
  const repo = repos[idx];
  if (!repo) { await ui.editMenu(chatId, msgId, "Not found.", [ui.navRow("gr:0")]); return; }
  const name = repo.full_name;
  await ui.editMenu(chatId, msgId, `📦 *${e(name)}*\n${e(repo.description || "")}\n⭐${repo.stargazers_count} | ${e(repo.language || "?")}`, [
    [ui.btn("📂 Files", `gb:${name}:`), ui.btn("📄 Issues", `gi:${name}:0`)],
    [ui.btn("🔀 PRs", `gp:${name}:0`), ui.btn("📝 Commits", `gc:${name}:0`)],
    [ui.btn("🔍 Analyze", `ip:analyze:${name}`), ui.btn("🔧 Fix", `ip:fix:${name}`)],
    [ui.btn("👁️ Watch CI", `wt:${name}`)],
    ui.navRow("gr:0"),
  ]);
}

async function handleGithubBrowse(chatId: number, msgId: number, param: string) {
  const colonIdx = param.indexOf(":");
  const repoName = colonIdx > 0 ? param.slice(0, colonIdx) : param;
  const path = colonIdx > 0 ? param.slice(colonIdx + 1) : "";
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) { await ui.editMenu(chatId, msgId, "Invalid.", [ui.navRow("gr:0")]); return; }
  const contents = await gh.getContents(owner, repo, path);
  const items = Array.isArray(contents) ? contents : [contents];
  const sorted = [...items.filter((i: any) => i.type === "dir"), ...items.filter((i: any) => i.type === "file")];
  if (!sorted.length) { await ui.editMenu(chatId, msgId, "Empty.", [ui.navRow(`ga:0`)]); return; }
  const lines = sorted.slice(0, 10).map((i: any) => `${i.type === "dir" ? "📁" : "📄"} ${e(i.name)}`);
  const buttons: ui.Btn[][] = [];
  for (let i = 0; i < Math.min(sorted.length, 10); i += 2) {
    const row: ui.Btn[] = [];
    const i1 = sorted[i], p1 = path ? `${path}/${i1.name}` : i1.name;
    row.push(i1.type === "dir" ? ui.btn(`📁 ${i1.name.slice(0, 20)}`, `gb:${repoName}:${p1}`) : ui.btn(`📄 ${i1.name.slice(0, 20)}`, `gf:${repoName}:${p1}`));
    if (sorted[i + 1]) {
      const i2 = sorted[i + 1], p2 = path ? `${path}/${i2.name}` : i2.name;
      row.push(i2.type === "dir" ? ui.btn(`📁 ${i2.name.slice(0, 20)}`, `gb:${repoName}:${p2}`) : ui.btn(`📄 ${i2.name.slice(0, 20)}`, `gf:${repoName}:${p2}`));
    }
    buttons.push(row);
  }
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  buttons.push(ui.navRow(path ? `gb:${repoName}:${parentPath}` : `ga:0`, "gr:0"));
  await ui.editMenu(chatId, msgId, `📂 *${e(path || repoName)}*\n\n${lines.join("\n")}`, buttons);
}

async function handleGithubFile(chatId: number, msgId: number, param: string) {
  const colonIdx = param.indexOf(":");
  const repoName = colonIdx > 0 ? param.slice(0, colonIdx) : param;
  const filePath = colonIdx > 0 ? param.slice(colonIdx + 1) : "";
  const [owner, repo] = repoName.split("/");
  const file = await gh.getFile(owner, repo, filePath);
  const preview = file.content.length > 2000 ? file.content.slice(0, 2000) + "\n..." : file.content;
  const parentPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  await ui.editMenu(chatId, msgId, `📄 *${e(filePath)}*\n\`\`\`\n${preview}\n\`\`\``, [ui.navRow(`gb:${repoName}:${parentPath}`, "gr:0")]);
}

async function handleGithubIssues(chatId: number, msgId: number, param: string) {
  const parts = param.split(":");
  const [owner, repo] = [parts[0], parts[1]];
  const issues = await gh.getIssues(owner, repo);
  const text = issues.length ? issues.slice(0, 6).map((i: any) => `#${i.number} ${e(i.title.slice(0, 35))}`).join("\n") : "No open issues.";
  await ui.editMenu(chatId, msgId, `📄 *Issues*\n\n${text}`, [ui.navRow(`ga:0`)]);
}

async function handleGithubCommits(chatId: number, msgId: number, param: string) {
  const parts = param.split(":");
  const commits = await gh.getCommits(parts[0], parts[1], "main", 6);
  const text = commits.map((c: any) => `\`${c.sha.slice(0, 7)}\` ${e(c.commit.message.split("\n")[0].slice(0, 35))}`).join("\n");
  await ui.editMenu(chatId, msgId, `📝 *Commits*\n\n${text}`, [ui.navRow(`ga:0`)]);
}

async function handleGithubPRs(chatId: number, msgId: number, param: string) {
  const parts = param.split(":");
  const prs = await gh.getPRs(parts[0], parts[1]);
  const text = prs.length ? prs.slice(0, 6).map((p: any) => `#${p.number} ${e(p.title.slice(0, 35))}`).join("\n") : "No open PRs.";
  await ui.editMenu(chatId, msgId, `🔀 *PRs*\n\n${text}`, [ui.navRow(`ga:0`)]);
}

async function handleNetlifyList(chatId: number, msgId: number, _param: string) {
  if (!nf.isConfigured()) { await ui.editMenu(chatId, msgId
