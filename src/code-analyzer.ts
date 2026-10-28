import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ── Retry helper ───────────────────────────────────────
async function callGemini(prompt: string, retries = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await ai.models.generateContent({ model: MODEL, contents: prompt });
      const text = res.text || "";
      if (!text && attempt < retries) {
        await sleep(3000 * attempt);
        continue;
      }
      return text;
    } catch (e: any) {
      const msg = e.message || String(e);
      const isRetryable =
        msg.includes("503") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("429") ||
        msg.includes("high demand") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("overloaded");

      if (isRetryable && attempt < retries) {
        const wait = 5000 * attempt;
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Gemini API unavailable after 3 retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Types ──────────────────────────────────────────────
export interface Diagnosis {
  diagnosis: string;
  severity: "critical" | "high" | "medium" | "low";
  root_cause: string;
  files_to_fix: { path: string; reason: string }[];
  confidence: number;
}

export interface FileFix {
  path: string;
  content: string;
  explanation: string;
}

// ── Analyze ────────────────────────────────────────────
export async function analyzeError(
  errorLog: string,
  files: { path: string; content: string }[],
  description: string
): Promise<Diagnosis> {
  const fileContext = files
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 4000)}`)
    .join("\n\n");

  const prompt = `You are a senior TypeScript/Node.js developer. Analyze this issue and return ONLY valid JSON.

PROBLEM: ${description}

ERROR LOG:
${errorLog.slice(0, 3000)}

RELEVANT FILES:
${fileContext.slice(0, 12000)}

Return JSON:
{
  "diagnosis": "brief description of the problem",
  "severity": "critical|high|medium|low",
  "root_cause": "detailed root cause explanation",
  "files_to_fix": [{"path": "src/file.ts", "reason": "what needs changing"}],
  "confidence": 85
}`;

  const text = await callGemini(prompt);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Gemini returned no JSON");
  return JSON.parse(jsonMatch[0]) as Diagnosis;
}

// ── Generate Fix ───────────────────────────────────────
export async function generateFix(
  diagnosis: Diagnosis,
  files: { path: string; content: string; sha?: string }[]
): Promise<FileFix[]> {
  const fileContext = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const prompt = `You are a senior TypeScript/Node.js developer. Fix the code based on this diagnosis. Return ONLY valid JSON.

DIAGNOSIS: ${diagnosis.root_cause}
FILES TO FIX: ${JSON.stringify(diagnosis.files_to_fix)}

CURRENT FILE CONTENTS:
${fileContext.slice(0, 15000)}

IMPORTANT RULES:
- Return the COMPLETE file content for each fixed file (not just diffs)
- Preserve all existing functionality
- Use ESM imports with .js extensions (this is a NodeNext project)
- Do not add new dependencies unless absolutely necessary
- Do not modify .env files or expose secrets

Return JSON array:
[
  {
    "path": "src/file.ts",
    "content": "complete corrected file content here",
    "explanation": "what was changed and why"
  }
]`;

  const text = await callGemini(prompt);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Gemini returned no fix JSON");
  return JSON.parse(jsonMatch[0]) as FileFix[];
}

// ── Review ─────────────────────────────────────────────
export async function reviewChanges(
  originalFiles: { path: string; content: string }[],
  fixedFiles: { path: string; content: string }[]
): Promise<{ safe: boolean; issues: string[] }> {
  const prompt = `Review these code changes for bugs, security issues, missing imports, broken references, or regressions. Return ONLY valid JSON.

ORIGINAL:
${originalFiles.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 3000)}`).join("\n")}

FIXED:
${fixedFiles.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 3000)}`).join("\n")}

Return JSON:
{
  "safe": true,
  "issues": ["list any problems found, empty if none"]
}`;

  try {
    const text = await callGemini(prompt, 2);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { safe: true, issues: ["Could not parse review response"] };
    return JSON.parse(jsonMatch[0]);
  } catch {
    // If review fails, allow the fix but flag it
    return { safe: true, issues: ["⚠️ AI review skipped due to API overload. Review the PR manually."] };
  }
}
