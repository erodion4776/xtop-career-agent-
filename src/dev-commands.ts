import { sendMessage } from './telegram.js';

function getGhToken(): string {
  return process.env.GITHUB_TOKEN || '';
}

async function ghApi(path: string, method: string, body?: any): Promise<any> {
  var token = getGhToken();
  if (!token) throw new Error('GITHUB_TOKEN not set');
  var opts: any = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  var res = await fetch('https://api.github.com' + path, opts);
  var data: any = {};
  try { data = await res.json(); } catch(e: any) {}
  if (!res.ok) {
    throw new Error('GitHub ' + res.status + ': ' + JSON.stringify(data));
  }
  return data;
}

async function getRenderHeaders(): Promise<any> {
  var key = process.env.RENDER_API_KEY || '';
  if (!key) throw new Error('RENDER_API_KEY not set');
  return {
    'Authorization': 'Bearer ' + key,
    'Accept': 'application/json'
  };
}

export async function handleDevCommand(chatId: any, userId: any, command: any, args: any): Promise<void> {
  if (command === '/devstatus') {
    await handleDevStatus(chatId);
  } else if (command === '/repos') {
    await handleRepos(chatId, userId);
  } else if (command === '/browse') {
    await handleBrowse(chatId, args);
  } else if (command === '/readfile') {
    await handleReadFile(chatId, args);
  } else if (command === '/analyze') {
    await handleAnalyze(chatId, args);
  } else if (command === '/fix') {
    await handleFix(chatId, userId, args);
  } else if (command === '/watch') {
    await handleWatch(chatId, args);
  } else if (command === '/ci') {
    await handleCI(chatId, args);
  } else if (command === '/netlify') {
    await handleNetlify(chatId);
  } else if (command === '/deploy') {
    await handleDeploy(chatId, args);
  } else {
    await sendMessage(chatId, 'Unknown dev command: ' + command);
  }
}

async function handleDevStatus(chatId: any): Promise<void> {
  var lines: string[] = ['*Dev Agent Status*\n'];
  lines.push('GitHub Token: ' + (getGhToken() ? 'Yes' : 'No'));
  lines.push('Render API Key: ' + (process.env.RENDER_API_KEY ? 'Yes' : 'No'));
  lines.push('Netlify Token: ' + (process.env.NETLIFY_AUTH_TOKEN ? 'Yes' : 'No'));
  lines.push('Gemini Key: ' + (process.env.GEMINI_API_KEY ? 'Yes' : 'No'));
  lines.push('Gemini Model: ' + (process.env.GEMINI_MODEL || 'not set'));

  try {
    var repos: any = await ghApi('/user/repos?per_page=5&sort=updated', 'GET');
    lines.push('\nRecent repos:');
    for (var i = 0; i < repos.length; i++) {
      lines.push('- ' + repos[i].full_name);
    }
  } catch (e: any) {
    lines.push('\nGitHub API: ' + e.message);
  }

  try {
    var svcId = process.env.RENDER_SERVICE_ID || '';
    if (svcId) {
      var hdrs = await getRenderHeaders();
      var svc = await fetch('https://api.render.com/v1/services/' + svcId, { headers: hdrs });
      var svcData: any = await svc.json();
      lines.push('\nRender: ' + (svcData.name || svcId));
    }
  } catch (e: any) {
    lines.push('\nRender: ' + e.message);
  }

  await sendMessage(chatId, lines.join('\n'));
}

async function handleRepos(chatId: any, userId: any): Promise<void> {
  try {
    var repos: any = await ghApi('/user/repos?per_page=20&sort=updated', 'GET');
    if (repos.length === 0) {
      await sendMessage(chatId, 'No repos found.');
      return;
    }
    var lines: string[] = ['*Your GitHub Repos:*\n'];
    for (var i = 0; i < repos.length; i++) {
      var r = repos[i];
      lines.push((i + 1) + '. ' + r.full_name + ' (' + (r.private ? 'private' : 'public') + ')');
    }
    lines.push('\nUse /browse owner/repo to explore');
    lines.push('Use /fix owner/repo description to auto-fix');
    await sendMessage(chatId, lines.join('\n'));
  } catch (e: any) {
    await sendMessage(chatId, 'GitHub error: ' + e.message);
  }
}

async function handleBrowse(chatId: any, args: any): Promise<void> {
  var parts = args.trim().split('/');
  if (parts.length !== 2) {
    await sendMessage(chatId, 'Usage: /browse owner/repo');
    return;
  }
  var owner = parts[0];
  var repo = parts[1];
  try {
    var contents: any = await ghApi('/repos/' + owner + '/' + repo + '/contents/', 'GET');
    var lines: string[] = ['*Files in ' + owner + '/' + repo + ':*\n'];
    for (var i = 0; i < Math.min(contents.length, 30); i++) {
      var c = contents[i];
      var icon = c.type === 'dir' ? '📁' : '📄';
      lines.push(icon + ' ' + c.name);
    }
    if (contents.length > 30) {
      lines.push('\n... and ' + (contents.length - 30) + ' more');
    }
    lines.push('\nUse /readfile owner/repo path to read a file');
    await sendMessage(chatId, lines.join('\n'));
  } catch (e: any) {
    await sendMessage(chatId, 'Browse error: ' + e.message);
  }
}

async function handleReadFile(chatId: any, args: any): Promise<void> {
  var parts = args.trim().split(' ');
  var repoPath = parts[0];
  var filePath = parts.slice(1).join(' ');
  if (!repoPath || !filePath) {
    await sendMessage(chatId, 'Usage: /readfile owner/repo path/to/file');
    return;
  }
  var slashParts = repoPath.split('/');
  if (slashParts.length !== 2) {
    await sendMessage(chatId, 'Repo must be owner/repo');
    return;
  }
  try {
    var data: any = await ghApi('/repos/' + slashParts[0] + '/' + slashParts[1] + '/contents/' + filePath, 'GET');
    if (data.encoding === 'base64') {
      var content = Buffer.from(data.content, 'base64').toString('utf8');
      if (content.length > 3500) {
        content = content.substring(0, 3500) + '\n\n... (truncated, ' + data.size + ' bytes total)';
      }
      await sendMessage(chatId, '```\n' + content + '\n```');
    } else {
      await sendMessage(chatId, 'File: ' + filePath + ' (' + data.size + ' bytes)');
    }
  } catch (e: any) {
    await sendMessage(chatId, 'Read error: ' + e.message);
  }
}

async function handleAnalyze(chatId: any, args: any): Promise<void> {
  var parts = args.trim().split(' ');
  var repoPath = parts[0];
  var description = parts.slice(1).join(' ');
  if (!repoPath || !description) {
    await sendMessage(chatId, 'Usage: /analyze owner/repo description of the issue');
    return;
  }
  var slashParts = repoPath.split('/');
  if (slashParts.length !== 2) {
    await sendMessage(chatId, 'Repo must be owner/repo (exactly one slash)');
    return;
  }
  await sendMessage(chatId, 'Analyzing... this may take 30-60 seconds.');
  try {
    var mod: any = await import('./code-analyzer.js');
    var analyzeIssue = mod.analyzeIssue || (mod.default && mod.default.analyzeIssue);
    if (!analyzeIssue) {
      await sendMessage(chatId, 'Code analyzer module not available');
      return;
    }
    var result = await analyzeIssue(slashParts[0], slashParts[1], description);
    await sendMessage(chatId, '*Analysis:*\n\n' + result);
  } catch (e: any) {
    await sendMessage(chatId, 'Analyze error: ' + e.message);
  }
}

async function handleFix(chatId: any, userId: any, args: any): Promise<void> {
  var parts = args.trim().split(' ');
  var repoPath = parts[0];
  var description = parts.slice(1).join(' ');
  if (!repoPath || !description) {
    await sendMessage(chatId, 'Usage: /fix owner/repo description of the issue');
    return;
  }
  var slashParts = repoPath.split('/');
  if (slashParts.length !== 2) {
    await sendMessage(chatId, 'Repo must be owner/repo (exactly one slash)');
    return;
  }
  var owner = slashParts[0];
  var repo = slashParts[1];

  await sendMessage(chatId, 'Generating fix... this may take 1-2 minutes.');

  try {
    var mod: any = await import('./code-analyzer.js');
    var generateFix = mod.generateFix || (mod.default && mod.default.generateFix);
    if (!generateFix) {
      await sendMessage(chatId, 'Code analyzer module not available');
      return;
    }

    var plan: any = await generateFix(owner, repo, description);
    if (!plan || !plan.files || plan.files.length === 0) {
      await sendMessage(chatId, 'No fix generated. Try a more specific description.');
      return;
    }

    await sendMessage(chatId, 'Plan ready. Applying to GitHub...\n\nDiagnosis: ' + (plan.diagnosis || 'see PR') + '\nFiles: ' + plan.files.length);

    // STEP 1: Get repo info to find the REAL default branch
    var repoInfo: any = await ghApi('/repos/' + owner + '/' + repo, 'GET');
    var defaultBranch = repoInfo.default_branch || 'main';

    // STEP 2: Get SHA of the default branch
    var refData: any = await ghApi('/repos/' + owner + '/' + repo + '/git/refs/heads/' + defaultBranch, 'GET');
    var baseSha = refData.object.sha;

    // STEP 3: Create new branch from that SHA
    var branchName = plan.branch || ('fix/issue-' + Date.now());
    try {
      await ghApi('/repos/' + owner + '/' + repo + '/git/refs', 'POST', {
        ref: 'refs/heads/' + branchName,
        sha: baseSha
      });
    } catch (branchErr: any) {
      var errMsg = branchErr.message || '';
      if (errMsg.indexOf('422') >= 0) {
        // Branch already exists, continue
      } else {
        throw branchErr;
      }
    }

    // STEP 4: Commit each file
    var committed = 0;
    for (var i = 0; i < plan.files.length; i++) {
      var file = plan.files[i];
async function handleFix(chatId: any, userId: any, args: any): Promise<void> {
  var parts = args.trim().split(' ');
  var repoPath = parts[0];
  var description = parts.slice(1).join(' ');
  if (!repoPath || !description) {
    await sendMessage(chatId, 'Usage: /fix owner/repo description of the issue');
    return;
  }
  var slashParts = repoPath.split('/');
  if (slashParts.length !== 2) {
    await sendMessage(chatId, 'Repo must be owner/repo (exactly one slash)');
    return;
  }
  var owner = slashParts[0];
  var repo = slashParts[1];

  await sendMessage(chatId, 'Generating fix... this may take 1-2 minutes.');

  try {
    var mod: any = await import('./code-analyzer.js');
    var generateFix = mod.generateFix || (mod.default && mod.default.generateFix);
    if (!generateFix) {
      await sendMessage(chatId, 'Code analyzer module not available');
      return;
    }

    var plan: any = await generateFix(owner, repo, description);
    if (!plan || !plan.files || plan.files.length === 0) {
      await sendMessage(chatId, 'No fix generated. Try a more specific description.');
      return;
    }

    await sendMessage(chatId, 'Plan ready. Applying to GitHub...\n\nDiagnosis: ' + (plan.diagnosis || 'see PR') + '\nFiles: ' + plan.files.length);

    // STEP 1: Get default branch name
    var repoInfo: any = await ghApi('/repos/' + owner + '/' + repo, 'GET');
    var defaultBranch = repoInfo.default_branch || 'main';

    // STEP 2: Get latest commit SHA via commits API (NOT git/refs)
    var commits: any = await ghApi('/repos/' + owner + '/' + repo + '/commits?per_page=1', 'GET');
    if (!commits || commits.length === 0) {
      await sendMessage(chatId, 'Repo appears to be empty (no commits). Push at least one commit first.');
      return;
    }
    var baseSha = commits[0].sha;

    // STEP 3: Create new branch
    var branchName = plan.branch || ('fix/issue-' + Date.now());
    try {
      await ghApi('/repos/' + owner + '/' + repo + '/git/refs', 'POST', {
        ref: 'refs/heads/' + branchName,
        sha: baseSha
      });
    } catch (branchErr: any) {
      var errMsg = branchErr.message || '';
      if (errMsg.indexOf('422') >= 0) {
        // Branch already exists
      } else {
        throw branchErr;
      }
    }

    // STEP 4: Commit each file
    var committed = 0;
    for (var i = 0; i < plan.files.length; i++) {
      var file = plan.files[i];
      var fileSha = '';

      try {
        var existing: any = await ghApi('/repos/' + owner + '/' + repo + '/contents/' + file.path + '?ref=' + branchName, 'GET');
        fileSha = existing.sha;
      } catch (fileErr: any) {
        // File doesn't exist yet
      }

      var content64 = Buffer.from(file.content).toString('base64');
      var commitBody: any = {
        message: 'fix: ' + (plan.prTitle || description),
        content: content64,
        branch: branchName
      };
      if (fileSha) {
        commitBody.sha = fileSha;
      }

      await ghApi('/repos/' + owner + '/' + repo + '/contents/' + file.path, 'PUT', commitBody);
      committed++;
    }

    // STEP 5: Create pull request
    var pr: any = await ghApi('/repos/' + owner + '/' + repo + '/pulls', 'POST', {
      title: plan.prTitle || 'Fix: ' + description,
      body: plan.prBody || plan.diagnosis || description,
      head: branchName,
      base: defaultBranch
    });

    await sendMessage(chatId,
      '✅ Fix applied!\n\n' +
      'Branch: ' + branchName + '\n' +
      'Base: ' + defaultBranch + '\n' +
      'Files changed: ' + committed + '\n' +
      'PR: ' + pr.html_url + '\n\n' +
      'Review the PR and merge when ready.'
    );

  } catch (e: any) {
    await sendMessage(chatId, '❌ Fix failed: ' + e.message);
  }
}

async function handleWatch(chatId: any, args: any): Promise<void> {
  var repoPath = args.trim();
  if (!repoPath) {
    await sendMessage(chatId, 'Usage: /watch owner/repo');
    return;
  }
  var slashParts = repoPath.split('/');
  if (slashParts.length !== 2) {
    await sendMessage(chatId, 'Repo must be owner/repo');
    return;
  }
  try {
    var runs: any = await ghApi('/repos/' + slashParts[0] + '/' + slashParts[1] + '/actions/runs?per_page=5', 'GET');
    if (!runs.workflow_runs || runs.workflow_runs.length === 0) {
      await sendMessage(chatId, 'No CI runs found. Set up GitHub Actions first.');
      return;
    }
    var lines: string[] = ['*Recent CI Runs:*\n'];
    for (var i = 0; i < runs.workflow_runs.length; i++) {
      var run = runs.workflow_runs[i];
      var icon = run.conclusion === 'success' ? '✅' : (run.conclusion === 'failure' ? '❌' : '⏳');
      lines.push(icon + ' ' + run.name + ' #' + run.run_number + ' (' + run.status + '/' + (run.conclusion || 'pending') + ')');
      lines.push('   ' + run.html_url);
    }
    await sendMessage(chatId, lines.join('\n'));
  } catch (e: any) {
    await sendMessage(chatId, 'CI error: ' + e.message);
  }
}

async function handleCI(chatId: any, args: any): Promise<void> {
  await handleWatch(chatId, args);
}

async function handleNetlify(chatId: any): Promise<void> {
  var token = process.env.NETLIFY_AUTH_TOKEN || '';
  if (!token) {
    await sendMessage(chatId, 'NETLIFY_AUTH_TOKEN not set');
    return;
  }
  try {
    var res = await fetch('https://api.netlify.com/api/v1/sites', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var sites: any = await res.json();
    if (!Array.isArray(sites) || sites.length === 0) {
      await sendMessage(chatId, 'No Netlify sites found.');
      return;
    }
    var lines: string[] = ['*Netlify Sites:*\n'];
    for (var i = 0; i < Math.min(sites.length, 20); i++) {
      var s = sites[i];
      lines.push((i + 1) + '. ' + (s.name || s.id) + '\n   ' + (s.ssl_url || s.url));
    }
    await sendMessage(chatId, lines.join('\n'));
  } catch (e: any) {
    await sendMessage(chatId, 'Netlify error: ' + e.message);
  }
}

async function handleDeploy(chatId: any, args: any): Promise<void> {
  var svcId = args.trim() || process.env.RENDER_SERVICE_ID || '';
  if (!svcId) {
    await sendMessage(chatId, 'Usage: /deploy [service-id] or set RENDER_SERVICE_ID');
    return;
  }
  try {
    var hdrs = await getRenderHeaders();
    var res = await fetch('https://api.render.com/v1/services/' + svcId + '/deploys', {
      method: 'POST',
      headers: hdrs
    });
    var data: any = await res.json();
    await sendMessage(chatId, 'Deploy triggered!\nID: ' + (data.id || 'unknown') + '\nStatus: ' + (data.status || 'unknown'));
  } catch (e: any) {
    await sendMessage(chatId, 'Deploy error: ' + e.message);
  }
}
