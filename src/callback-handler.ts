import { sendMessage, editMessageText, answerCallbackQuery } from './telegram.js';
import { editMenu, btn } from './ui-engine.js';

async function getSupabase() {
  const mod = await import('./supabase.js');
  const fn = (mod as any).getSupabaseClient || (mod as any).getClient ||
    (mod as any).createClient || (mod as any).supabase || (mod as any).default;
  return typeof fn === 'function' ? fn() : fn;
}

async function getGitHubClient(): Promise<any> {
  try {
    const mod = await import('./github-client.js');
    for (const key of Object.keys(mod)) {
      const val = (mod as any)[key];
      if (typeof val === 'function') {
        try {
          const inst = new val();
          if (inst.listRepos || inst.getRepos || inst.repos) return inst;
        } catch {
          try {
            const inst = val();
            if (inst && typeof inst === 'object') return inst;
          } catch { /* skip */ }
        }
      }
      if (typeof val === 'object' && val !== null) {
        if ((val as any).listRepos || (val as any).getRepos) return val;
      }
    }
    if (mod.default) {
      if (typeof mod.default === 'function') {
        try { return new (mod.default as any)(); } catch {
          try { return (mod.default as any)(); } catch { /* skip */ }
        }
      }
      if (typeof mod.default === 'object') return mod.default;
    }
  } catch { /* fallback below */ }

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  const h = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };

  return {
    isConfigured: () => true,
    async listRepos(page = 0, perPage = 10) {
      const r = await fetch('https://api.github.com/user/repos?per_page=' + perPage + '&page=' + (page + 1) + '&sort=updated', { headers: h });
      if (!r.ok) throw new Error('GitHub API ' + r.status);
      return { repos: await r.json(), totalPages: 10 };
    },
    async listContents(owner: string, repo: string, path: string) {
      const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path, { headers: h });
      if (!r.ok) throw new Error('GitHub API ' + r.status);
      return await r.json();
    },
    async getFileContent(owner: string, repo: string, path: string) {
      const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json' } });
      if (!r.ok) throw new Error('GitHub API ' + r.status);
      return await r.text();
    },
    async listIssues(owner: string, repo: string, page = 0) {
      const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/issues?state=open&per_page=5&page=' + (page + 1), { headers: h });
      if (!r.ok) throw new Error('GitHub API ' + r.status);
      return await r.json();
    },
    async listCommits(owner: string, repo: string, page = 0) {
      const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/commits?per_page=5&page=' + (page + 1), { headers: h });
      if (!r.ok) throw new Error('GitHub API ' + r.status);
      return await r.json();
    },
    async listPRs(owner: string, repo: string, page = 0) {
      const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/pulls?state=open&per_page=5&page=' + (page + 1), { headers: h });
      if (!r.ok) throw new Error('GitHub API ' + r.status);
      return await r.json();
    },
  };
}

async function getNetlifyClient(): Promise<any> {
  try {
    const mod = await import('./netlify-client.js');
    for (const key of Object.keys(mod)) {
      const val = (mod as any)[key];
      if (typeof val === 'function') {
        try {
          const inst = new val();
          if (inst.listSites || inst.getSites) return inst;
        } catch {
          try {
            const inst = val();
            if (inst && typeof inst === 'object') return inst;
          } catch { /* skip */ }
        }
      }
      if (typeof val === 'object' && val !== null) {
        if ((val as any).listSites || (val as any).getSites) return val;
      }
    }
    if (mod.default) {
      if (typeof mod.default === 'function') {
        try { return new (mod.default as any)(); } catch {
          try { return (mod.default as any)(); } catch { /* skip */ }
        }
      }
      if (typeof mod.default === 'object') return mod.default;
    }
  } catch { /* fallback below */ }

  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN not set');
  const h = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  return {
    isConfigured: () => true,
    async listSites(page = 0, perPage = 10) {
      const r = await fetch('https://api.netlify.com/api/v1/sites?per_page=' + perPage + '&page=' + (page + 1), { headers: h });
      if (!r.ok) throw new Error('Netlify API ' + r.status);
      return { sites: await r.json(), totalPages: 10 };
    },
    async triggerDeploy(siteId: string) {
      const r = await fetch('https://api.netlify.com/api/v1/sites/' + siteId + '/deploys', { method: 'POST', headers: h });
      if (!r.ok) throw new Error('Netlify API ' + r.status);
      return await r.json();
    },
  };
}

async function setSession(chatId: number, userId: number, workflow: string, state: any) {
  try {
    const sb = await getSupabase();
    await sb.from('bot_sessions').upsert({
      chat_id: chatId, user_id: userId, workflow: workflow,
      state: state, updated_at: new Date().toISOString(),
    });
  } catch (e) { console.error('setSession failed:', e); }
}

function truncate(s: string, max = 3800): string {
  return s.length <= max ? s : s.slice(0, max) + '\n\n... (truncated)';
}

function safeData(prefix: string, ...parts: string[]): string {
  const raw = [prefix].concat(parts).join(':');
  if (raw.length <= 64) return raw;
  const head = [prefix].concat(parts.slice(0, -1)).join(':') + ':';
  const avail = 64 - head.length;
  if (avail < 4) return prefix + ':err';
  return head + parts[parts.length - 1].slice(-avail);
}

function paginationRow(prefix: string, page: number, total: number): any[] {
  const row: any[] = [];
  if (page > 0) row.push(btn('<', prefix + ':' + (page - 1)));
  row.push(btn((page + 1) + '/' + total, 'm:noop'));
  if (page < total - 1) row.push(btn('>', prefix + ':' + (page + 1)));
  return row;
}

export async function handleCallback(update: any): Promise<void> {
  const cb = update.callback_query;
  if (!cb) return;
  const chatId: number = cb.message.chat.id;
  const msgId: number = cb.message.message_id;
  const data: string = cb.data || '';
  const cbId: string = cb.id;
  const userId: number = cb.from ? cb.from.id : chatId;
  await answerCallbackQuery(cbId, '...').catch(function() {});

  try {
    const ci = data.indexOf(':');
    const prefix = ci > 0 ? data.slice(0, ci) : data;
    const args = ci > 0 ? data.slice(ci + 1) : '';

    if (prefix === 'm') await handleMenu(chatId, msgId, args);
    else if (prefix === 'gr') await handleGitHubRepos(chatId, msgId, args);
    else if (prefix === 'ga') await handleGitHubAction(chatId, msgId, args);
    else if (prefix === 'gb') await handleGitHubBrowse(chatId, msgId, args);
    else if (prefix === 'gf') await handleGitHubFile(chatId, msgId, args);
    else if (prefix === 'gi') await handleGitHubIssues(chatId, msgId, args);
    else if (prefix === 'gc') await handleGitHubCommits(chatId, msgId, args);
    else if (prefix === 'gp') await handleGitHubPRs(chatId, msgId, args);
    else if (prefix === 'nl') await handleNetlifyList(chatId, msgId, args);
    else if (prefix === 'nd') await handleNetlifyDeploy(chatId, msgId, args, cbId);
    else if (prefix === 'cr') await handleCRMList(chatId, msgId, args);
    else if (prefix === 'ca') await handleCRMAction(chatId, msgId, args, cbId);
    else if (prefix === 'ol') await handleOutreachList(chatId, msgId, args);
    else if (prefix === 'dp') await handleDeploy(chatId, msgId, args, cbId);
    else if (prefix === 'ns') await handleNewSite(chatId, msgId, args, cbId, userId);
    else if (prefix === 'wt') await handleWatchCI(chatId, msgId, args);
    else if (prefix === 'cf') await handleConfirm(chatId, msgId, args);
    else await answerCallbackQuery(cbId, 'Unknown').catch(function() {});
  } catch (err: any) {
    console.error('Callback error:', err.message);
    await sendMessage(chatId, 'Error: ' + err.message).catch(function() {});
  }
}

async function handleMenu(chatId: number, msgId: number, target: string) {
  if (target === 'main') {
    await editMenu(chatId, msgId, 'XTOP Career Agent', [
      [btn('Jobs', 'm:jobs'), btn('CRM', 'm:crm')],
      [btn('Outreach', 'm:outreach'), btn('Dev Tools', 'm:dev')],
      [btn('Deploy', 'dp:menu'), btn('Infra', 'm:infra')],
      [btn('Tasks', 'm:tasks'), btn('Status', 'm:status')],
    ]);
  } else if (target === 'dev') {
    await editMenu(chatId, msgId, 'Dev Tools', [
      [btn('Repos', 'gr:0'), btn('Netlify', 'nl:0')],
      [btn('Analyze', 'm:analyze_hint'), btn('Fix', 'm:fix_hint')],
      [btn('Watch CI', 'm:watch_hint'), btn('New Site', 'ns:start')],
      [btn('Back', 'm:main')],
    ]);
  } else if (target === 'crm') {
    await editMenu(chatId, msgId, 'CRM', [
      [btn('Prospects', 'cr:0'), btn('Add', 'm:addprospect_hint')],
      [btn('Back', 'm:main')],
    ]);
  } else if (target === 'outreach') {
    await editMenu(chatId, msgId, 'Outreach', [
      [btn('Drafts', 'ol:0'), btn('Sent', 'm:sent_hint')],
      [btn('Back', 'm:main')],
    ]);
  } else if (target === 'infra') {
    await editMenu(chatId, msgId, 'Infrastructure', [
      [btn('GitHub', 'm:gh_status'), btn('Render', 'm:render_status')],
      [btn('Database', 'm:db_status'), btn('Netlify', 'nl:0')],
      [btn('Back', 'm:main')],
    ]);
  } else if (target === 'jobs') {
    await editMenu(chatId, msgId, 'Jobs', [
      [btn('Discover', 'm:discover_hint'), btn('Leads', 'm:leads_hint')],
      [btn('Back', 'm:main')],
    ]);
  } else if (target === 'tasks') {
    try {
      const sb = await getSupabase();
      const res = await sb.from('tasks').select('id, type, status, created_at').order('created_at', { ascending: false }).limit(10);
      const list = (res.data as any[]) || [];
      const text = list.length === 0 ? 'No tasks yet.' : 'Recent Tasks\n\n' + list.map(function(t: any) {
        return t.type + ' - ' + t.status;
      }).join('\n');
      await editMenu(chatId, msgId, text, [[btn('Back', 'm:main')]]);
    } catch {
      await editMenu(chatId, msgId, 'Tasks - could not load.', [[btn('Back', 'm:main')]]);
    }
  } else if (target === 'status') {
    await editMenu(chatId, msgId, 'Use /status for full report.', [[btn('Back', 'm:main')]]);
  } else if (target === 'analyze_hint') {
    await editMenu(chatId, msgId, 'Send: /analyze owner/repo description', [[btn('Back', 'm:dev')]]);
  } else if (target === 'fix_hint') {
    await editMenu(chatId, msgId, 'Send: /fix owner/repo description', [[btn('Back', 'm:dev')]]);
  } else if (target === 'watch_hint') {
    await editMenu(chatId, msgId, 'Send: /watch owner/repo', [[btn('Back', 'm:dev')]]);
  } else if (target === 'addprospect_hint') {
    await editMenu(chatId, msgId, 'Send: /addprospect Name | Company | Email', [[btn('Back', 'm:crm')]]);
  } else if (target === 'discover_hint') {
    await editMenu(chatId, msgId, 'Send /discover to find leads.', [[btn('Back', 'm:jobs')]]);
  } else if (target === 'leads_hint') {
    await editMenu(chatId, msgId, 'Send /report for latest leads.', [[btn('Back', 'm:jobs')]]);
  } else if (target === 'sent_hint') {
    await editMenu(chatId, msgId, 'Use /outreach to see sent.', [[btn('Back', 'm:outreach')]]);
  } else if (target === 'gh_status') {
    var ghOk = !!process.env.GITHUB_TOKEN;
    await editMenu(chatId, msgId, 'GitHub: ' + (ghOk ? 'Connected' : 'Not configured'), [[btn('Repos', 'gr:0'), btn('Back', 'm:infra')]]);
  } else if (target === 'render_status') {
    var rOk = !!process.env.RENDER_API_KEY;
    await editMenu(chatId, msgId, 'Render: ' + (rOk ? 'Connected' : 'Not configured'), [[btn('Deploy', 'dp:render'), btn('Back', 'm:infra')]]);
  } else if (target === 'db_status') {
    try {
      const sb = await getSupabase();
      const res = await sb.from('tasks').select('id').limit(1);
      await editMenu(chatId, msgId, 'Supabase: ' + (res.error ? 'Error' : 'Connected'), [[btn('Back', 'm:infra')]]);
    } catch (e: any) {
      await editMenu(chatId, msgId, 'Supabase: Error', [[btn('Back', 'm:infra')]]);
    }
  } else if (target === 'noop') {
    // do nothing
  } else {
    await editMenu(chatId, msgId, 'XTOP Agent', [[btn('Home', 'm:main')]]);
  }
}

async function handleGitHubRepos(chatId: number, msgId: number, args: string) {
  var gh: any;
  try {
    gh = await getGitHubClient();
  } catch (e: any) {
    var hasToken = !!process.env.GITHUB_TOKEN;
    await editMenu(chatId, msgId, 'GitHub Error\nToken: ' + (hasToken ? 'Yes' : 'No') + '\n' + (e.message || '').slice(0, 200), [[btn('Back', 'm:dev')]]);
    return;
  }
  var page = parseInt(args) || 0;
  try {
    var result = await gh.listRepos(page, 5);
    var repos: any[] = result.repos || result || [];
    var totalPages = result.totalPages || 1;
    if (repos.length === 0) {
      await editMenu(chatId, msgId, 'No repos found.', [[btn('Back', 'm:dev')]]);
      return;
    }
    var rows: any[][] = repos.map(function(r: any) {
      var name = r.full_name || r.name;
      return [btn(name, safeData('ga', name, 'menu'))];
    });
    if (totalPages > 1) rows.push(paginationRow('gr', page, totalPages));
    rows.push([btn('Back', 'm:dev')]);
    await editMenu(chatId, msgId, 'GitHub Repos (' + (page + 1) + '/' + totalPages + ')', rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', 'm:dev')]]);
  }
}

async function handleGitHubAction(chatId: number, msgId: number, args: string) {
  var parts = args.split(':');
  if (parts.length < 2) {
    await editMenu(chatId, msgId, 'Invalid.', [[btn('Back', 'gr:0')]]);
    return;
  }
  var repoFullName = parts[0];
  var action = parts.slice(1).join(':');
  if (action === 'menu') {
    await editMenu(chatId, msgId, repoFullName, [
      [btn('Files', safeData('gb', repoFullName, '/')), btn('Issues', safeData('gi', repoFullName, '0'))],
      [btn('PRs', safeData('gp', repoFullName, '0')), btn('Commits', safeData('gc', repoFullName, '0'))],
      [btn('Analyze', safeData('ga', repoFullName, 'analyze')), btn('Fix', safeData('ga', repoFullName, 'fix'))],
      [btn('Watch CI', safeData('wt', repoFullName))],
      [btn('Repos', 'gr:0')],
    ]);
  } else if (action === 'analyze') {
    await editMenu(chatId, msgId, 'Send: /analyze ' + repoFullName + ' description', [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  } else if (action === 'fix') {
    await editMenu(chatId, msgId, 'Send: /fix ' + repoFullName + ' description', [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  }
}

async function handleGitHubBrowse(chatId: number, msgId: number, args: string) {
  var gh: any;
  try { gh = await getGitHubClient(); } catch {
    await editMenu(chatId, msgId, 'GitHub not configured.', [[btn('Back', 'm:dev')]]);
    return;
  }
  var ci = args.indexOf(':');
  var repoFullName: string;
  var path: string;
  if (ci > 0) {
    repoFullName = args.slice(0, ci);
    path = args.slice(ci + 1);
  } else {
    var segs = args.split('/');
    repoFullName = segs.slice(0, 2).join('/');
    path = segs.length > 2 ? '/' + segs.slice(2).join('/') : '/';
  }
  var parts = repoFullName.split('/');
  var owner = parts[0];
  var repo = parts[1];
  var cleanPath = path === '/' ? '' : path.replace(/^\//, '');
  try {
    var contents = await gh.listContents(owner, repo, cleanPath);
    var items: any[] = contents || [];
    if (items.length === 0) {
      await editMenu(chatId, msgId, repoFullName + '/' + path + ' - Empty.', [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
      return;
    }
    items.sort(function(a: any, b: any) {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
    var rows: any[][] = [];
    var display = items.slice(0, 8);
    for (var i = 0; i < display.length; i++) {
      var item = display[i];
      var itemPath = cleanPath ? cleanPath + '/' + item.name : item.name;
      if (item.type === 'dir') {
        rows.push([btn('[D] ' + item.name, safeData('gb', repoFullName, itemPath))]);
      } else {
        rows.push([btn(item.name, safeData('gf', repoFullName, itemPath))]);
      }
    }
    if (cleanPath) {
      var parent = cleanPath.indexOf('/') >= 0 ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) : '/';
      rows.unshift([btn('..', safeData('gb', repoFullName, parent))]);
    }
    rows.push([btn('Back', safeData('ga', repoFullName, 'menu'))]);
    await editMenu(chatId, msgId, repoFullName + '/' + cleanPath, rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  }
}

async function handleGitHubFile(chatId: number, msgId: number, args: string) {
  var gh = await getGitHubClient();
  var ci = args.indexOf(':');
  var repoFullName = ci > 0 ? args.slice(0, ci) : args;
  var path = ci > 0 ? args.slice(ci + 1) : '';
  var parts = repoFullName.split('/');
  try {
    var content = await gh.getFileContent(parts[0], parts[1], path);
    await editMenu(chatId, msgId, path + '\n\n' + truncate(content, 3500), [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  }
}

async function handleGitHubIssues(chatId: number, msgId: number, args: string) {
  var ci = args.lastIndexOf(':');
  var repoFullName = ci > 0 ? args.slice(0, ci) : args;
  var parts = repoFullName.split('/');
  var gh = await getGitHubClient();
  try {
    var issues = await gh.listIssues(parts[0], parts[1], 0);
    var list: any[] = issues || [];
    if (list.length === 0) {
      await editMenu(chatId, msgId, repoFullName + ' - No open issues.', [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
      return;
    }
    var text = repoFullName + ' Issues\n\n' + list.slice(0, 5).map(function(i: any) {
      return '#' + i.number + ' ' + i.title;
    }).join('\n');
    await editMenu(chatId, msgId, truncate(text), [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  }
}

async function handleGitHubCommits(chatId: number, msgId: number, args: string) {
  var ci = args.lastIndexOf(':');
  var repoFullName = ci > 0 ? args.slice(0, ci) : args;
  var parts = repoFullName.split('/');
  var gh = await getGitHubClient();
  try {
    var commits = await gh.listCommits(parts[0], parts[1], 0);
    var list: any[] = commits || [];
    if (list.length === 0) {
      await editMenu(chatId, msgId, repoFullName + ' - No commits.', [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
      return;
    }
    var text = repoFullName + ' Commits\n\n' + list.slice(0, 5).map(function(c: any) {
      var msg = c.commit && c.commit.message ? c.commit.message.split('\n')[0] : 'no message';
      return (c.sha || '').slice(0, 7) + ' ' + msg;
    }).join('\n');
    await editMenu(chatId, msgId, truncate(text), [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  }
}

async function handleGitHubPRs(chatId: number, msgId: number, args: string) {
  var ci = args.lastIndexOf(':');
  var repoFullName = ci > 0 ? args.slice(0, ci) : args;
  var parts = repoFullName.split('/');
  var gh = await getGitHubClient();
  try {
    var prs = await gh.listPRs(parts[0], parts[1], 0);
    var list: any[] = prs || [];
    if (list.length === 0) {
      await editMenu(chatId, msgId, repoFullName + ' - No open PRs.', [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
      return;
    }
    var text = repoFullName + ' PRs\n\n' + list.slice(0, 5).map(function(p: any) {
      return '#' + p.number + ' ' + p.title;
    }).join('\n');
    await editMenu(chatId, msgId, truncate(text), [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', safeData('ga', repoFullName, 'menu'))]]);
  }
}

async function handleNetlifyList(chatId: number, msgId: number, args: string) {
  if (!process.env.NETLIFY_AUTH_TOKEN) {
    await editMenu(chatId, msgId, 'Netlify not configured. Set NETLIFY_AUTH_TOKEN.', [[btn('Back', 'm:dev')]]);
    return;
  }
  var page = parseInt(args) || 0;
  try {
    var nf = await getNetlifyClient();
    var result = await nf.listSites(page, 5);
    var sites: any[] = result.sites || result || [];
    var totalPages = result.totalPages || 1;
    if (sites.length === 0) {
      await editMenu(chatId, msgId, 'No Netlify sites.', [[btn('Back', 'm:dev')]]);
      return;
    }
    var rows: any[][] = sites.map(function(s: any) {
      return [btn(s.name || s.id, safeData('nd', s.id))];
    });
    if (totalPages > 1) rows.push(paginationRow('nl', page, totalPages));
    rows.push([btn('Back', 'm:dev')]);
    var header = 'Netlify Sites (' + (page + 1) + '/' + totalPages + ')\n\n' + sites.map(function(s: any) {
      return s.name + ' - ' + (s.ssl_url || s.url || 'no url');
    }).join('\n');
    await editMenu(chatId, msgId, truncate(header), rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', 'm:dev')]]);
  }
}

async function handleNetlifyDeploy(chatId: number, msgId: number, siteId: string, cbId: string) {
  if (!process.env.NETLIFY_AUTH_TOKEN) {
    await editMenu(chatId, msgId, 'Netlify not configured.', [[btn('Back', 'nl:0')]]);
    return;
  }
  try {
    await editMenu(chatId, msgId, 'Deploying ' + siteId + '...', []);
    var nf = await getNetlifyClient();
    var deploy = await nf.triggerDeploy(siteId);
    await editMenu(chatId, msgId, 'Deploy triggered! ' + (deploy.id || 'ok'), [[btn('Sites', 'nl:0'), btn('Back', 'm:dev')]]);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Deploy failed: ' + err.message, [[btn('Back', 'nl:0')]]);
  }
}

async function handleCRMList(chatId: number, msgId: number, args: string) {
  var page = parseInt(args) || 0;
  var sb = await getSupabase();
  try {
    var res = await sb.from('prospects').select('id, name, company, status', { count: 'exact' }).range(page * 5, (page + 1) * 5 - 1).order('created_at', { ascending: false });
    var prospects: any[] = (res.data as any[]) || [];
    var totalPages = Math.ceil((res.count || 0) / 5) || 1;
    if (prospects.length === 0) {
      await editMenu(chatId, msgId, 'No prospects. Use /addprospect.', [[btn('Back', 'm:crm')]]);
      return;
    }
    var text = 'Prospects (' + (page + 1) + '/' + totalPages + ')\n\n' + prospects.map(function(p: any) {
      return p.name + ' - ' + (p.company || '-') + ' (' + p.status + ')';
    }).join('\n');
    var rows: any[][] = prospects.map(function(p: any) {
      return [
        btn('Contacted', safeData('ca', String(p.id), 'contacted')),
        btn('Replied', safeData('ca', String(p.id), 'replied')),
        btn('Won', safeData('ca', String(p.id), 'won')),
      ];
    });
    if (totalPages > 1) rows.push(paginationRow('cr', page, totalPages));
    rows.push([btn('Back', 'm:crm')]);
    await editMenu(chatId, msgId, truncate(text), rows);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', 'm:crm')]]);
  }
}

async function handleCRMAction(chatId: number, msgId: number, args: string, cbId: string) {
  var parts = args.split(':');
  if (parts.length < 2) return;
  var sb = await getSupabase();
  try {
    await sb.from('prospects').update({ status: parts[1] }).eq('id', parts[0]);
    await answerCallbackQuery(cbId, 'Status updated').catch(function() {});
    await handleCRMList(chatId, msgId, '0');
  } catch (err: any) {
    await answerCallbackQuery(cbId, 'Error: ' + err.message).catch(function() {});
  }
}

async function handleOutreachList(chatId: number, msgId: number, args: string) {
  var sb = await getSupabase();
  try {
    var res = await sb.from('outreach').select('id, prospect_name, status, created_at').eq('status', 'draft').order('created_at', { ascending: false }).limit(5);
    var drafts: any[] = (res.data as any[]) || [];
    if (drafts.length === 0) {
      await editMenu(chatId, msgId, 'No drafts. Use /draft.', [[btn('Back', 'm:outreach')]]);
      return;
    }
    var text = 'Drafts\n\n' + drafts.map(function(d: any) {
      return d.prospect_name || 'Unknown';
    }).join('\n');
    await editMenu(chatId, msgId, truncate(text), [[btn('Back', 'm:outreach')]]);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', 'm:outreach')]]);
  }
}

async function handleDeploy(chatId: number, msgId: number, args: string, cbId: string) {
  if (args === 'menu') {
    await editMenu(chatId, msgId, 'Deploy', [
      [btn('Render', 'dp:render'), btn('Netlify', 'dp:netlify')],
      [btn('Back', 'm:main')],
    ]);
  } else if (args === 'render') {
    if (!process.env.RENDER_API_KEY) {
      await editMenu(chatId, msgId, 'Render not configured.', [[btn('Back', 'dp:menu')]]);
      return;
    }
    await editMenu(chatId, msgId, 'Deploy to Render?', [[btn('Confirm', 'cf:deploy:render'), btn('Cancel', 'dp:menu')]]);
  } else if (args === 'netlify') {
    await handleNetlifyList(chatId, msgId, '0');
  }
}

async function handleNewSite(chatId: number, msgId: number, args: string, cbId: string, userId: number) {
  if (args === 'start') {
    await setSession(chatId, userId, 'newsite', { step: 'describe' });
    await editMenu(chatId, msgId, 'New Site Builder\n\nSend a message describing the site you want.\n\nExample: A portfolio for a photographer', [[btn('Back', 'm:dev')]]);
  }
}

async function handleWatchCI(chatId: number, msgId: number, args: string) {
  var parts = args.split('/');
  if (parts.length < 2) {
    await editMenu(chatId, msgId, 'Use /watch owner/repo', [[btn('Back', 'm:dev')]]);
    return;
  }
  var token = process.env.GITHUB_TOKEN;
  if (!token) {
    await editMenu(chatId, msgId, 'GITHUB_TOKEN not set.', [[btn('Back', 'm:dev')]]);
    return;
  }
  try {
    await editMenu(chatId, msgId, 'Checking CI for ' + args + '...', []);
    var res = await fetch('https://api.github.com/repos/' + args + '/actions/runs?per_page=3', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      await editMenu(chatId, msgId, 'CI: ' + args + ' - API error ' + res.status, [[btn('Back', safeData('ga', args, 'menu'))]]);
      return;
    }
    var data = await res.json() as any;
    var runs: any[] = data.workflow_runs || [];
    if (runs.length === 0) {
      await editMenu(chatId, msgId, 'CI: ' + args + ' - No workflow runs.', [[btn('Back', safeData('ga', args, 'menu'))]]);
      return;
    }
    var text = 'CI: ' + args + '\n\n' + runs.map(function(r: any) {
      return r.name + ' - ' + (r.conclusion || r.status);
    }).join('\n');
    await editMenu(chatId, msgId, truncate(text), [[btn('Back', safeData('ga', args, 'menu'))]]);
  } catch (err: any) {
    await editMenu(chatId, msgId, 'Error: ' + err.message, [[btn('Back', safeData('ga', args, 'menu'))]]);
  }
}

async function handleConfirm(chatId: number, msgId: number, args: string) {
  var parts = args.split(':');
  if (parts[0] === 'deploy' && parts[1] === 'render') {
    try {
      await editMenu(chatId, msgId, 'Deploying to Render...', []);
      var serviceId = process.env.RENDER_SERVICE_ID;
      var apiKey = process.env.RENDER_API_KEY;
      if (!serviceId || !apiKey) throw new Error('RENDER vars not set');
      var res = await fetch('https://api.render.com/v1/services/' + serviceId + '/deploys', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
      });
      var deploy = await res.json() as any;
      await editMenu(chatId, msgId, 'Render deploy triggered! ' + (deploy.id || 'ok'), [[btn('Deploy', 'dp:menu'), btn('Home', 'm:main')]]);
    } catch (err: any) {
      await editMenu(chatId, msgId, 'Deploy failed: ' + err.message, [[btn('Back', 'dp:menu')]]);
    }
    return;
  }
  await editMenu(chatId, msgId, 'Confirmed.', [[btn('Home', 'm:main')]]);
}
