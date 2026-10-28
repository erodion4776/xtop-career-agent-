// ─── Gemini API with aggressive retry ──────────────────────────────

async function callGemini(prompt: string, maxRetries = 5): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const backoffMs = [10000, 20000, 30000, 60000, 90000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate limit');

      if (isRetryable && attempt < maxRetries) {
        const wait = backoffMs[attempt] || 60000;
        console.log(`⏳ Gemini ${msg.includes('503') ? '503' : '429'} — retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Gemini unavailable after all retries');
}

// ─── Dynamic module loaders ────────────────────────────────────────

async function getGitHubClient() {
  const mod = await import('./github-client.js');
  const Cls = (mod as any).GitHubClient || (mod as any).GithubClient ||
    (mod as any).GitHub || (mod as any).default ||
    Object.values(mod).find((v: any) => typeof v === 'function');
  return new (Cls as any)();
}

// ─── Analyze Issue ──────────────────────────────────────────────────

export async function analyzeIssue(
  owner: string,
  repo: string,
  description: string
): Promise<string> {
  const gh = await getGitHubClient();

  // Gather context: recent files, package.json, error logs
  let context = '';
  try {
    const pkg = await gh.getFileContent(owner, repo, 'package.json');
    context += `package.json:\n${pkg}\n\n`;
  } catch {
    context += 'package.json: not found\n\n';
  }

  try {
    const tsconfig = await gh.getFileContent(owner, repo, 'tsconfig.json');
    context += `tsconfig.json:\n${tsconfig}\n\n`;
  } catch {
    // optional
  }

  // Check recent CI logs if available
  try {
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=1&status=failure`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
      );
      if (res.ok) {
        const data = await res.json() as any;
        const runs = data.workflow_runs || [];
        if (runs.length > 0) {
          context += `Last failed CI run: ${runs[0].name} on ${runs[0].head_branch}\n`;
          context += `URL: ${runs[0].html_url}\n\n`;
        }
      }
    }
  } catch {
    // optional
  }

  const prompt = `You are an expert software engineer. Analyze this issue and provide a clear diagnosis.

REPO: ${owner}/${repo}
ISSUE: ${description}

REPO CONTEXT:
${context}

Provide:
1. Root cause analysis (what's wrong and why)
2. Affected files
3. Recommended fix (specific code changes)
4. Confidence level (high/medium/low)

Be concise and actionable.`;

  return await callGemini(prompt);
}

// ─── Generate Fix ───────────────────────────────────────────────────

export async function generateFix(
  owner: string,
  repo: string,
  description: string
): Promise<{ diagnosis: string; branch: string; files: Array<{ path: string; content: string }>; prTitle: string; prBody: string }> {
  const gh = await getGitHubClient();

  // Gather context
  let context = '';
  try {
    const pkg = await gh.getFileContent(owner, repo, 'package.json');
    context += `package.json:\n${pkg}\n\n`;
  } catch {
    context += 'package.json: not found\n\n';
  }

  try {
    const tsconfig = await gh.getFileContent(owner, repo, 'tsconfig.json');
    context += `tsconfig.json:\n${tsconfig}\n\n`;
  } catch {
    // optional
  }

  const prompt = `You are an expert software engineer. Generate a complete fix for this issue.

REPO: ${owner}/${repo}
ISSUE: ${description}

REPO CONTEXT:
${context}

Respond in this EXACT JSON format (no markdown, no code blocks, just raw JSON):
{
  "diagnosis": "brief explanation of the problem",
  "branch": "fix/description-kebab-case",
  "files": [
    {
      "path": "relative/path/to/file.ts",
      "content": "complete file content after fix"
    }
  ],
  "prTitle": "fix: brief description",
  "prBody": "## Problem\\n...\\n## Solution\\n..."
}

Rules:
- Include ALL files that need changes
- Provide COMPLETE file contents (not diffs)
- Keep the branch name short and descriptive
- Do not modify package-lock.json or node_modules`;

  const raw = await callGemini(prompt);

  // Parse JSON from response
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return JSON.parse(jsonMatch[0]);
  } catch (e: any) {
    return {
      diagnosis: raw.slice(0, 500),
      branch: `fix/auto-${Date.now()}`,
      files: [],
      prTitle: `fix: ${description.slice(0, 50)}`,
      prBody: `Auto-generated fix attempt.\n\nDiagnosis:\n${raw.slice(0, 1000)}`,
    };
  }
}
