const NETLIFY_API = "https://api.netlify.com/api/v1";

function headers(): Record<string, string> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error("NETLIFY_AUTH_TOKEN not set. Get one at: Netlify → User settings → Applications → New access token");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "xtop-dev-agent",
  };
}

async function nf(path: string, opts: RequestInit = {}): Promise<any> {
  const url = path.startsWith("http") ? path : `${NETLIFY_API}${path}`;
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...opts.headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Netlify ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── List all sites ─────────────────────────────────────
export async function listSites(): Promise<any[]> {
  const sites = await nf("/sites?per_page=50");
  return Array.isArray(sites) ? sites : [];
}

// ── Get single site ────────────────────────────────────
export async function getSite(siteId: string): Promise<any> {
  return nf(`/sites/${siteId}`);
}

// ── Get deploys for a site ─────────────────────────────
export async function getDeploys(siteId: string, count = 5): Promise<any[]> {
  const deploys = await nf(`/sites/${siteId}/deploys?per_page=${count}`);
  return Array.isArray(deploys) ? deploys : [];
}

// ── Trigger deploy ─────────────────────────────────────
export async function triggerDeploy(siteId: string, branch?: string): Promise<any> {
  // Method 1: Try API deploy with branch
  try {
    const result = await nf(`/sites/${siteId}/deploys`, {
      method: "POST",
      body: JSON.stringify({ branch: branch || "main" }),
    });
    return { method: "api", deploy: result };
  } catch (e: any) {
    // Method 2: Fall back to build hook if configured
    const hookUrl = process.env[`NETLIFY_BUILD_HOOK_${siteId.slice(0, 8).toUpperCase()}`]
      || process.env.NETLIFY_BUILD_HOOK;
    if (hookUrl) {
      const res = await fetch(hookUrl, { method: "POST" });
      if (res.ok) return { method: "build_hook", status: "triggered" };
    }
    throw new Error(
      `Could not trigger deploy. The site may need a build hook. ` +
      `Add one at: Netlify → Site settings → Build & deploy → Build hooks`
    );
  }
}

// ── Find site by name or partial ID ────────────────────
export async function findSite(query: string): Promise<any | null> {
  const sites = await listSites();
  const q = query.toLowerCase();

  // Exact ID match
  const exact = sites.find((s: any) => s.id === query);
  if (exact) return exact;

  // Name match
  const nameMatch = sites.find((s: any) =>
    s.name?.toLowerCase() === q || s.custom_domain?.toLowerCase() === q
  );
  if (nameMatch) return nameMatch;

  // Partial match
  const partial = sites.find((s: any) =>
    s.name?.toLowerCase().includes(q) || s.id?.startsWith(q)
  );
  return partial || null;
}

// ── Check if configured ────────────────────────────────
export function isConfigured(): boolean {
  return !!process.env.NETLIFY_AUTH_TOKEN;
}
