import { supabase } from "./supabase.js";

// ── GITHUB ──────────────────────────────────────

interface GitHubRepo {
  name: string;
  fullName: string;
  defaultBranch: string;
  openIssues: number;
  updatedAt: string;
  private: boolean;
}

interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

const GITHUB_API = "https://api.github.com";

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "XTOP-Retail-Workforce/1.0",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function getRepoInfo(
  owner: string,
  repo: string
): Promise<GitHubRepo> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}`,
    { headers: githubHeaders() }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub API ${res.status}: ${text.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    name: String(data.name || repo),
    fullName: String(data.full_name || `${owner}/${repo}`),
    defaultBranch: String(data.default_branch || "main"),
    openIssues: Number(data.open_issues_count || 0),
    updatedAt: String(data.updated_at || ""),
    private: Boolean(data.private),
  };
}

export async function getRecentCommits(
  owner: string,
  repo: string,
  limit = 5
): Promise<GitHubCommit[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=${limit}`,
    { headers: githubHeaders() }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub API ${res.status}: ${text.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as Array<Record<string, unknown>>;

  return data.map((c) => {
    const commit = c.commit as Record<string, unknown> | undefined;
    const author = commit?.author as Record<string, unknown> | undefined;

    return {
      sha: String(c.sha || "").slice(0, 7),
      message: String(commit?.message || "").split("\n")[0].slice(0, 100),
      author: String(author?.name || "unknown"),
      date: String(author?.date || ""),
    };
  });
}

// ── RENDER ──────────────────────────────────────

interface RenderService {
  id: string;
  name: string;
  type: string;
  status: string;
  updatedAt: string;
}

interface RenderDeploy {
  id: string;
  status: string;
  createdAt: string;
  commitId: string;
}

const RENDER_API = "https://api.render.com/v1";

function renderHeaders(): Record<string, string> {
  const key = process.env.RENDER_API_KEY?.trim();
  if (!key) {
    throw new Error("RENDER_API_KEY not configured.");
  }
  return {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
  };
}

export async function getRenderService(
  serviceId: string
): Promise<RenderService> {
  const res = await fetch(
    `${RENDER_API}/services/${serviceId}`,
    { headers: renderHeaders() }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Render API ${res.status}: ${text.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  const svc = data.service as Record<string, unknown> | undefined;

  return {
    id: String(svc?.id || serviceId),
    name: String(svc?.name || "unknown"),
    type: String(svc?.type || "unknown"),
    status: String(svc?.serviceDetails?.status || data.status || "unknown"),
    updatedAt: String(svc?.updatedAt || ""),
  };
}

export async function getRenderDeploys(
  serviceId: string,
  limit = 3
): Promise<RenderDeploy[]> {
  const res = await fetch(
    `${RENDER_API}/services/${serviceId}/deploys?limit=${limit}`,
    { headers: renderHeaders() }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Render API ${res.status}: ${text.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as Array<Record<string, unknown>>;

  return data.map((d) => {
    const deploy = d.deploy as Record<string, unknown> | undefined;
    return {
      id: String(deploy?.id || d.id || "").slice(0, 12),
      status: String(deploy?.status || "unknown"),
      createdAt: String(deploy?.createdAt || ""),
      commitId: String(deploy?.commit?.id || "").slice(0, 7),
    };
  });
}

// ── SUPABASE ────────────────────────────────────

interface TableStats {
  table: string;
  count: number;
}

export async function getSupabaseHealth(): Promise<{
  connected: boolean;
  tables: TableStats[];
  error?: string;
}> {
  const tablesToCheck = [
    "job_leads",
    "gmail_connections",
    "tasks",
    "audit_log",
    "prospects",
    "outreach",
  ];

  const tables: TableStats[] = [];

  try {
    // Quick connectivity test
    const { error: pingErr } = await supabase
      .from("job_leads")
      .select("id", { count: "exact", head: true })
      .limit(1);

    if (pingErr) {
      return { connected: false, tables: [], error: pingErr.message };
    }

    // Count rows in each table
    for (const table of tablesToCheck) {
      try {
        const { count, error } = await supabase
          .from(table)
          .select("*", { count: "exact", head: true });

        if (error) {
          tables.push({ table, count: -1 });
        } else {
          tables.push({ table, count: count ?? 0 });
        }
      } catch {
        tables.push({ table, count: -1 });
      }
    }

    return { connected: true, tables };
  } catch (error) {
    return {
      connected: false,
      tables: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── COMBINED STATUS ─────────────────────────────

export async function getFullInfraStatus(): Promise<{
  github: { ok: boolean; message: string };
  render: { ok: boolean; message: string };
  supabase: { ok: boolean; message: string };
}> {
  const result = {
    github: { ok: false, message: "Not checked" },
    render: { ok: false, message: "Not checked" },
    supabase: { ok: false, message: "Not checked" },
  };

  // GitHub
  try {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      result.github = { ok: false, message: "GITHUB_TOKEN not set" };
    } else {
      const repo = await getRepoInfo("erodion4776", "xtop-career-agent-");
      result.github = {
        ok: true,
        message: `${repo.fullName} — ${repo.openIssues} open issues, updated ${repo.updatedAt.slice(0, 10)}`,
      };
    }
  } catch (error) {
    result.github = {
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 100) : "Error",
    };
  }

  // Render
  try {
    const key = process.env.RENDER_API_KEY?.trim();
    if (!key) {
      result.render = { ok: false, message: "RENDER_API_KEY not set" };
    } else {
      const svc = await getRenderService("srv-dbf6gi0ae00c73ev0l9g");
      result.render = {
        ok: svc.status === "live" || svc.status === "available",
        message: `${svc.name} — status: ${svc.status}`,
      };
    }
  } catch (error) {
    result.render = {
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 100) : "Error",
    };
  }

  // Supabase
  try {
    const health = await getSupabaseHealth();
    if (health.connected) {
      const totalRows = health.tables
        .filter((t) => t.count >= 0)
        .reduce((sum, t) => sum + t.count, 0);
      result.supabase = {
        ok: true,
        message: `Connected — ${health.tables.length} tables, ${totalRows} total rows`,
      };
    } else {
      result.supabase = {
        ok: false,
        message: health.error || "Connection failed",
      };
    }
  } catch (error) {
    result.supabase = {
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 100) : "Error",
    };
  }

  return result;
}
