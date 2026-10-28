import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

  const res = await ai.models.generateContent({ model: MODEL, contents: prompt });
  const text = res.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Gemini returned no JSON");
  return JSON.parse(jsonMatch[0]) as Diagnosis;
}

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

  const res = await ai.models.generateContent({ model: MODEL, contents: prompt });
  const text = res.text || "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Gemini returned no fix JSON");
  return JSON.parse(jsonMatch[0]) as FileFix[];
}

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

  const res = await ai.models.generateContent({ model: MODEL, contents: prompt });
  const text = res.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { safe: true, issues: ["Could not parse review response"] };
  return JSON.parse(jsonMatch[0]);
}
