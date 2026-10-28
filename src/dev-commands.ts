import { sendMessage } from "./telegram.js";
import { supabase } from "./supabase.js";
import * as gh from "./github-client.js";
import * as nf from "./netlify-client.js";
import * as analyzer from "./code-analyzer.js";
import { buildSite, type SiteType } from "./site-builder.js";

function escapeMd(s: string): string {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ── /repos ─────────────────────────────────────────────
export async function handleRepos(chatId: number) {
  try {
    const repos = await gh.listRepos(15);
    if (!repos.length) {
      await sendMessage(chatId, "No repositories found for this token.");
      return;
    }
    const lines = repos.map((r: any) =>
      `• *${escapeMd(r.full_name)}*\n  ${escapeMd(r.description || "No description")} | ${escapeMd(r.language || "?")} | ⭐${r.stargazers_count}`
    );
    await sendMessage(chatId, `📦 *Your Repositories*\n\n${lines.join("\n\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /browse ────────────────────────────────────────────
export async function handleBrowse(chatId: number, args: string) {
  try {
    let owner: string, repo: string, path = "";
    const parts = args.split(/\s+/);
    if (!parts[0]) {
      owner = gh.DEFAULT_REPO.owner;
      repo = gh.DEFAULT_REPO.repo;
    } else if (parts[0].includes("/")) {
      const r = gh.parseRepo(parts[0]);
      owner = r.owner; repo = r.repo;
      path = parts.slice(1).join("/");
    } else {
      owner = gh.DEFAULT_REPO.owner;
      repo = gh.DEFAULT_REPO.repo;
      path = parts.join("/");
    }

    const contents = await gh.getContents(owner, repo, path);
    const items = Array.isArray(contents) ? contents : [contents];
    const lines = items.map((item: any) => {
      const icon = item.type === "dir" ? "📁" : "📄";
      return `${icon} ${escapeMd(item.name)}`;
    });
    const header = path ? `${owner}/${repo}/${path}` : `${owner}/${repo}`;
    await sendMessage(chatId, `📂 *${escapeMd(header)}*\n\n${lines.join("\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /readfile ──────────────────────────────────────────
export async function handleReadFile(chatId: number, args: string) {
  try {
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, "Usage: `/readfile owner/repo path/to/file.ts`");
      return;
    }
    const r = gh.parseRepo(parts[0]);
    const filePath = parts.slice(1).join("/");
    const file = await gh.getFile(r.owner, r.repo, filePath);
    const preview = file.content.length > 3500
      ? file.content.slice(0, 3500) + "\n\n... (truncated)"
      : file.content;
    await sendMessage(chatId, `📄 *${escapeMd(filePath)}* (${file.size} bytes)\n\`\`\`\n${preview}\n\`\`\``);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /analyze ───────────────────────────────────────────
export async function handleAnalyze(chatId: number, args: string) {
  try {
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, "Usage: `/analyze owner/repo description of the problem`");
      return;
    }
    const r = gh.parseRepo(parts[0]);
    const description = parts.slice(1).join(" ");

    await sendMessage(chatId, `🔍 Analyzing *${escapeMd(r.owner + "/" + r.repo)}*...\nThis may take 30-60 seconds.`);

    const files: { path: string; content: string }[] = [];
    const toRead = ["package.json", "tsconfig.json", "src/index.ts"];
    for (const p of toRead) {
      try {
        const f = await gh.getFile(r.owner, r.repo, p);
        files.push({ path: p, content: f.content });
      } catch { /* skip */ }
    }

    let errorLog = "";
    try {
      const commits = await gh.getCommits(r.owner, r.repo, "main", 5);
      errorLog = "Recent commits:\n" + commits.map((c: any) =>
        `- ${c.sha.slice(0, 7)}: ${c.commit.message.split("\n")[0]}`
      ).join("\n");
    } catch { /* ok */ }

    try {
      const runs = await gh.getWorkflowRuns(r.owner, r.repo, 3);
      const failed = runs.workflow_runs?.filter((r: any) => r.conclusion === "failure");
      if (failed?.length) {
        errorLog += "\n\nFailed CI runs:\n" + failed.map((r: any) =>
          `- ${r.name} #${r.run_number}: ${r.head_branch} (${r.created_at})`
        ).join("\n");
      }
    } catch { /* ok */ }

    if (!files.length && !errorLog) {
      await sendMessage(chatId, "⚠️ Could not read any files or logs. Check repo access.");
      return;
    }

    const diagnosis = await analyzer.analyzeError(errorLog, files, description);

    const report = [
      `🔬 *Analysis Report*`,
      ``,
      `*Severity:* ${escapeMd(diagnosis.severity.toUpperCase())}`,
      `*Confidence:* ${diagnosis.confidence}%`,
      ``,
      `*Diagnosis:* ${escapeMd(diagnosis.diagnosis)}`,
      ``,
      `*Root Cause:* ${escapeMd(diagnosis.root_cause)}`,
      ``,
      `*Files to Fix:*`,
      ...diagnosis.files_to_fix.map((f) => `  • ${escapeMd(f.path)}: ${escapeMd(f.reason)}`),
      ``,
      `Use /fix ${r.owner}/${r.repo} ${description} to apply a fix.`,
    ];
    await sendMessage(chatId, report.join("\n"));

    await supabase.from("audit_log").insert({
      action: "dev_analyze",
      details: { repo: `${r.owner}/${r.repo}`, description, diagnosis },
    });
  } catch (e: any) {
    await sendMessage(chatId, `❌ Analysis failed: ${escapeMd(e.message)}`);
  }
}

// ── /fix ───────────────────────────────────────────────
export async function handleFix(chatId: number, args: string) {
  try {
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, "Usage: `/fix owner/repo description of the problem`");
      return;
    }
    const r = gh.parseRepo(parts[0]);
    const description = parts.slice(1).join(" ");
    const repoFullName = `${r.owner}/${r.repo}`;

    await sendMessage(chatId, `🔧 Starting fix for *${escapeMd(repoFullName)}*...\nStep 1/5: Reading files`);

    const keyFiles = ["package.json", "tsconfig.json", "src/index.ts", "src/telegram-handler.ts", "src/supabase.ts"];
    const files: { path: string; content: string; sha?: string }[] = [];
    for (const p of keyFiles) {
      try {
        const f = await gh.getFile(r.owner, r.repo, p);
        files.push({ path: p, content: f.content, sha: f.sha });
      } catch { /* skip */ }
    }

    if (!files.length) {
      await sendMessage(chatId, "⚠️ Could not read any files from the repo.");
      return;
    }

    await sendMessage(chatId, `Step 2/5: Analyzing with AI...`);

    let errorLog = "";
    try {
      const runs = await gh.getWorkflowRuns(r.owner, r.repo, 3);
      const failed = runs.workflow_runs?.filter((r: any) => r.conclusion === "failure");
      if (failed?.length) {
        errorLog = "Failed CI: " + failed.map((r: any) => `${r.name} on ${r.head_branch}`).join("; ");
      }
    } catch { /* ok */ }

    const diagnosis = await analyzer.analyzeError(errorLog, files, description);
    await sendMessage(chatId, `Step 3/5: Generating fix...\n_Diagnosis: ${escapeMd(diagnosis.diagnosis)}_`);

    const fixes = await analyzer.generateFix(diagnosis, files);
    if (!fixes.length) {
      await sendMessage(chatId, "⚠️ AI could not generate a fix. Try a more specific description.");
      return;
    }

    await sendMessage(chatId, `Step 4/5: Reviewing changes...`);
    const originals = fixes.map((fix) => {
      const orig = files.find((f) => f.path === fix.path);
      return { path: fix.path, content: orig?.content || "" };
    });
    const review = await analyzer.reviewChanges(originals, fixes.map((f) => ({ path: f.path, content: f.content })));

    if (!review.safe) {
      await sendMessage(chatId, `⚠️ Review found issues:\n${review.issues.map((i) => `• ${escapeMd(i)}`).join("\n")}\n\nFix not applied.`);
      return;
    }

    await sendMessage(chatId, `Step 5/5: Creating branch and PR...`);
    const branchName = `fix/${Date.now()}-${description.slice(0, 20).replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
    await gh.createBranch(r.owner, r.repo, branchName);

    const commitMessages: string[] = [];
    for (const fix of fixes) {
      const orig = files.find((f) => f.path === fix.path);
      await gh.createOrUpdateFile(
        r.owner, r.repo, fix.path,
        fix.content,
        `fix: ${fix.explanation}`,
        branchName,
        orig?.sha
      );
      commitMessages.push(`• ${fix.path}: ${fix.explanation}`);
    }

    const prBody = [
      `## 🔧 Autonomous Fix`,
      `**Problem:** ${description}`,
      `**Diagnosis:** ${diagnosis.diagnosis}`,
      `**Root Cause:** ${diagnosis.root_cause}`,
      `**Severity:** ${diagnosis.severity}`,
      `**Confidence:** ${diagnosis.confidence}%`,
      ``,
      `### Changes`,
      ...commitMessages,
      ``,
      `_Generated by XTOP Dev Agent. Review before merging._`,
    ].join("\n");

    const pr = await gh.createPR(r.owner, r.repo, `fix: ${diagnosis.diagnosis}`, prBody, branchName);

    await sendMessage(chatId, [
      `✅ *Fix Applied!*`,
      `*Branch:* \`${escapeMd(branchName)}\``,
      `*PR:* ${escapeMd(pr.html_url)}`,
      ``,
      ...commitMessages.map((m) => escapeMd(m)),
      ``,
      `⚠️ Review the PR before merging.`,
    ].join("\n"));

    await supabase.from("audit_log").insert({
      action: "dev_fix",
      details: { repo: repoFullName, branch: branchName, pr: pr.number, files: fixes.map((f) => f.path) },
    });
  } catch (e: any) {
    await sendMessage(chatId, `❌ Fix failed: ${escapeMd(e.message)}`);
  }
}

// ── /watch ─────────────────────────────────────────────
export async function handleWatch(chatId: number, args: string) {
  try {
    const r = args ? gh.parseRepo(args.split(/\s+/)[0]) : gh.DEFAULT_REPO;
    const repoFullName = `${r.owner}/${r.repo}`;

    await sendMessage(chatId, `👁️ Checking CI for *${escapeMd(repoFullName)}*...`);

    const runs = await gh.getWorkflowRuns(r.owner, r.repo, 5);
    if (!runs.workflow_runs?.length) {
      await sendMessage(chatId, `No CI runs found. Add a workflow file first.`);
      return;
    }

    const latest = runs.workflow_runs[0];
    const icon = latest.conclusion === "success" ? "✅" : latest.conclusion === "failure" ? "❌" : "⏳";

    const lines = [
      `👁️ *CI Watch: ${escapeMd(repoFullName)}*`,
      ``,
      `${icon} *Latest:* ${escapeMd(latest.name)} #${latest.run_number}`,
      `Status: ${escapeMd(latest.conclusion || latest.status)}`,
      `Branch: ${escapeMd(latest.head_branch)}`,
      `Time: ${escapeMd(latest.created_at?.slice(0, 16) || "?")}`,
    ];

    // Show all recent runs
    lines.push("", "*Recent Runs:*");
    for (const run of runs.workflow_runs.slice(0, 5)) {
      const ri = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⏳";
      lines.push(`${ri} ${escapeMd(run.head_branch)} — ${escapeMd(run.conclusion || run.status)}`);
    }

    // If failing, offer to fix
    if (latest.conclusion === "failure") {
      lines.push(
        "",
        `⚠️ *Latest build is failing!*`,
        `Use /fix ${repoFullName} <description> to auto-fix.`,
      );

      // Try to get error details
      try {
        const jobs = await gh.getWorkflowRunJobs(r.owner, r.repo, latest.id);
        const failedJobs = jobs.jobs?.filter((j: any) => j.conclusion === "failure");
        if (failedJobs?.length) {
          lines.push("", "*Failed Steps:*");
          for (const job of failedJobs) {
            const failedSteps = job.steps?.filter((s: any) => s.conclusion === "failure");
            for (const step of failedSteps || []) {
              lines.push(`  ❌ ${escapeMd(step.name)} (${escapeMd(job.name)})`);
            }
          }
          lines.push("", `Try: /fix ${repoFullName} ${escapeMd(failedJobs[0].steps?.find((s: any) => s.conclusion === "failure")?.name || "build error")}`);
        }
      } catch { /* can't get job details */ }
    }

    await sendMessage(chatId, lines.join("\n"));

    await supabase.from("audit_log").insert({
      action: "dev_watch",
      details: { repo: repoFullName, status: latest.conclusion },
    });
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /newsite ───────────────────────────────────────────
export async function handleNewSite(chatId: number, args: string) {
  try {
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, [
        "Usage: `/newsite <name> <type> [description]`",
        "",
        "*Types:* landing, portfolio, business, blog",
        "",
        "*Examples:*",
        "`/newsite my-bakery landing A modern bakery website`",
        "`/newsite john-doe portfolio Photography portfolio`",
        "`/newsite tech-corp business IT consulting firm`",
      ].join("\n"));
      return;
    }

    const siteName = parts[0];
    const type = parts[1] as SiteType;
    const description = parts.slice(2).join(" ") || `${siteName} website`;
    const owner = gh.DEFAULT_REPO.owner;

    if (!["landing", "portfolio", "business", "blog"].includes(type)) {
      await sendMessage(chatId, "❌ Invalid type. Use: landing, portfolio, business, or blog");
      return;
    }

    await sendMessage(chatId, `🌐 *Creating new site: ${escapeMd(siteName)}*\nType: ${escapeMd(type)}\nThis may take 1-2 minutes...`);

    const progressCb = async (msg: string) => {
      await sendMessage(chatId, msg);
    };

    const result = await buildSite(owner, siteName, type, description, progressCb);

    await sendMessage(chatId, [
      `🎉 *Site Created!*`,
      ``,
      `*Name:* ${escapeMd(siteName)}`,
      `*Type:* ${escapeMd(type)}`,
      `*GitHub:* ${escapeMd(result.repoUrl)}`,
      `*Live:* ${escapeMd(result.siteUrl)}`,
      ``,
      `✅ Your site is live! Edit files on GitHub to update.`,
    ].join("\n"));

    await supabase.from("audit_log").insert({
      action: "dev_newsite",
      details: { name: siteName, type, repo: result.repoUrl, site: result.siteUrl },
    });
  } catch (e: any) {
    await sendMessage(chatId, `❌ Site creation failed: ${escapeMd(e.message)}`);
  }
}

// ── /netlify ───────────────────────────────────────────
export async function handleNetlify(chatId: number) {
  try {
    if (!nf.isConfigured()) {
      await sendMessage(chatId, "❌ NETLIFY\\_AUTH\\_TOKEN not set.");
      return;
    }

    await sendMessage(chatId, "🔍 Fetching your Netlify sites...");
    const sites = await nf.listSites();

    if (!sites.length) {
      await sendMessage(chatId, "No sites found on your Netlify account.");
      return;
    }

    const lines = sites.map((s: any, i: number) => {
      const status = s.published_deploy?.state || s.state || "unknown";
      const icon = status === "ready" ? "✅" : status === "error" ? "❌" : "⏳";
      const url = s.ssl_url || s.url || "no url";
      return `${icon} *${i + 1}. ${escapeMd(s.name || "unnamed")}*\n  ${escapeMd(url)}\n  Status: ${escapeMd(status)}`;
    });

    await sendMessage(chatId, `🌐 *Your Netlify Sites (${sites.length})*\n\n${lines.join("\n\n")}\n\nUse /deploy netlify <name> to deploy.`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /deploy ────────────────────────────────────────────
export async function handleDeploy(chatId: number, args: string) {
  try {
    const parts = args.toLowerCase().trim().split(/\s+/);
    const target = parts[0] || "render";

    if (target === "render") {
      const apiKey = process.env.RENDER_API_KEY;
      const serviceId = process.env.RENDER_SERVICE_ID || "srv-dbf6gi0ae00c73ev0l9g";
      if (!apiKey) {
        await sendMessage(chatId, "❌ RENDER\\_API\\_KEY not set");
        return;
      }
      await sendMessage(chatId, "🚀 Triggering Render deployment...");
      const res = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Render ${res.status}`);
      const data = await res.json();
      await sendMessage(chatId, `✅ Deploy triggered!\nID: \`${escapeMd(data.id || "unknown")}\``);

    } else if (target === "netlify") {
      if (!nf.isConfigured()) {
        await sendMessage(chatId, "❌ NETLIFY\\_AUTH\\_TOKEN not set");
        return;
      }
      const query = parts.slice(1).join(" ");
      if (!query) {
        await sendMessage(chatId, "Usage: `/deploy netlify <site name or number>`\nUse /netlify to see your sites.");
        return;
      }
      await sendMessage(chatId, `🔍 Finding Netlify site...`);
      const sites = await nf.listSites();
      const num = parseInt(query, 10);
      let site: any = null;
      if (!isNaN(num) && num >= 1 && num <= sites.length) {
        site = sites[num - 1];
      } else {
        site = await nf.findSite(query);
      }
      if (!site) {
        await sendMessage(chatId, `❌ No site matching "${escapeMd(query)}". Use /netlify.`);
        return;
      }
      await sendMessage(chatId, `🚀 Deploying *${escapeMd(site.name)}*...`);
      const result = await nf.triggerDeploy(site.id);
      await sendMessage(chatId, `✅ *${escapeMd(site.name)}* deploy triggered via ${escapeMd(result.method)}!`);

    } else {
      await sendMessage(chatId, "Usage: `/deploy render` or `/deploy netlify <site>`");
    }

    await supabase.from("audit_log").insert({
      action: "deploy",
      details: { target },
    });
  } catch (e: any) {
    await sendMessage(chatId, `❌ Deploy failed: ${escapeMd(e.message)}`);
  }
}

// ── /ci ────────────────────────────────────────────────
export async function handleCI(chatId: number, args: string) {
  try {
    const r = args ? gh.parseRepo(args.split(/\s+/)[0]) : gh.DEFAULT_REPO;
    const runs = await gh.getWorkflowRuns(r.owner, r.repo, 5);
    if (!runs.workflow_runs?.length) {
      await sendMessage(chatId, `No workflow runs found for *${escapeMd(r.owner + "/" + r.repo)}*.`);
      return;
    }
    const lines = runs.workflow_runs.map((run: any) => {
      const icon = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⏳";
      return `${icon} ${escapeMd(run.name)} #${run.run_number}\n  ${escapeMd(run.head_branch)} | ${escapeMd(run.conclusion || run.status)}`;
    });
    await sendMessage(chatId, `🔄 *CI: ${escapeMd(r.owner + "/" + r.repo)}*\n\n${lines.join("\n\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── /devstatus ─────────────────────────────────────────
export async function handleDevStatus(chatId: number) {
  try {
    const { data: logs } = await supabase
      .from("audit_log")
      .select("action, details, created_at")
      .in("action", ["dev_analyze", "dev_fix", "dev_watch", "dev_newsite", "deploy"])
      .order("created_at", { ascending: false })
      .limit(10);

    if (!logs?.length) {
      await sendMessage(chatId, "No dev activity yet.");
      return;
    }

    const icons: Record<string, string> = {
      dev_fix: "🔧", deploy: "🚀", dev_analyze: "🔍", dev_watch: "👁️", dev_newsite: "🌐",
    };
    const lines = (logs as any[]).map((l) => {
      const icon = icons[l.action] || "📝";
      const repo = l.details?.repo || l.details?.target || l.details?.name || "?";
      return `${icon} ${escapeMd(l.action)} → ${escapeMd(repo)}\n  ${escapeMd(l.created_at?.slice(0, 16) || "?")}`;
    });
    await sendMessage(chatId, `📊 *Dev Activity*\n\n${lines.join("\n\n")}`);
  } catch (e: any) {
    await sendMessage(chatId, `❌ ${escapeMd(e.message)}`);
  }
}

// ── Router ─────────────────────────────────────────────
export async function handleDevCommand(chatId: number, cmd: string, args: string, fullText: string) {
  switch (cmd) {
    case "/repos": return handleRepos(chatId);
    case "/browse": return handleBrowse(chatId, args);
    case "/readfile": return handleReadFile(chatId, args);
    case "/analyze": return handleAnalyze(chatId, args);
    case "/fix": return handleFix(chatId, args);
    case "/watch": return handleWatch(chatId, args);
    case "/newsite": return handleNewSite(chatId, args);
    case "/netlify": return handleNetlify(chatId);
    case "/deploy": return handleDeploy(chatId, args);
    case "/ci": return handleCI(chatId, args);
    case "/devstatus": return handleDevStatus(chatId);
    default:
      await sendMessage(chatId, "Unknown dev command.");
  }
}
