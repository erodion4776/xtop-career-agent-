// ─── Site Builder ───────────────────────────────────────────────────
// Generates HTML via Gemini, creates GitHub repo, deploys to Netlify
// Called as: buildSite(description: string, userId: number)

async function callGemini(prompt: string): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const backoffMs = [10000, 20000, 30000, 60000, 90000];

  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
      });
      return response.text || '';
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isRetryable = msg.includes('503') || msg.includes('UNAVAILABLE') ||
        msg.includes('429') || msg.includes('overloaded') ||
        msg.includes('RESOURCE_EXHAUSTED');

      if (isRetryable && attempt < 5) {
        const wait = backoffMs[attempt] || 60000;
        console.log(`⏳ Gemini retry ${attempt + 1}/5 in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Gemini unavailable after all retries');
}

// ─── Generate site name from description ────────────────────────────

function generateSiteName(description: string): string {
  // Extract key words from description to make a repo name
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'for', 'and', 'with', 'that', 'this', 'from', 'are', 'was', 'but', 'not', 'you', 'all', 'can', 'has', 'her', 'one', 'our', 'out', 'its', 'his', 'how', 'may', 'who', 'did', 'get', 'had', 'him', 'let', 'say', 'she', 'too', 'use', 'will', 'make', 'like', 'just', 'over', 'such', 'take', 'than', 'them', 'very', 'been', 'call', 'come', 'could', 'each', 'find', 'here', 'know', 'long', 'many', 'more', 'most', 'only', 'other', 'some', 'time', 'what', 'when', 'where', 'which', 'about', 'would', 'there', 'their', 'these', 'after', 'being', 'have', 'into'].includes(w));

  const name = words.slice(0, 3).join('-');
  return name || 'my-site';
}

// ─── Generate HTML via Gemini ───────────────────────────────────────

async function generateHTML(description: string): Promise<string> {
  const prompt = `You are an expert web developer. Create a complete, beautiful, modern single-page HTML website based on this description:

"${description}"

Requirements:
- Single HTML file with embedded CSS and JavaScript
- Modern, responsive design (mobile-friendly)
- Use a clean color scheme
- Include appropriate sections (hero, features, about, contact, etc.)
- Use smooth animations and transitions
- Include placeholder images using CSS gradients (no external image URLs)
- Professional typography
- Semantic HTML5

Respond with ONLY the complete HTML code. No explanations, no markdown code blocks, just the raw HTML starting with <!DOCTYPE html>.`;

  const raw = await callGemini(prompt);

  // Strip markdown code blocks if present
  let html = raw.trim();
  if (html.startsWith('```')) {
    html = html.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  }

  // Ensure it starts with <!DOCTYPE or <html
  if (!html.toLowerCase().startsWith('<!doctype') && !html.toLowerCase().startsWith('<html')) {
    const doctypeIdx = html.toLowerCase().indexOf('<!doctype');
    const htmlIdx = html.toLowerCase().indexOf('<html');
    const startIdx = doctypeIdx >= 0 ? doctypeIdx : htmlIdx;
    if (startIdx > 0) {
      html = html.slice(startIdx);
    }
  }

  return html;
}

// ─── Create GitHub Repo ─────────────────────────────────────────────

async function createGitHubRepo(repoName: string, htmlContent: string): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  // Create repo
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoName,
      description: `Auto-generated site by XTOP Agent`,
      private: false,
      auto_init: false,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.json() as any;
    // If repo already exists, that's fine
    if (createRes.status !== 422) {
      throw new Error(`GitHub repo creation failed: ${err?.message || createRes.status}`);
    }
  }

  const repoData = await createRes.json() as any;
  const fullName = repoData?.full_name || repoName;
  const [owner, repo] = fullName.split('/');

  // Create index.html via GitHub Contents API
  const contentBase64 = Buffer.from(htmlContent, 'utf-8').toString('base64');

  const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/index.html`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Initial site generated by XTOP Agent',
      content: contentBase64,
      branch: 'main',
    }),
  });

  if (!fileRes.ok) {
    const err = await fileRes.json() as any;
    throw new Error(`Failed to create index.html: ${err?.message || fileRes.status}`);
  }

  return fullName;
}

// ─── Deploy to Netlify ──────────────────────────────────────────────

async function deployToNetlify(repoFullName: string, htmlContent: string): Promise<{ url: string; deployId: string }> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN not set');

  const siteName = repoFullName.replace('/', '-').toLowerCase();

  // Create site on Netlify
  const siteRes = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: siteName,
    }),
  });

  if (!siteRes.ok) {
    const err = await siteRes.json() as any;
    throw new Error(`Netlify site creation failed: ${err?.message || siteRes.status}`);
  }

  const siteData = await siteRes.json() as any;
  const siteId = siteData.id;

  // Deploy the HTML file
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: await createZipBuffer(htmlContent),
  });

  if (!deployRes.ok) {
    const err = await deployRes.json() as any;
    throw new Error(`Netlify deploy failed: ${err?.message || deployRes.status}`);
  }

  const deployData = await deployRes.json() as any;

  return {
    url: deployData?.ssl_url || deployData?.url || siteData?.ssl_url || siteData?.url || `https://${siteName}.netlify.app`,
    deployId: deployData?.id || 'ok',
  };
}

// ─── Create minimal ZIP for Netlify deploy ──────────────────────────

async function createZipBuffer(htmlContent: string): Promise<Buffer> {
  // Netlify accepts file digests for deploys, but the simplest approach
  // is to use the file-based deploy API with a JSON manifest
  // We'll use the "files" deploy method instead

  // Actually, for simplicity, use Netlify's file digest deploy
  const crypto = await import('crypto');
  const sha1 = crypto.createHash('sha1').update(htmlContent).digest('hex');

  return Buffer.from(htmlContent); // placeholder — we'll use the digest API
}

// ─── Main Build Function ────────────────────────────────────────────

export async function buildSite(
  description: string,
  userId: number
): Promise<{ url: string; repo: string; deployUrl: string }> {

  if (!description || typeof description !== 'string') {
    throw new Error('Description is required');
  }

  const siteName = generateSiteName(description);
  const repoName = `${siteName}-${Date.now().toString(36)}`;

  console.log(`🏗 Building site: ${repoName} from description: "${description.slice(0, 50)}..."`);

  // Step 1: Generate HTML
  console.log('📝 Generating HTML with Gemini...');
  const html = await generateHTML(description);
  console.log(`✅ HTML generated (${html.length} chars)`);

  // Step 2: Create GitHub repo
  console.log('📂 Creating GitHub repo...');
  let repoFullName = '';
  try {
    repoFullName = await createGitHubRepo(repoName, html);
    console.log(`✅ Repo created: ${repoFullName}`);
  } catch (err: any) {
    console.error(`⚠️ GitHub repo failed: ${err.message}`);
    repoFullName = `github-failed/${repoName}`;
  }

  // Step 3: Deploy to Netlify
  console.log('🚀 Deploying to Netlify...');
  let deployUrl = '';
  try {
    // Use Netlify's file-based deploy (simpler than ZIP)
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) throw new Error('NETLIFY_AUTH_TOKEN not set');

    const siteNameNf = repoName.replace(/[^a-z0-9-]/g, '-');

    // Create site
    const siteRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: siteNameNf }),
    });

    if (!siteRes.ok) {
      const err = await siteRes.json() as any;
      throw new Error(err?.message || `HTTP ${siteRes.status}`);
    }

    const siteData = await siteRes.json() as any;
    const siteId = siteData.id;

    // Deploy using file digest method
    const crypto = await import('crypto');
    const sha1 = crypto.createHash('sha1').update(html).digest('hex');

    const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: {
          '/index.html': sha1,
        },
      }),
    });

    if (!deployRes.ok) {
      const err = await deployRes.json() as any;
      throw new Error(err?.message || `HTTP ${deployRes.status}`);
    }

    const deployData = await deployRes.json() as any;
    const deployId = deployData.id;

    // Upload the actual file content
    const uploadRes = await fetch(
      `https://api.netlify.com/api/v1/deploys/${deployId}/files/index.html`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: html,
      }
    );

    if (!uploadRes.ok) {
      console.error('⚠️ File upload failed, but deploy was created');
    }

    deployUrl = deployData?.ssl_url || deployData?.url || siteData?.ssl_url || `https://${siteNameNf}.netlify.app`;
    console.log(`✅ Deployed: ${deployUrl}`);
  } catch (err: any) {
    console.error(`⚠️ Netlify deploy failed: ${err.message}`);
    deployUrl = `deploy-failed: ${err.message}`;
  }

  return {
    url: deployUrl,
    repo: repoFullName,
    deployUrl: deployUrl,
  };
}
