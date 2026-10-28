const GITHUB_API = "https://api.github.com";

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "xtop-dev-agent",
  };
}

async function gh(path: string, opts: RequestInit = {}): Promise<any> {
  const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...opts.headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = body.length < 200 ? body : res.statusText;
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function decode(b64: string): string {
  return Buffer.from(b64.replace(/\n/g, ""), "base64").toString("utf-8");
}

// ── Repos ──────────────────────────────────────────────
export async function listRepos(perPage = 20) {
  return gh(`/user/repos?sort=updated&per_page=${perPage}&affiliation=owner,collaborator`);
}

export async function getRepo(owner: string, repo: string) {
  return gh(`/repos/${owner}/${repo}`);
}

// ── Contents ───────────────────────────────────────────
export async function getContents(owner: string, repo: string, path = "", ref = "main") {
  const p = path ? `/${path}` : "";
  return gh(`/repos/${owner}/${repo}/contents${p}?ref=${ref}`);
}

export async function getFile(owner: string, repo: string, path: string, ref = "main"): Promise<{ content: string; sha: string; size: number }> {
  const data = await gh(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
  if (data.type !== "file") throw new Error(`Not a file: ${path}`);
  if (data.size > 1_000_000) throw new Error(`File too large (${data.size} bytes). Max 1MB via API.`);
  return { content: decode(data.content), sha: data.sha, size: data.size };
}

// ── Branches ───────────────────────────────────────────
export async function getBranches(owner: string, repo: string) {
  return gh(`/repos/${owner}/${repo}/branches?per_page=20`);
}

export async function createBranch(owner: string, repo: string, name: string, fromBranch = "main") {
  const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`);
  return gh(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha: ref.object.sha }),
  });
}

// ── Commits ────────────────────────────────────────────
export async function getCommits(owner: string, repo: string, ref = "main", perPage = 10) {
  return gh(`/repos/${owner}/${repo}/commits?sha=${ref}&per_page=${perPage}`);
}

export async function createOrUpdateFile(
  owner: string, repo: string, path: string,
  content: string, message: string, branch: string, sha?: string
) {
  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;
  return gh(`/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ── Pull Requests ──────────────────────────────────────
export async function createPR(owner: string, repo: string, title: string, body: string, head: string, base = "main") {
  return gh(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base }),
  });
}

export async function getPRs(owner: string, repo: string, state = "open") {
  return gh(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=10`);
}

// ── Actions ────────────────────────────────────────────
export async function getWorkflowRuns(owner: string, repo: string, perPage = 5) {
  return gh(`/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`);
}

export async function getWorkflowRunJobs(owner: string, repo: string, runId: number) {
  return gh(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
}

export async function triggerWorkflow(owner: string, repo: string, workflowId: string, ref = "main") {
  return gh(`/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
}

// ── Search ─────────────────────────────────────────────
export async function searchCode(query: string, repo: string) {
  return gh(`/search/code?q=${encodeURIComponent(query)}+repo:${repo}&per_page=10`);
}

// ── Issues ─────────────────────────────────────────────
export async function getIssues(owner: string, repo: string, state = "open") {
  return gh(`/repos/${owner}/${repo}/issues?state=${state}&per_page=10`);
}

// ── Helpers ────────────────────────────────────────────
export function parseRepo(input: string): { owner: string; repo: string } {
  const parts = input.replace(/^@/, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Use format: owner/repo (e.g. erodion4776/xtop-career-agent-)");
  }
  return { owner: parts[0], repo: parts[1] };
}

export const DEFAULT_REPO = { owner: "erodion4776", repo: "xtop-career-agent-" };
