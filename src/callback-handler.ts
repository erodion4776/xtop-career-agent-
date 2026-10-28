import { sendMessage, editMessageText, answerCallbackQuery } from './telegram.js';
import { editMenu, btn, buildKeyboard, paginationRow } from './ui-engine.js';
import { GitHubClient } from './github-client.js';
import { NetlifyClient } from './netlify-client.js';
import { RenderClient } from './render-client.js';
import { analyzeIssue, generateFix } from './code-analyzer.js';
import { getSupabaseClient } from './supabase.js';
import * as siteBuilder from './site-builder.js';

// ─── Helpers ────────────────────────────────────────────────────────

async function getSession(chatId: number, userId: number) {
  const sb = getSupabaseClient();
  const { data } = await sb
    .from('bot_sessions')
    .select('*')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .single();
  return data as any;
}

async function setSession(chatId: number, userId: number, workflow: string, state: any) {
  const sb = getSupabaseClient();
  await sb.from('bot_sessions').upsert({
    chat_id: chatId,
    user_id: userId,
    workflow,
    state,
    updated_at: new Date().toISOString(),
  });
}

function truncate(s: string, max = 3800): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n… *(truncated)*';
}

function safeData(prefix: string, ...parts: string[]): string {
  const raw = [prefix, ...parts].join(':');
  if (raw.length <= 64) return raw;
  const head = [prefix, ...parts.slice(0, -1)].join(':') + ':';
  const avail = 64 - head.length;
  if (avail < 4) return prefix + ':err';
  return head + parts[parts.length - 1].slice(-avail);
}

// ─── Main Entry ─────────────────────────────────────────────────────

export async function handleCallback(update: any): Promise<void> {
  const cb = update.callback_query;
  if (!cb) return;

  const chatId: number = cb.message.chat.id;
  const msgId: number = cb.message.message_id;
  const data: string = cb.data || '';
  const cbId: string = cb.id;

  await answerCallbackQuery(cbId, '⏳').catch(() => {});

  try {
    const colonIdx = data.indexOf(':');
    const prefix = colonIdx > 0 ? data.slice(0, colonIdx) : data;
    const args = colonIdx > 0 ? data.slice(colonIdx + 1) : '';

    switch (prefix) {
      case 'm':  await handleMenu(chatId, msgId, args); break;
      case 'gr': await handleGitHubRepos(chatId, msgId, args); break;
      case 'ga': await handleGitHubAction(chatId, msgId, args); break;
      case 'gb': await handleGitHubBrowse(chatId, msgId, args); break;
      case 'gf': await handleGitHubFile(chatId, msgId, args); break;
      case 'gi': await handleGitHubIssues(chatId, msgId, args); break;
      case 'gc': await handleGitHubCommits(chatId, msgId, args); break;
      case 'gp': await handleGitHubPRs(chatId, msgId, args); break;
      case 'nl': await handleNetlifyList(chatId, msgId, args); break;
      case 'nd': await handleNetlifyDeploy(chatId, msgId, args, cbId); break;
      case 'cr': await handleCRMList(chatId, msgId, args); break;
      case 'ca': await handleCRMAction(chatId, msgId, args, cbId); break;
      case 'ol': await handleOutreachList(chatId, msgId, args); break;
      case 'dp': await handleDeploy(chatId, msgId, args, cbId); break;
      case 'ns': await handleNewSite(chatId, msgId, args, cbId); break;
      case 'wt': await handleWatchCI(chatId, msgId, args, cbId); break;
      case 'cf': await handleConfirm(chatId, msgId, args, cbId); break;
      default:
        await answerCallbackQuery(cbId, '❓ Unknown').catch(() => {});
    }
  } catch (err: any) {
    console.error('❌ Callback error:', err.message);
    await sendMessage(chatId, `❌ Error: ${err.message}`).catch(() => {});
  }
}

// ─── Menu Navigation ────────────────────────────────────────────────

async function handleMenu(chatId: number, msgId: number, target: string) {
  switch (target) {
    case 'main':
      await editMenu(chatId, msgId, '🤖 *XTOP Career Agent*', [
        [btn('💼 Jobs', 'm:jobs'), btn('📊 CRM', 'm:crm')],
        [btn('📧 Outreach', 'm:outreach'), btn('🛠 Dev Tools', 'm:dev')],
        [btn('🚀 Deploy', 'dp:menu'), btn('🏗 Infra', 'm:infra')],
        [btn('📋 Tasks', 'm:tasks'), btn('📈 Status', 'm:status')],
      ]);
      break;

    case 'dev':
      await editMenu(chatId, msgId, '🛠 *Dev Tools*', [
        [btn('📂 Repos', 'gr:0'), btn('🌐 Netlify', 'nl:0')],
        [btn('🔍 Analyze', 'm:analyze_hint'), btn('🔧 Fix', 'm:fix_hint')],
        [btn('👁 Watch CI', 'm:watch_hint'), btn('🆕 New Site', 'ns:start')],
        [btn('⬅️ Back', 'm:main')],
      ]);
      break;

    case 'crm':
      await editMenu(chatId, msgId, '📊 *CRM*', [
        [btn('👥 Prospects', 'cr:0'), btn('➕ Add', 'm:addprospect_hint')],
        [btn('⬅️ Back', 'm:main')],
      ]);
      break;

    case 'outreach':
      await editMenu(chatId, msgId, '📧 *Outreach*', [
        [btn('📝 Drafts', 'ol:0'), btn('📤 Sent', 'm:sent_hint')],
        [btn('⬅️ Back', 'm:main')],
      ]);
      break;

    case 'infra':
      await editMenu(chatId, msgId, '🏗 *Infrastructure*', [
        [btn('🐙 GitHub', 'm:gh_status'), btn('▲ Render', 'm:render_status')],
        [btn('🗄 Database', 'm:db_status'), btn('🌐 Netlify', 'nl:0')],
        [btn('⬅️ Back', 'm:main')],
      ]);
      break;

    case 'jobs':
      await editMenu(chatId, msgId, '💼 *Jobs*', [
        [btn('🔍 Discover', 'm:discover_hint'), btn('📋 Leads', 'm:leads_hint')],
        [btn('⬅️ Back', 'm:main')],
      ]);
      break;

    case 'tasks': {
      const sb = getSupabaseClient();
      const { data: tasks } = await sb
        .from('tasks')
        .select('id, type, status, created_at')
        .order('created_at', { ascending: false })
        .limit(10);
      const list = (tasks as any[]) || [];
      const text = list.length === 0
        ? '📋 *Tasks*\n\nNo tasks yet.'
        : '📋 *Recent Tasks*\n\n' + list.map((t: any) =>
            `${t.status === 'done' ? '✅' : t.status === 'running' ? '🔄' : '⏳'} ${t.type} — ${t.status}\n_${t.created_at}_`
          ).join('\n\n');
      await editMenu(chatId, msgId, text, [[btn('⬅️ Back', 'm:main')]]);
      break;
    }

    case 'status':
      await editMenu(chatId, msgId, '📈 *Status*\n\nUse `/status` for full report.', [
        [btn('⬅️ Back', 'm:main')],
      ]);
      break;

    case 'analyze_hint':
      await editMenu(chatId, msgId,
        '🔍 *Analyze*\n\nSend:\n`/analyze owner/repo description`\n\nExample:\n`/analyze erodion4776/xtop Build fails`',
        [[btn('⬅️ Back', 'm:dev')]]
      );
      break;

    case 'fix_hint':
      await editMenu(chatId, msgId,
        '🔧 *Fix*\n\nSend:\n`/fix owner/repo description`\n\nExample:\n`/fix erodion4776/xtop Missing types`',
        [[btn('⬅️ Back', 'm:dev')]]
      );
      break;

    case 'watch_hint':
      await editMenu(chatId, msgId,
        '👁 *Watch CI*\n\nSend:\n`/watch owner/repo`\n\nOr tap a repo → Watch CI.',
        [[btn('⬅️ Back', 'm:dev')]]
      );
      break;

    case 'addprospect_hint':
      await editMenu(chatId, msgId,
        '➕ *Add Prospect*\n\nSend:\n`/addprospect Name | Company | Email`',
        [[btn('⬅️ Back', 'm:crm')]]
      );
      break;

    case 'discover_hint':
      await editMenu(chatId, msgId,
        '🔍 *Discover*\n\nSend `/discover` to find new job leads.',
        [[btn('⬅️ Back', 'm:jobs')]]
      );
      break;

    case 'leads_hint':
      await editMenu(chatId, msgId,
        '📋 *Leads*\n\nSend `/report` for latest leads.',
        [[btn('⬅️ Back', 'm:jobs')]]
      );
      break;

    case 'sent_hint':
      await editMenu(chatId, msgId,
        '📤 *Sent*\n\nUse `/outreach` to see sent messages.',
        [[btn('⬅️ Back', 'm:outreach')]]
      );
      break;

    case 'gh_status': {
      const gh = new GitHubClient();
      const ok = gh.isConfigured();
      await editMenu(chatId, msgId,
        `🐙 *GitHub*\n\nStatus: ${ok ? '✅ Connected' : '❌ Not configured'}\n\nSet GITHUB_TOKEN env var if missing.`,
        [[btn('📂 Repos', 'gr:0'), btn('⬅️ Back', 'm:infra')]]
      );
      break;
    }

    case 'render_status': {
      const rc = new RenderClient();
      const ok = rc.isConfigured();
      await editMenu(chatId, msgId,
        `▲ *Render*\n\nStatus: ${ok ? '✅ Connected' : '❌ Not configured'}\n\nSet RENDER_API_KEY + RENDER_SERVICE_ID.`,
        [[btn('🚀 Deploy', 'dp:render'), btn('⬅️ Back', 'm:infra')]]
      );
      break;
    }

    case 'db_status': {
      const sb = getSupabaseClient();
      const { error } = await sb.from('tasks').select('id').limit(1);
      const ok = !error;
      await editMenu(chatId, msgId,
        `🗄 *Supabase*\n\nStatus: ${ok ? '✅ Connected' : '❌ Error: ' + (error?.message || 'unknown')}`,
        [[btn('⬅️ Back', 'm:infra')]]
      );
      break;
    }

    default:
      await editMenu(chatId, msgId, '🤖 *XTOP Agent*', [[btn('⬅️ Home', 'm:main')]]);
  }
}

// ─── GitHub Repos (paginated) ───────────────────────────────────────

async function handleGitHubRepos(chatId: number, msgId: number, args: string) {
  const gh = new GitHubClient();
  if (!gh.isConfigured()) {
    await editMenu(chatId, msgId, '❌ GitHub not configured.\nSet GITHUB_TOKEN.', [[btn('⬅️ Back', 'm:dev')]]);
    return;
  }

  const page = parseInt(args) || 0;
  const perPage = 5;

  try {
    const result = await (gh as any).listRepos(page, perPage);
    const repos: any[] = result.repos || result || [];
    const totalPages = result.totalPages || 1;

    if (repos.length === 0) {
      await editMenu(chatId, msgId, '📂 *GitHub Repos*\n\nNo repos found.', [[btn('⬅️ Back', 'm:dev')]]);
      return;
    }

    const rows: any[][] = repos.map((r: any) => {
      const name = r.full_name || r.name;
      return [btn(`📁 ${name}`, safeData('ga', name, 'menu'))];
    });

    if (totalPages > 1) {
      rows.push(paginationRow('gr', page, totalPages));
    }
    rows.push([btn('⬅️ Back', 'm:dev')]);

    await editMenu(chatId, msgId, `📂 *GitHub Repos* (page ${page + 1}/${totalPages})`, rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [[btn('⬅️ Back', 'm:dev')]]);
  }
}

// ─── GitHub Repo Action Menu ────────────────────────────────────────

async function handleGitHubAction(chatId: number, msgId: number, args: string) {
  const parts = args.split(':');
  if (parts.length < 2) {
    await editMenu(chatId, msgId, '❌ Invalid repo action.', [[btn('⬅️ Back', 'gr:0')]]);
    return;
  }

  const repoFullName = parts[0];
  const action = parts.slice(1).join(':');

  if (action === 'menu') {
    await editMenu(chatId, msgId, `📁 *${repoFullName}*`, [
      [btn('📂 Files', safeData('gb', repoFullName, '/')), btn('🐛 Issues', safeData('gi', repoFullName, '0'))],
      [btn('🔀 PRs', safeData('gp', repoFullName, '0')), btn('📝 Commits', safeData('gc', repoFullName, '0'))],
      [btn('🔍 Analyze', safeData('ga', repoFullName, 'analyze')), btn('🔧 Fix', safeData('ga', repoFullName, 'fix'))],
      [btn('👁 Watch CI', safeData('wt', repoFullName))],
      [btn('⬅️ Repos', 'gr:0')],
    ]);
    return;
  }

  if (action === 'analyze') {
    await editMenu(chatId, msgId,
      `🔍 *Analyze ${repoFullName}*\n\nSend:\n\`/analyze ${repoFullName} your description\``,
      [[btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))]]
    );
    return;
  }

  if (action === 'fix') {
    await editMenu(chatId, msgId,
      `🔧 *Fix ${repoFullName}*\n\nSend:\n\`/fix ${repoFullName} your description\``,
      [[btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))]]
    );
    return;
  }
}

// ─── GitHub File Browser ────────────────────────────────────────────

async function handleGitHubBrowse(chatId: number, msgId: number, args: string) {
  const gh = new GitHubClient();
  if (!gh.isConfigured()) {
    await editMenu(chatId, msgId, '❌ GitHub not configured.', [[btn('⬅️ Back', 'm:dev')]]);
    return;
  }

  const colonIdx = args.indexOf(':');
  let repoFullName: string, path: string;

  if (colonIdx > 0) {
    repoFullName = args.slice(0, colonIdx);
    path = args.slice(colonIdx + 1);
  } else {
    const segs = args.split('/');
    if (segs.length >= 2) {
      repoFullName = segs.slice(0, 2).join('/');
      path = segs.length > 2 ? '/' + segs.slice(2).join('/') : '/';
    } else {
      repoFullName = args;
      path = '/';
    }
  }

  const [owner, repo] = repoFullName.split('/');
  const cleanPath = path === '/' ? '' : path.replace(/^\//, '');

  try {
    const contents = await (gh as any).listContents(owner, repo, cleanPath);
    const items: any[] = contents || [];

    if (items.length === 0) {
      await editMenu(chatId, msgId, `📂 *${repoFullName}${path}*\n\nEmpty directory.`, [
        [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
      ]);
      return;
    }

    items.sort((a: any, b: any) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });

    const rows: any[][] = [];
    const display = items.slice(0, 8);

    for (const item of display) {
      const itemPath = cleanPath ? `${cleanPath}/${item.name}` : item.name;
      if (item.type === 'dir') {
        rows.push([btn(`📁 ${item.name}`, safeData('gb', repoFullName, itemPath))]);
      } else {
        rows.push([btn(`📄 ${item.name}`, safeData('gf', repoFullName, itemPath))]);
      }
    }

    if (cleanPath) {
      const parent = cleanPath.includes('/')
        ? cleanPath.slice(0, cleanPath.lastIndexOf('/'))
        : '/';
      rows.unshift([btn('⬆️ ..', safeData('gb', repoFullName, parent))]);
    }

    rows.push([btn('⬅️ Repo', safeData('ga', repoFullName, 'menu'))]);

    await editMenu(chatId, msgId, `📂 *${repoFullName}/${cleanPath || ''}*`, rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  }
}

// ─── GitHub File Read ───────────────────────────────────────────────

async function handleGitHubFile(chatId: number, msgId: number, args: string) {
  const gh = new GitHubClient();
  const colonIdx = args.indexOf(':');
  const repoFullName = colonIdx > 0 ? args.slice(0, colonIdx) : args;
  const path = colonIdx > 0 ? args.slice(colonIdx + 1) : '';
  const [owner, repo] = repoFullName.split('/');

  try {
    const content = await (gh as any).getFileContent(owner, repo, path);
    const text = `📄 *${path}*\n\n\`\`\`\n${truncate(content, 3500)}\n\`\`\``;
    await editMenu(chatId, msgId, text, [
      [btn('⬅️ Back', safeData('gb', repoFullName, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/'))],
    ]);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  }
}

// ─── GitHub Issues ──────────────────────────────────────────────────

async function handleGitHubIssues(chatId: number, msgId: number, args: string) {
  const colonIdx = args.lastIndexOf(':');
  const repoFullName = colonIdx > 0 ? args.slice(0, colonIdx) : args;
  const page = colonIdx > 0 ? parseInt(args.slice(colonIdx + 1)) || 0 : 0;
  const [owner, repo] = repoFullName.split('/');

  const gh = new GitHubClient();
  try {
    const issues = await (gh as any).listIssues(owner, repo, page);
    const list: any[] = issues || [];

    if (list.length === 0) {
      await editMenu(chatId, msgId, `🐛 *${repoFullName} Issues*\n\nNo open issues.`, [
        [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
      ]);
      return;
    }

    const text = `🐛 *${repoFullName} Issues*\n\n` + list.slice(0, 5).map((i: any) =>
      `#${i.number} ${i.title}\n_${i.state} • ${i.created_at}_`
    ).join('\n\n');

    await editMenu(chatId, msgId, truncate(text), [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  }
}

// ─── GitHub Commits ─────────────────────────────────────────────────

async function handleGitHubCommits(chatId: number, msgId: number, args: string) {
  const colonIdx = args.lastIndexOf(':');
  const repoFullName = colonIdx > 0 ? args.slice(0, colonIdx) : args;
  const page = colonIdx > 0 ? parseInt(args.slice(colonIdx + 1)) || 0 : 0;
  const [owner, repo] = repoFullName.split('/');

  const gh = new GitHubClient();
  try {
    const commits = await (gh as any).listCommits(owner, repo, page);
    const list: any[] = commits || [];

    if (list.length === 0) {
      await editMenu(chatId, msgId, `📝 *${repoFullName} Commits*\n\nNo commits.`, [
        [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
      ]);
      return;
    }

    const text = `📝 *${repoFullName} Commits*\n\n` + list.slice(0, 5).map((c: any) => {
      const msg = c.commit?.message?.split('\n')[0] || 'no message';
      const sha = (c.sha || '').slice(0, 7);
      return `\`${sha}\` ${msg}\n_${c.commit?.author?.date}_`;
    }).join('\n\n');

    await editMenu(chatId, msgId, truncate(text), [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  }
}

// ─── GitHub PRs ─────────────────────────────────────────────────────

async function handleGitHubPRs(chatId: number, msgId: number, args: string) {
  const colonIdx = args.lastIndexOf(':');
  const repoFullName = colonIdx > 0 ? args.slice(0, colonIdx) : args;
  const page = colonIdx > 0 ? parseInt(args.slice(colonIdx + 1)) || 0 : 0;
  const [owner, repo] = repoFullName.split('/');

  const gh = new GitHubClient();
  try {
    const prs = await (gh as any).listPRs(owner, repo, page);
    const list: any[] = prs || [];

    if (list.length === 0) {
      await editMenu(chatId, msgId, `🔀 *${repoFullName} PRs*\n\nNo open PRs.`, [
        [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
      ]);
      return;
    }

    const text = `🔀 *${repoFullName} PRs*\n\n` + list.slice(0, 5).map((p: any) =>
      `#${p.number} ${p.title}\n_${p.state} • ${p.head?.ref} → ${p.base?.ref}_`
    ).join('\n\n');

    await editMenu(chatId, msgId, truncate(text), [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  }
}

// ─── Netlify Sites (paginated) ──────────────────────────────────────

async function handleNetlifyList(chatId: number, msgId: number, args: string) {
  const nf = new NetlifyClient();
  if (!nf.isConfigured()) {
    await editMenu(chatId, msgId,
      '❌ *Netlify not configured*\n\nSet `NETLIFY_AUTH_TOKEN` env var on Render.',
      [[btn('⬅️ Back', 'm:dev')]]
    );
    return;
  }

  const page = parseInt(args) || 0;
  const perPage = 5;

  try {
    const result = await (nf as any).listSites(page, perPage);
    const sites: any[] = result.sites || result || [];
    const totalPages = result.totalPages || 1;

    if (sites.length === 0) {
      await editMenu(chatId, msgId, '🌐 *Netlify Sites*\n\nNo sites found.', [
        [btn('⬅️ Back', 'm:dev')],
      ]);
      return;
    }

    const rows: any[][] = sites.map((s: any) => {
      return [btn(`🌐 ${s.name || s.id}`, safeData('nd', s.id))];
    });

    if (totalPages > 1) {
      rows.push(paginationRow('nl', page, totalPages));
    }
    rows.push([btn('⬅️ Back', 'm:dev')]);

    const header = `🌐 *Netlify Sites* (${page + 1}/${totalPages})\n\n` +
      sites.map((s: any) => `• ${s.name || s.id}\n  ${s.ssl_url || s.url || 'no url'}`).join('\n');

    await editMenu(chatId, msgId, truncate(header), rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [[btn('⬅️ Back', 'm:dev')]]);
  }
}

// ─── Netlify Deploy ─────────────────────────────────────────────────

async function handleNetlifyDeploy(chatId: number, msgId: number, siteId: string, cbId: string) {
  const nf = new NetlifyClient();
  if (!nf.isConfigured()) {
    await editMenu(chatId, msgId, '❌ Netlify not configured.', [[btn('⬅️ Back', 'nl:0')]]);
    return;
  }

  try {
    await editMenu(chatId, msgId, `🚀 *Deploying to Netlify…*\n\nSite: \`${siteId}\`\nPlease wait.`, [
      [btn('⬅️ Back', 'nl:0')],
    ]);

    const deploy = await (nf as any).triggerDeploy(siteId);
    const deployId = deploy?.id || 'unknown';

    await editMenu(chatId, msgId,
      `✅ *Deploy triggered!*\n\nSite: \`${siteId}\`\nDeploy: \`${deployId}\`\n\nCheck Netlify dashboard for progress.`,
      [[btn('🌐 Sites', 'nl:0'), btn('⬅️ Back', 'm:dev')]]
    );
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ Deploy failed: ${err.message}`, [
      [btn('⬅️ Back', 'nl:0')],
    ]);
  }
}

// ─── CRM Prospects ──────────────────────────────────────────────────

async function handleCRMList(chatId: number, msgId: number, args: string) {
  const page = parseInt(args) || 0;
  const perPage = 5;
  const sb = getSupabaseClient();

  try {
    const { data, count } = await sb
      .from('prospects')
      .select('id, name, company, status', { count: 'exact' })
      .range(page * perPage, (page + 1) * perPage - 1)
      .order('created_at', { ascending: false });

    const prospects: any[] = (data as any[]) || [];
    const totalPages = Math.ceil((count || 0) / perPage) || 1;

    if (prospects.length === 0) {
      await editMenu(chatId, msgId, '👥 *Prospects*\n\nNo prospects yet.\nUse `/addprospect` to add.', [
        [btn('⬅️ Back', 'm:crm')],
      ]);
      return;
    }

    const text = `👥 *Prospects* (${page + 1}/${totalPages})\n\n` +
      prospects.map((p: any) =>
        `${p.status === 'contacted' ? '📧' : p.status === 'replied' ? '💬' : '🆕'} *${p.name}*\n${p.company || '—'} • ${p.status}`
      ).join('\n\n');

    const rows: any[][] = prospects.map((p: any) => [
      btn('✅', safeData('ca', String(p.id), 'contacted')),
      btn('💬', safeData('ca', String(p.id), 'replied')),
      btn('🎉', safeData('ca', String(p.id), 'won')),
    ]);

    if (totalPages > 1) rows.push(paginationRow('cr', page, totalPages));
    rows.push([btn('⬅️ Back', 'm:crm')]);

    await editMenu(chatId, msgId, truncate(text), rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [[btn('⬅️ Back', 'm:crm')]]);
  }
}

// ─── CRM Action ─────────────────────────────────────────────────────

async function handleCRMAction(chatId: number, msgId: number, args: string, cbId: string) {
  const parts = args.split(':');
  if (parts.length < 2) return;
  const prospectId = parts[0];
  const newStatus = parts[1];

  const sb = getSupabaseClient();
  try {
    await sb.from('prospects').update({ status: newStatus }).eq('id', prospectId);
    await answerCallbackQuery(cbId, `✅ Status → ${newStatus}`).catch(() => {});
    await handleCRMList(chatId, msgId, '0');
  } catch (err: any) {
    await answerCallbackQuery(cbId, `❌ ${err.message}`).catch(() => {});
  }
}

// ─── Outreach Drafts ────────────────────────────────────────────────

async function handleOutreachList(chatId: number, msgId: number, args: string) {
  const page = parseInt(args) || 0;
  const sb = getSupabaseClient();

  try {
    const { data } = await sb
      .from('outreach')
      .select('id, prospect_name, status, created_at')
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .range(page * 5, (page + 1) * 5 - 1);

    const drafts: any[] = (data as any[]) || [];

    if (drafts.length === 0) {
      await editMenu(chatId, msgId, '📝 *Drafts*\n\nNo drafts.\nUse `/draft` to create.', [
        [btn('⬅️ Back', 'm:outreach')],
      ]);
      return;
    }

    const text = `📝 *Drafts*\n\n` + drafts.map((d: any) =>
      `📧 ${d.prospect_name || 'Unknown'}\n_${d.created_at}_`
    ).join('\n\n');

    await editMenu(chatId, msgId, truncate(text), [
      [btn('⬅️ Back', 'm:outreach')],
    ]);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [[btn('⬅️ Back', 'm:outreach')]]);
  }
}

// ─── Deploy Menu ────────────────────────────────────────────────────

async function handleDeploy(chatId: number, msgId: number, args: string, cbId: string) {
  if (args === 'menu') {
    await editMenu(chatId, msgId, '🚀 *Deploy*', [
      [btn('▲ Render', 'dp:render'), btn('🌐 Netlify', 'dp:netlify')],
      [btn('⬅️ Back', 'm:main')],
    ]);
    return;
  }

  if (args === 'render') {
    const rc = new RenderClient();
    if (!rc.isConfigured()) {
      await editMenu(chatId, msgId, '❌ Render not configured.\nSet RENDER_API_KEY + RENDER_SERVICE_ID.', [
        [btn('⬅️ Back', 'dp:menu')],
      ]);
      return;
    }

    await editMenu(chatId, msgId, '▲ *Deploy to Render?*\n\nThis will trigger a new deploy.', [
      [btn('✅ Confirm', 'cf:deploy:render'), btn('❌ Cancel', 'dp:menu')],
    ]);
    return;
  }

  if (args === 'netlify') {
    await handleNetlifyList(chatId, msgId, '0');
    return;
  }
}

// ─── New Site Builder ───────────────────────────────────────────────

async function handleNewSite(chatId: number, msgId: number, args: string, cbId: string) {
  if (args === 'start') {
    await editMenu(chatId, msgId,
      '🆕 *New Site Builder*\n\nSend a message describing the site you want:\n\n' +
      '_Example:_\n"A portfolio site for a photographer with gallery and contact form"\n\n' +
      'I will:\n1. Generate HTML with Gemini\n2. Create a GitHub repo\n3. Deploy to Netlify',
      [[btn('⬅️ Back', 'm:dev')]]
    );
    return;
  }
}

// ─── Watch CI ───────────────────────────────────────────────────────

async function handleWatchCI(chatId: number, msgId: number, args: string, cbId: string) {
  const repoFullName = args;
  const [owner, repo] = repoFullName.split('/');

  if (!owner || !repo) {
    await editMenu(chatId, msgId, '❌ Invalid repo.\nUse `/watch owner/repo`', [
      [btn('⬅️ Back', 'm:dev')],
    ]);
    return;
  }

  const gh = new GitHubClient();
  if (!gh.isConfigured()) {
    await editMenu(chatId, msgId, '❌ GitHub not configured.', [[btn('⬅️ Back', 'm:dev')]]);
    return;
  }

  try {
    await editMenu(chatId, msgId, `👁 *Checking CI for ${repoFullName}…*`, []);

    const token = process.env.GITHUB_TOKEN;
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=3`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );

    if (!res.ok) {
      await editMenu(chatId, msgId,
        `⚠️ *CI Status: ${repoFullName}*\n\nNo GitHub Actions found or API error (${res.status}).\n\n` +
        `This repo may not have workflows configured yet.`,
        [[btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))]]
      );
      return;
    }

    const data = await res.json() as any;
    const runs: any[] = data.workflow_runs || [];

    if (runs.length === 0) {
      await editMenu(chatId, msgId,
        `⚠️ *CI: ${repoFullName}*\n\nNo workflow runs found.\nAdd a \`.github/workflows/\` file to enable CI.`,
        [[btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))]]
      );
      return;
    }

    const text = `👁 *CI: ${repoFullName}*\n\n` + runs.map((r: any) => {
      const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : r.status === 'in_progress' ? '🔄' : '⏳';
      return `${icon} *${r.name}*\n${r.head_branch} • ${r.conclusion || r.status}\n_${r.created_at}_`;
    }).join('\n\n');

    const failedRun = runs.find((r: any) => r.conclusion === 'failure');
    const rows: any[][] = [[btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))]];

    if (failedRun) {
      rows.unshift([btn('🔧 Auto-fix', safeData('ga', repoFullName, 'fix'))]);
    }

    await editMenu(chatId, msgId, truncate(text), rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, `❌ ${err.message}`, [
      [btn('⬅️ Back', safeData('ga', repoFullName, 'menu'))],
    ]);
  }
}

// ─── Confirm Actions ────────────────────────────────────────────────

async function handleConfirm(chatId: number, msgId: number, args: string, cbId: string) {
  const parts = args.split(':');
  const action = parts[0];
  const target = parts.slice(1).join(':');

  if (action === 'deploy' && target === 'render') {
    const rc = new RenderClient();
    try {
      await editMenu(chatId, msgId, '▲ *Deploying to Render…*', []);
      const serviceId = process.env.RENDER_SERVICE_ID;
      if (!serviceId) throw new Error('RENDER_SERVICE_ID not set');
      const deploy = await (rc as any).triggerDeploy(serviceId);
      await editMenu(chatId, msgId,
        `✅ *Render deploy triggered!*\n\nDeploy ID: \`${deploy?.id || 'unknown'}\`\n\nMonitor at render.com/dashboard`,
        [[btn('🚀 Deploy', 'dp:menu'), btn('⬅️ Home', 'm:main')]]
      );
    } catch (err: any) {
      await editMenu(chatId, msgId, `❌ Deploy failed: ${err.message}`, [
        [btn('⬅️ Back', 'dp:menu')],
      ]);
    }
    return;
  }

  await editMenu(chatId, msgId, '✅ Action confirmed.', [[btn('⬅️ Home', 'm:main')]]);
}
