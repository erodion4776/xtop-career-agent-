import { sendMessage } from './telegram.js';

// ─── Dynamic module loaders ────────────────────────────────────────

async function getGitHubClient() {
  const mod = await import('./github-client.js');
  const Cls = (mod as any).GitHubClient || (mod as any).GithubClient ||
    (mod as any).GitHub || (mod as any).default ||
    Object.values(mod).find((v: any) => typeof v === 'function');
  return new (Cls as any)();
}

async function getNetlifyClient() {
  const mod = await import('./netlify-client.js');
  const Cls = (mod as any).NetlifyClient || (mod as any).Netlify ||
    (mod as any).default ||
    Object.values(mod).find((v: any) => typeof v === 'function');
  return new (Cls as any)();
}

async function getCodeAnalyzer() {
  return await import('./code-analyzer.js');
}

// ─── Main Entry ─────────────────────────────────────────────────────

export async function handleDevCommand(
  chatId: number,
  text: string,
  from: any,
  cmd: string,
  args: string
): Promise<void> {
  try {
    switch (cmd) {
      case '/repos':    await cmdRepos(chatId); break;
      case '/browse':   await cmdBrowse(chatId, args); break;
      case '/readfile': await cmdReadFile(chatId, args); break;
      case '/analyze':  await cmdAnalyze(chatId, args); break;
      case '/fix':      await cmdFix(chatId, args); break;
      case '/watch':    await cmdWatch(chatId, args); break;
      case '/newsite':  await cmdNewSite(chatId, args, from); break;
      case '/netlify':  await cmdNetlify(chatId); break;
      case '/deploy':   await cmdDeploy(chatId, args); break;
      case '/ci':       await cmdWatch(chatId, args); break;
      case '/devstatus': await cmdDevStatus(chatId); break;
      default:
        await sendMessage(chatId, `❓ Unknown dev command: ${cmd}`);
    }
  } catch (err: any) {
    await sendMessage(chatId, `❌ Error: ${err.message}`);
  }
}

// ─── /repos ─────────────────────────────────────────────────────────

async function cmdRepos(chatId: number) {
  const gh = await getGitHubClient();
  try {
    const result = await gh.listRepos(0, 10);
    const repos: any[] = result?.repos || result || [];
    if (repos.length === 0) {
      await sendMessage(chatId, '📂 No repos found.');
      return;
    }
    const text = '📂 *Your GitHub Repos*\n\n' +
      repos.map((r: any) => `📁 ${r.full_name || r.name}`).join('\n');
    await sendMessage(chatId, text);
  } catch (err: any) {
    await sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ─── /browse owner/repo [path] ──────────────────────────────────────

async function cmdBrowse(chatId: number, args: string) {
  if (!args) {
    await sendMessage(chatId, 'Usage: `/browse owner/repo [path]`');
    return;
  }

  const parts = args.split(/\s+/);
  const repoFullName = parts[0];
  const path = parts.slice(1).join('/') || '';
  const [owner, repo] = repoFullName.split('/');

  if (!owner || !repo) {
    await sendMessage(chatId, '❌ Format: `/browse owner/repo [path]`');
    return;
  }

  const gh = await getGitHubClient();
  try {
    const contents = await gh.listContents(owner, repo, path);
    const items: any[] = contents || [];
    if (items.length === 0) {
      await sendMessage(chatId, `📂 *${repoFullName}/${path}*\n\nEmpty.`);
      return;
    }

    items.sort((a: any, b: any) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });

    const text = `📂 *${repoFullName}/${path}*\n\n` +
      items.slice(0, 20).map((i: any) =>
        `${i.type === 'dir' ? '📁' : '📄'} ${i.name}`
      ).join('\n');
    await sendMessage(chatId, text);
  } catch (err: any) {
    await sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ─── /readfile owner/repo path ──────────────────────────────────────

async function cmdReadFile(chatId: number, args: string) {
  if (!args) {
    await sendMessage(chatId, 'Usage: `/readfile owner/repo path/to/file`');
    return;
  }

  const parts = args.split(/\s+/);
  const repoFullName = parts[0];
  const filePath = parts.slice(1).join('/');
  const [owner, repo] = repoFullName.split('/');

  if (!owner || !repo || !filePath) {
    await sendMessage(chatId, '❌ Format: `/readfile owner/repo path/to/file`');
    return;
  }

  const gh = await getGitHubClient();
  try {
    const content = await gh.getFileContent(owner, repo, filePath);
    const truncated = content.length > 3500 ? content.slice(0, 3500) + '\n\n… *(truncated)*' : content;
    await sendMessage(chatId, `📄 *${filePath}*\n\n\`\`\`\n${truncated}\n\`\`\``);
  } catch (err: any) {
    await sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ─── /analyze owner/repo description ────────────────────────────────

async function cmdAnalyze(chatId: number, args: string) {
  if (!args) {
    await sendMessage(chatId, 'Usage: `/analyze owner/repo description of issue`');
    return;
  }

  const spaceIdx = args.indexOf(' ');
  if (spaceIdx < 0) {
    await sendMessage(chatId, '❌ Format: `/analyze owner/repo description`\n\nExample: `/analyze erodion4776/xtop Build is failing`');
    return;
  }

  const repoFullName = args.slice(0, spaceIdx);
  const description = args.slice(spaceIdx + 1).trim();
  const slashParts = repoFullName.split('/');

  if (slashParts.length !== 2 || !slashParts[0] || !slashParts[1]) {
    await sendMessage(chatId, '❌ Repo must be exactly `owner/repo` (two parts).\n\nExample: `/analyze erodion4776/xtop Build fails`');
    return;
  }

  const [owner, repo] = slashParts;

  await sendMessage(chatId, `🔍 *Analyzing ${repoFullName}…*\nThis may take 30-60 seconds.`);

  try {
    const analyzer = await getCodeAnalyzer();
    const analyzeFn = (analyzer as any).analyzeIssue || (analyzer as any).analyzeError || (analyzer as any).analyze;
    if (typeof analyzeFn !== 'function') {
      await sendMessage(chatId, '⚠️ Code analyzer module has no analyze function.');
      return;
    }

    const result = await analyzeFn(owner, repo, description);
    const truncated = (result || 'No result').length > 3800
      ? (result || '').slice(0, 3800) + '\n\n… *(truncated)*'
      : (result || 'No result');
    await sendMessage(chatId, `🔍 *Analysis: ${repoFullName}*\n\n${truncated}`);
  } catch (err: any) {
    await sendMessage(chatId, `❌ Analysis failed: ${err.message}`);
  }
}

// ─── /fix owner/repo description ────────────────────────────────────

async function cmdFix(chatId: number, args: string) {
  if (!args) {
    await sendMessage(chatId, 'Usage: `/fix owner/repo description of issue`');
    return;
  }

  const spaceIdx = args.indexOf(' ');
  if (spaceIdx < 0) {
    await sendMessage(chatId, '❌ Format: `/fix owner/repo description`\n\nExample: `/fix erodion4776/xtop Missing types`');
    return;
  }

  const repoFullName = args.slice(0, spaceIdx);
  const description = args.slice(spaceIdx + 1).trim();
  const slashParts = repoFullName.split('/');

  if (slashParts.length !== 2 || !slashParts[0] || !slashParts[1]) {
    await sendMessage(chatId, '❌ Repo must be exactly `owner/repo`.\n\nExample: `/fix erodion4776/xtop Missing types`');
    return;
  }

  const [owner, repo] = slashParts;

  await sendMessage(chatId, `🔧 *Generating fix for ${repoFullName}…*\nThis may take 1-2 minutes.`);

  try {
    const analyzer = await getCodeAnalyzer();
    const fixFn = (analyzer as any).generateFix || (analyzer as any).fix || (analyzer as any).createFix;
    if (typeof fixFn !== 'function') {
      await sendMessage(chatId, '⚠️ Code analyzer module has no fix function.');
      return;
    }

    const result = await fixFn(owner, repo, description);

    // result is { diagnosis, branch, files: [{path, content}], prTitle, prBody }
    const diagnosis = result?.diagnosis || 'No diagnosis';
    const branch = result?.branch || 'fix/auto';
    const files: any[] = result?.files || [];
    const prTitle = result?.prTitle || `fix: ${description.slice(0, 50)}`;

    let reply = `🔧 *Fix for ${repoFullName}*\n\n`;
    reply += `*Diagnosis:* ${diagnosis}\n\n`;
    reply += `*Branch:* \`${branch}\`\n`;
    reply += `*PR Title:* ${prTitle}\n\n`;

    if (files.length > 0) {
      reply += `*Files to change (${files.length}):*\n`;
      for (const f of files) {
        reply += `📄 \`${f.path}\`\n`;
      }
      reply += '\n';

      // Show first file content as preview
      if (files[0]?.content) {
        const preview = files[0].content.length > 1500
          ? files[0].content.slice(0, 1500) + '\n… *(truncated)*'
          : files[0].content;
        reply += `*Preview (${files[0].path}):*\n\`\`\`\n${preview}\n\`\`\`\n\n`;
      }

      reply += '⚠️ *Apply this fix?*\nReply with `/apply ${repoFullName}` to create a PR.';
    } else {
      reply += 'No file changes generated. The diagnosis may still be useful above.';
    }

    const truncated = reply.length > 3800 ? reply.slice(0, 3800) + '\n\n… *(truncated)*' : reply;
    await sendMessage(chatId, truncated);
  } catch (err: any) {
    await sendMessage(chatId, `❌ Fix failed: ${err.message}`);
  }
}

// ─── /watch owner/repo ──────────────────────────────────────────────

async function cmdWatch(chatId: number, args: string) {
  const repoFullName = args.trim();
  if (!repoFullName || !repoFullName.includes('/')) {
    await sendMessage(chatId, 'Usage: `/watch owner/repo`');
    return;
  }

  const [owner, repo] = repoFullName.split('/');
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    await sendMessage(chatId, '❌ GITHUB_TOKEN not set.');
    return;
  }

  await sendMessage(chatId, `👁 *Checking CI for ${repoFullName}…*`);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=5`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );

    if (!res.ok) {
      await sendMessage(chatId, `⚠️ API error ${res.status}. Repo may not have GitHub Actions.`);
      return;
    }

    const data = await res.json() as any;
    const runs: any[] = data.workflow_runs || [];

    if (runs.length === 0) {
      await sendMessage(chatId, `⚠️ *CI: ${repoFullName}*\n\nNo workflow runs found.\nAdd \`.github/workflows/\` to enable CI.`);
      return;
    }

    const text = `👁 *CI: ${repoFullName}*\n\n` + runs.map((r: any) => {
      const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : r.status === 'in_progress' ? '🔄' : '⏳';
      return `${icon} *${r.name}*\n${r.head_branch} • ${r.conclusion || r.status}\n_${r.created_at}_`;
    }).join('\n\n');

    await sendMessage(chatId, text.length > 3800 ? text.slice(0, 3800) + '\n…' : text);
  } catch (err: any) {
    await sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ─── /newsite [description] ─────────────────────────────────────────

async function cmdNewSite(chatId: number, args: string, from: any) {
  if (!args) {
    await sendMessage(chatId,
      '🆕 *New Site Builder*\n\nUsage: `/newsite description`\n\n' +
      'Example: `/newsite A landing page for a hair salon`\n\n' +
      'Or tap 🆕 New Site in the Dev Tools menu.'
    );
    return;
  }

  await sendMessage(chatId,
    '🏗 *Building your site…*\n\nThis takes 1-2 minutes.\n' +
    '1. Generating HTML with AI\n2. Creating GitHub repo\n3. Deploying to Netlify'
  );

  try {
    const sbMod = await import('./site-builder.js');
    const buildFn = (sbMod as any).buildSite || (sbMod as any).createSite || (sbMod as any).default;
    if (typeof buildFn === 'function') {
      const result = await buildFn(args, from?.id || chatId);
      await sendMessage(chatId,
        `✅ *Site created!*\n\n` +
        `🌐 URL: ${result?.url || 'check Netlify'}\n` +
        `📂 Repo: ${result?.repo || 'check GitHub'}\n` +
        `🚀 Deploy: ${result?.deployUrl || 'check Netlify dashboard'}`
      );
    } else {
      await sendMessage(chatId, '⚠️ Site builder module loaded but no build function found.');
    }
  } catch (err: any) {
    await sendMessage(chatId, `❌ Site build failed: ${err.message}`);
  }
}

// ─── /netlify ───────────────────────────────────────────────────────

async function cmdNetlify(chatId: number) {
  if (!process.env.NETLIFY_AUTH_TOKEN) {
    await sendMessage(chatId, '❌ Netlify not configured.\nSet `NETLIFY_AUTH_TOKEN` env var on Render.');
    return;
  }

  try {
    const nf = await getNetlifyClient();
    const result = await nf.listSites(0, 10);
    const sites: any[] = result?.sites || result || [];

    if (sites.length === 0) {
      await sendMessage(chatId, '🌐 No Netlify sites found.');
      return;
    }

    const text = '🌐 *Netlify Sites*\n\n' +
      sites.map((s: any) => `• *${s.name || s.id}*\n  ${s.ssl_url || s.url || 'no url'}`).join('\n\n');
    await sendMessage(chatId, text);
  } catch (err: any) {
    await sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ─── /deploy [render|netlify] ───────────────────────────────────────

async function cmdDeploy(chatId: number, args: string) {
  const target = args.trim().toLowerCase();

  if (!target || target === 'render') {
    const serviceId = process.env.RENDER_SERVICE_ID;
    const apiKey = process.env.RENDER_API_KEY;
    if (!serviceId || !apiKey) {
      await sendMessage(chatId, '❌ Render not configured.\nSet RENDER_API_KEY + RENDER_SERVICE_ID.');
      return;
    }

    await sendMessage(chatId, '▲ *Deploying to Render…*');
    try {
      const res = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      const deploy = await res.json() as any;
      await sendMessage(chatId, `✅ *Render deploy triggered!*\n\nID: \`${deploy?.id || 'ok'}\``);
    } catch (err: any) {
      await sendMessage(chatId, `❌ Deploy failed: ${err.message}`);
    }
    return;
  }

  if (target === 'netlify') {
    await sendMessage(chatId, '🌐 Use the Netlify button in Dev Tools to deploy a specific site.');
    return;
  }

  await sendMessage(chatId, 'Usage: `/deploy [render|netlify]`');
}

// ─── /devstatus ─────────────────────────────────────────────────────

async function cmdDevStatus(chatId: number) {
  const gh = !!process.env.GITHUB_TOKEN;
  const render = !!process.env.RENDER_API_KEY;
  const netlify = !!process.env.NETLIFY_AUTH_TOKEN;
  const gemini = !!process.env.GEMINI_API_KEY;

  await sendMessage(chatId,
    `🛠 *Dev Agent Status*\n\n` +
    `🐙 GitHub: ${gh ? '✅' : '❌'}\n` +
    `▲ Render: ${render ? '✅' : '❌'}\n` +
    `🌐 Netlify: ${netlify ? '✅' : '❌'}\n` +
    `🤖 Gemini: ${gemini ? '✅' : '❌'}\n` +
    `📦 Model: ${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}`
  );
}
