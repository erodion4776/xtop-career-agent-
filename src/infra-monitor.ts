import { supabase } from "./supabase.js";

const GITHUB_API = "https://api.github.com";
const RENDER_API = "https://api.render.com/v1";
const REPO = "erodion4776/xtop-career-agent-";
const SERVICE_ID = process.env.RENDER_SERVICE_ID || "srv-dbf6gi0ae00c73ev0l9g";

async function ghFetch(path: string): Promise<any> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "xtop-agent",
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function renderFetch(path: string): Promise<any> {
  const token = process.env.RENDER_API_KEY;
  if (!token) return null;
  const res = await fetch(`${RENDER_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

// ── GitHub Health ──────────────────────────────────────
export async function getGithubHealth(): Promise<string> {
  const repo = await ghFetch(`/repos/${REPO}`);
  if (!repo) return "⚠️ GitHub: Cannot access repo. Check GITHUB_TOKEN.";

  const commits = await ghFetch(`/repos/${REPO}/commits?per_page=1`);
  const issues = await ghFetch(`/repos/${REPO}/issues?state=open&per_page=1`);

  const lastPush = repo.pushed_at ? new Date(repo.pushed_at).toLocaleDateString() : "unknown";
  const lastCommit = commits?.[0]?.commit?.message?.split("\n")[0] || "none";
  const openIssues = Array.isArray(issues) ? issues.length : "?";

  return [
    "🐙 *GitHub Health*",
    "",
    `Repo: ${REPO}`,
    `Stars: ${repo.stargazers_count || 0}`,
    `Open Issues: ${openIssues}`,
    `Last Push: ${lastPush}`,
    `Last Commit: ${lastCommit.slice(0, 60)}`,
    `Default Branch: ${repo.default_branch || "main"}`,
  ].join("\n");
}

// ── Render Status ──────────────────────────────────────
export async function getRenderStatus(): Promise<string> {
  const svc = await renderFetch(`/services/${SERVICE_ID}`);
  if (!svc) return "⚠️ Render: Cannot access service. Check RENDER_API_KEY.";

  const svcData = svc as any;
  const deploys = await renderFetch(`/services/${SERVICE_ID}/deploys?limit=3`);

  const lines = [
    "🖥️ *Render Status*",
    "",
    `Service: ${svcData.name || SERVICE_ID}`,
    `Type: ${svcData.type || "web"}`,
    `Status: ${svcData.serviceDetails?.status || svcData.status || "unknown"}`,
    `Region: ${svcData.serviceDetails?.region || "unknown"}`,
  ];

  if (Array.isArray(deploys)) {
    lines.push("", "*Recent Deploys:*");
    for (const d of deploys.slice(0, 3)) {
      const dd = d as any;
      const deploy = dd.deploy || dd;
      const status = deploy.status || "unknown";
      const icon = status === "live" ? "✅" : status === "build_failed" ? "❌" : "⏳";
      lines.push(`  ${icon} ${status} — ${deploy.createdAt?.slice(0, 16) || "?"}`);
    }
  }

  return lines.join("\n");
}

// ── DB Stats ───────────────────────────────────────────
export async function getDbStats(): Promise<string> {
  const tables = ["job_leads", "tasks", "prospects", "outreach", "audit_log", "gmail_connections"];
  const lines = ["🗄️ *Database Stats*", ""];

  for (const table of tables) {
    try {
      const { count, error } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true });
      if (error) {
        lines.push(`  ${table}: ⚠️ ${error.message.slice(0, 40)}`);
      } else {
        lines.push(`  ${table}: ${count || 0} rows`);
      }
    } catch (e: any) {
      lines.push(`  ${table}: ❌ ${e.message?.slice(0, 40) || "error"}`);
    }
  }

  return lines.join("\n");
}

// ── Full Report ────────────────────────────────────────
export async function getInfraReport(): Promise<string> {
  const [gh, render, db] = await Promise.all([
    getGithubHealth(),
    getRenderStatus(),
    getDbStats(),
  ]);
  return `🔧 *Infrastructure Report*\n${"─".repeat(20)}\n\n${gh}\n\n${render}\n\n${db}`;
}
