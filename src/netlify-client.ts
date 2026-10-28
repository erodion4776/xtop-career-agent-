const NETLIFY_API = "https://api.netlify.com/api/v1";

function headers(): Record<string, string> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error("NETLIFY_AUTH_TOKEN not set");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function nf(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${NETLIFY_API}${path}`, { ...opts, headers: { ...headers(), ...opts.headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Netlify ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function getSite(siteId?: string) {
  const id = siteId || process.env.NETLIFY_SITE_ID;
  if (!id) throw new Error("NETLIFY_SITE_ID not set");
  return nf(`/sites/${id}`);
}

export async function getDeploys(siteId?: string, count = 5) {
  const id = siteId || process.env.NETLIFY_SITE_ID;
  if (!id) throw new Error("NETLIFY_SITE_ID not set");
  return nf(`/sites/${id}/deploys?per_page=${count}`);
}

export async function triggerBuild(siteId?: string) {
  const id = siteId || process.env.NETLIFY_SITE_ID;
  if (!id) throw new Error("NETLIFY_SITE_ID not set");
  // Netlify uses build hooks for triggering. If you have a build hook URL:
  const hookUrl = process.env.NETLIFY_BUILD_HOOK;
  if (hookUrl) {
    const res = await fetch(hookUrl, { method: "POST" });
    if (!res.ok) throw new Error(`Build hook failed: ${res.status}`);
    return { status: "triggered", via: "build_hook" };
  }
  throw new Error("NETLIFY_BUILD_HOOK not set. Create one at: Site settings → Build & deploy → Build hooks");
}

export async function getDeploy(deployId: string) {
  return nf(`/deploys/${deployId}`);
}

export function isConfigured(): boolean {
  return !!(process.env.NETLIFY_AUTH_TOKEN && process.env.NETLIFY_SITE_ID);
}
