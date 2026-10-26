
import { z } from "zod";
import { addJob } from "./tracker.js";

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().min(1),
  company_name: z.string().optional().default("Company not listed"),
  candidate_required_location: z.string().optional().default("Not specified"),
  url: z.string().optional().default(""),
  description: z.string().optional().default(""),
  job_type: z.string().optional().default("Unknown"),
});

type ParsedJob = z.infer<typeof JobSchema>;

interface TrackedJob extends ParsedJob {
  url: string;
  source: string;
}

const RemoteOkSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  position: z.string().min(1),
  company: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  apply_url: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  date: z.string().optional(),
});

type Eligibility = "confirmed" | "potential" | "restricted" | "unknown";
type Suitability = "high" | "medium" | "low";

interface SourceResult {
  source: string;
  returned: number;
  valid: number;
  matched: number;
  sampleTitles?: string[];
  error?: string;
}

interface TopJob {
  title: string;
  company: string;
  location: string;
  score: number;
  tier: Suitability;
  eligibility: Eligibility;
  url: string;
  reason: string;
}

const REMOTIVE_SOURCES = [
  {
    name: "Remotive software development",
    url: "https://remotive.com/api/remote-jobs?category=software-dev&limit=50",
  },
  {
    name: "Remotive TypeScript",
    url: "https://remotive.com/api/remote-jobs?search=typescript&limit=50",
  },
  {
    name: "Remotive Node.js",
    url: "https://remotive.com/api/remote-jobs?search=node.js&limit=50",
  },
] as const;

const REMOTE_OK_URL = "https://remoteok.com/api";
const USER_AGENT = "XTOP-Career-Agent/1.4";

function isValidHttpUrl(value: string | undefined | null): value is string {
  if (!value?.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function truncateDescription(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let cut = text.slice(0, maxLen).replace(/<[^>]*$/, "");
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.9) cut = cut.slice(0, lastSpace);
  return cut + "...";
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries = 2,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.status === 429) return response;
      if (response.status >= 400 && response.status < 500) return response;
      if (response.ok || attempt === maxRetries) return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxRetries) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await delay(1000 * (attempt + 1));
  }

  throw lastError ?? new Error("Fetch failed after retries");
}

function isRelevantRole(title: string): boolean {
  const t = title.toLowerCase().replace(/[\u2013\u2014]/g, "-").trim();

  const excluded =
    /\b(copywriter|writer|editor|sales|account executive|office assistant|administrative assistant|virtual assistant|service desk|help desk|customer support|customer service|technical support|support specialist|data annotator|video annotation|ai trainer|recruiter|marketing specialist|business development|project manager|product manager|product owner|scrum master|qa engineer|qa tester|tester|technical writer|ux designer|ui designer|graphic designer|data analyst|business analyst|human resources|talent acquisition|sourcer|content strategist|seo specialist|community manager|operations manager|office manager|executive assistant|legal|compliance|finance|accounting|bookkeeper|payroll|procurement|logistics|supply chain)\b/i;

  if (excluded.test(t)) return false;

  return /\b(software developer|software engineer|web developer|web engineer|frontend developer|front-end developer|front end developer|frontend engineer|front-end engineer|front end engineer|backend developer|back-end developer|back end developer|backend engineer|back-end engineer|back end engineer|full.?stack developer|full.?stack engineer|mobile developer|mobile engineer|application developer|application engineer|api developer|api engineer|platform engineer|devops engineer|site reliability engineer|sre|programmer|automation developer|automation engineer|ai engineer|machine learning engineer|ml engineer|data engineer|cloud engineer|systems engineer|technical lead|tech lead|software architect|blockchain developer|blockchain engineer|embedded developer|embedded engineer|firmware engineer|security engineer|infrastructure engineer|solutions architect|integration engineer|release engineer|build engineer)\b/i.test(t);
}

function matchesTechStack(job: TrackedJob): boolean {
  const text = `${job.title} ${job.description}`.toLowerCase();
  return /\b(node\.?js|typescript|javascript|react|next\.?js|express|backend|back-end|full.?stack|supabase|api\b|apis\b|automation|rest\s*api|graphql)\b/i.test(text);
}

function experienceLevel(job: TrackedJob): "junior" | "mid" | "senior" | "staff" | "unknown" {
  const text = `${job.title} ${job.description.slice(0, 5000)}`.toLowerCase();

  if (/\b(staff|principal|distinguished|fellow|vp of engineering|chief technology)\b/i.test(job.title)) return "staff";
  if (/\b(senior|sr\.?|lead|head of|director|architect)\b/i.test(job.title)) return "senior";
  if (/\b(junior|jr\.?|entry.level|graduate|associate|intern|internship)\b/i.test(job.title)) return "junior";

  const years = text.match(/\b(\d{1,2})\+?\s+years?\s+(?:of\s+)?experience\b/i);
  if (years) {
    const count = Number(years[1]);
    if (count >= 7) return "staff";
    if (count >= 5) return "senior";
    if (count <= 2) return "junior";
    return "mid";
  }

  if (/\b(mid.level|midlevel|intermediate)\b/i.test(job.title)) return "mid";
  return "unknown";
}

function nigeriaCategory(location: string): Eligibility {
  const loc = location.toLowerCase().replace(/[\u2013\u2014]/g, "-").trim();

  if (/\bnigeria\b/.test(loc)) return "confirmed";

  if (/\b(worldwide|anywhere|global(?:ly)?|all countries|africa|african countries|emerging markets|emea)\b/i.test(loc)) {
    return "potential";
  }

  if (/\b(us|usa|united states|america|uk|united kingdom|britain|england|europe|eu|canada|australia|germany|france|netherlands|sweden|norway|denmark|finland|switzerland|austria|belgium|ireland|spain|italy|portugal|poland|czech|romania|brazil|mexico|india|singapore|japan|south korea|new zealand|israel|uae|dubai|saudi|qatar)\b/i.test(loc)) {
    return "restricted";
  }

  return "unknown";
}

function assessNigeriaEligibility(location: string): boolean {
  return nigeriaCategory(location) === "confirmed";
}

function eligibilityNote(job: TrackedJob): string {
  const location = job.candidate_required_location.trim();
  const category = nigeriaCategory(location);

  if (category === "confirmed") {
    return `Nigeria is explicitly listed. Verify work-authorisation requirements. Provider: ${job.source}.`;
  }

  if (category === "potential") {
    return `The listing says "${location}", which may include Nigeria. Verify eligibility before applying. Provider: ${job.source}.`;
  }

  if (category === "restricted") {
    return `The listing says "${location}", which appears to restrict applicants to specific countries. Nigeria is not mentioned. Provider: ${job.source}.`;
  }

  return `Nigeria eligibility is unknown; listing location: "${location}". Verify before applying. Provider: ${job.source}.`;
}

function relevanceScore(job: TrackedJob): number {
  const title = job.title.toLowerCase();
  const text = `${job.title} ${job.description}`.toLowerCase();
  const eligibility = nigeriaCategory(job.candidate_required_location);
  const level = experienceLevel(job);
  let score = 0;

  if (/\bsoftware developer\b|\bsoftware engineer\b/i.test(title)) score += 8;
  if (/full.?stack/i.test(title)) score += 10;
  if (/backend|back-end|back end/i.test(title)) score += 10;
  if (/frontend|front-end|front end/i.test(title)) score += 6;
  if (/api|integration|automation/i.test(title)) score += 7;
  if (/devops|platform engineer|sre|site reliability/i.test(title)) score += 2;
  if (/ai coding tasks|coding tasks|code evaluator/i.test(title)) score += 9;

  if (/\bnode\.?js\b/i.test(text)) score += 6;
  if (/\btypescript\b/i.test(text)) score += 6;
  if (/\bjavascript\b/i.test(text)) score += 4;
  if (/\breact\b/i.test(text)) score += 3;
  if (/\bsupabase\b/i.test(text)) score += 5;
  if (/\brest\s*api\b|\bapis?\b|\bgraphql\b/i.test(text)) score += 4;
  if (/\bautomation\b/i.test(text)) score += 4;
  if (/\bexpress\b/i.test(text)) score += 3;
  if (/\bnext\.?js\b/i.test(text)) score += 3;

  if (/\bcontract\b|\bcontractor\b|\bfreelance\b|\bpart.time\b/i.test(text)) score += 4;

  if (level === "junior") score += 7;
  else if (level === "mid") score += 5;
  else if (level === "senior") score -= 8;
  else if (level === "staff") score -= 18;

  if (eligibility === "confirmed") score += 14;
  else if (eligibility === "potential") score += 7;
  else if (eligibility === "restricted") score -= 25;

  return Math.max(0, score);
}

function suitabilityTier(score: number): Suitability {
  if (score >= 25) return "high";
  if (score >= 14) return "medium";
  return "low";
}

function fitReason(job: TrackedJob, score: number): string {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const stack: string[] = [];

  if (/\bnode\.?js\b/i.test(text)) stack.push("Node.js");
  if (/\btypescript\b/i.test(text)) stack.push("TypeScript");
  if (/\bjavascript\b/i.test(text)) stack.push("JavaScript");
  if (/\breact\b/i.test(text)) stack.push("React");
  if (/\bsupabase\b/i.test(text)) stack.push("Supabase");
  if (/\bapis?\b|\brest\s*api\b|\bgraphql\b/i.test(text)) stack.push("APIs");
  if (/\bautomation\b/i.test(text)) stack.push("Automation");
  if (/\bai\b|agent/i.test(text)) stack.push("AI/Agent");
  if (/full.?stack/i.test(text)) stack.push("Full-stack");
  if (/backend|back-end/i.test(text)) stack.push("Backend");

  const level = experienceLevel(job);
  const eligibility = nigeriaCategory(job.candidate_required_location);
  const details: string[] = [];

  if (stack.length) details.push(`Stack: ${[...new Set(stack)].join(", ")}.`);
  if (level === "senior") details.push("Senior level (penalized).");
  if (level === "staff") details.push("Staff/principal level (strongly penalized).");
  if (level === "junior") details.push("Junior/entry-level role.");
  if (/\bcontract\b|\bcontractor\b|\bfreelance\b/i.test(text)) details.push("Contract/freelance.");
  if (eligibility === "confirmed") details.push("Nigeria explicitly listed.");
  if (eligibility === "potential") details.push("Potentially Nigeria-eligible.");
  if (eligibility === "restricted") details.push("Location restricted (penalized).");
  if (eligibility === "unknown") details.push("Eligibility must be verified.");

  details.push(`Score: ${score}.`);
  return details.join(" ");
}

async function fetchRemotive(source: {
  name: string;
  url: string;
}): Promise<{ result: SourceResult; jobs: TrackedJob[] }> {
  const result: SourceResult = { source: source.name, returned: 0, valid: 0, matched: 0 };
  const jobs: TrackedJob[] = [];

  try {
    const response = await fetchWithRetry(source.url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    }, 15000);

    if (response.status === 429) {
      result.error = "HTTP 429 (rate limited)";
      return { result, jobs };
    }
    if (!response.ok) {
      result.error = `HTTP ${response.status}`;
      return { result, jobs };
    }

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("jobs" in payload) || !Array.isArray((payload as { jobs: unknown[] }).jobs)) {
      result.error = "Unexpected Remotive response format";
      return { result, jobs };
    }

    const rawJobs = (payload as { jobs: unknown[] }).jobs;
    result.returned = rawJobs.length;
    const sampleTitles: string[] = [];

    for (const item of rawJobs) {
      const parsed = JobSchema.safeParse(item);
      if (!parsed.success || !isValidHttpUrl(parsed.data.url)) continue;

      result.valid++;
      if (!isRelevantRole(parsed.data.title)) continue;

      result.matched++;
      if (sampleTitles.length < 8) sampleTitles.push(parsed.data.title);

      jobs.push({ ...parsed.data, url: parsed.data.url, source: source.name });
    }

    result.sampleTitles = sampleTitles;
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 200) : "Unknown source error";
  }

  return { result, jobs };
}

async function fetchRemoteOk(): Promise<{ result: SourceResult; jobs: TrackedJob[] }> {
  const result: SourceResult = { source: "Remote OK", returned: 0, valid: 0, matched: 0 };
  const jobs: TrackedJob[] = [];

  try {
    const response = await fetchWithRetry(REMOTE_OK_URL, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    }, 20000);

    if (response.status === 429) {
      result.error = "HTTP 429 (rate limited)";
      return { result, jobs };
    }
    if (!response.ok) {
      result.error = `HTTP ${response.status}`;
      return { result, jobs };
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      result.error = "Expected a JSON array";
      return { result, jobs };
    }

    const items = payload.filter(item => item && typeof item === "object" && "position" in item);
    result.returned = items.length;
    const sampleTitles: string[] = [];

    for (const item of items) {
      const parsed = RemoteOkSchema.safeParse(item);
      if (!parsed.success) continue;

      const remote = parsed.data;
      let listingUrl: string | undefined;

      if (isValidHttpUrl(remote.url)) {
        const hostname = new URL(remote.url).hostname.toLowerCase();
        if (hostname === "remoteok.com" || hostname === "www.remoteok.com") listingUrl = remote.url;
      }

      if (!listingUrl && isValidHttpUrl(remote.apply_url)) listingUrl = remote.apply_url;
      if (!listingUrl) continue;

      result.valid++;
      if (!isRelevantRole(remote.position)) continue;

      result.matched++;
      if (sampleTitles.length < 8) sampleTitles.push(remote.position);

      jobs.push({
        id: remote.id,
        title: remote.position,
        company_name: remote.company ?? "Company not listed",
        candidate_required_location: remote.location ?? "Not specified",
        url: listingUrl,
        description: remote.description ?? "",
        job_type: "Unknown",
        source: "Remote OK",
      });
    }

    result.sampleTitles = sampleTitles;
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 200) : "Unknown source error";
  }

  return { result, jobs };
}

export async function discoverJobs() {
  const uniqueJobs = new Map<string, TrackedJob>();

  const remotivePromises = REMOTIVE_SOURCES.map((source, index) =>
    new Promise<{ result: SourceResult; jobs: TrackedJob[] }>(resolve => {
      setTimeout(() => resolve(fetchRemotive(source)), index * 1500);
    }),
  );

  const outcomes = await Promise.allSettled([...remotivePromises, fetchRemoteOk()]);
  const sourceResults: SourceResult[] = [];

  for (const outcome of outcomes) {
    if (outcome.status !== "fulfilled") {
      sourceResults.push({
        source: "Unknown",
        returned: 0,
        valid: 0,
        matched: 0,
        error: outcome.reason instanceof Error ? outcome.reason.message.slice(0, 200) : "Unhandled promise rejection",
      });
      continue;
    }

    sourceResults.push(outcome.value.result);
    for (const job of outcome.value.jobs) {
      const existing = uniqueJobs.get(job.url);
      if (!existing || relevanceScore(job) > relevanceScore(existing)) uniqueJobs.set(job.url, job);
    }
  }

  const rankedJobs = [...uniqueJobs.values()].sort((a, b) => relevanceScore(b) - relevanceScore(a));

  let techStackMatched = 0;
  let nigeriaConfirmed = 0;
  let nigeriaPotential = 0;
  let nigeriaRestricted = 0;
  let nigeriaUnknown = 0;
  let highSuitability = 0;
  let mediumSuitability = 0;
  let lowSuitability = 0;

  const topJobs: TopJob[] = rankedJobs.map(job => {
    const score = relevanceScore(job);
    const tier = suitabilityTier(score);
    const eligibility = nigeriaCategory(job.candidate_required_location);

    if (matchesTechStack(job)) techStackMatched++;
    if (eligibility === "confirmed") nigeriaConfirmed++;
    else if (eligibility === "potential") nigeriaPotential++;
    else if (eligibility === "restricted") nigeriaRestricted++;
    else nigeriaUnknown++;

    if (tier === "high") highSuitability++;
    else if (tier === "medium") mediumSuitability++;
    else lowSuitability++;

    return {
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location,
      score,
      tier,
      eligibility,
      url: job.url,
      reason: fitReason(job, score),
    };
  }).slice(0, 10);

  let saved = 0;
  let updated = 0;
  let duplicates = 0;
  let validationFailures = 0;
  const saveErrors: Array<{ url: string; error: string }> = [];

  for (const job of rankedJobs) {
    try {
      const result = await addJob({
        company: job.company_name,
        title: job.title,
        location: job.candidate_required_location,
        url: job.url,
        source: "job_board",
        employment_type: job.job_type,
        remote: true,
        nigeria_eligible: assessNigeriaEligibility(job.candidate_required_location),
        description: truncateDescription(job.description, 19000),
        status: "discovered",
        notes: eligibilityNote(job),
      });

      if (result.inserted) saved++;
      else if (result.updated) updated++;
      else if (result.reason === "validation") validationFailures++;
      else if (result.reason === "unchanged") duplicates++;
      else saveErrors.push({
        url: job.url,
        error: result.error ?? result.reason ?? "Unknown save error",
      });
    } catch (error) {
      saveErrors.push({
        url: job.url,
        error: error instanceof Error ? error.message.slice(0, 200) : "Unknown database error",
      });
    }
  }

  return {
    ok: true,
    checkedSources: sourceResults.length,
    sourceResults,
    matched: rankedJobs.length,
    techStackMatched,
    saved,
    updated,
    duplicates,
    validationFailures,
    skipped: duplicates,
    nigeriaEligible: nigeriaConfirmed,
    nigeriaPotential,
    nigeriaRestricted,
    nigeriaUnknown,
    highSuitability,
    mediumSuitability,
    lowSuitability,
    topJobs,
    sourceErrors: sourceResults.filter(source => !!source.error).map(source => ({
      source: source.source,
      error: source.error!,
    })),
    saveFailures: saveErrors.length,
    saveErrors: saveErrors.slice(0, 5),
  };
}
