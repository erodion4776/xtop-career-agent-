import { z } from "zod";
import { addJob } from "./tracker.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

/**
 * Relaxed schema for initial parsing.  URL *format* is validated in a
 * separate step so that an empty or malformed URL string does not silently
 * discard an otherwise useful job record.
 */
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

/** Internal representation with a guaranteed-valid URL and source tag. */
interface TrackedJob extends ParsedJob {
  url: string;
  source: string;
}

/**
 * Remote OK schema — URL fields intentionally accept any string (or absent)
 * so that empty strings from the API do not fail validation.
 */
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

// ─── Source configuration ───────────────────────────────────────────────────

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

const USER_AGENT = "XTOP-Career-Agent/0.7";

// ─── Utility helpers ────────────────────────────────────────────────────────

function isValidHttpUrl(value: string | undefined | null): value is string {
  if (!value || value.trim() === "") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Truncate a description to `maxLen` characters without breaking mid-word
 * or leaving a dangling partial HTML tag.
 */
function truncateDescription(text: string, maxLen = 19_000): string {
  if (text.length <= maxLen) return text;

  let cut = text.slice(0, maxLen);

  // Strip a trailing partial HTML tag (e.g. "<div class="foo")
  cut = cut.replace(/<[^>]*$/, "");

  // Snap back to the nearest word boundary when doing so loses < 10 %
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.9) {
    cut = cut.slice(0, lastSpace);
  }

  return cut + "…";
}

/**
 * Fetch with bounded retries for transient 5xx / network errors.
 * 4xx responses (including 429) are returned immediately so the caller
 * can handle rate-limiting without wasting retries.
 *
 * AbortSignal.timeout() requires Node ≥ 17.3 — confirmed safe for this
 * project (Node 20+ on Render, @types/node ^22).
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);

      // Never retry client errors or rate-limits
      if (res.status === 429 || (res.status >= 400 && res.status < 500)) {
        return res;
      }
      if (res.ok) return res;

      // 5xx — back off and retry
      if (attempt < maxRetries) {
        await delay(1_000 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await delay(1_000 * (attempt + 1));
      }
    }
  }

  throw lastError ?? new Error("fetch failed after retries");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Relevance & eligibility ────────────────────────────────────────────────

/**
 * A job is relevant only when its title matches a recognised software-
 * engineering role.  Technology keywords alone (e.g. "Python" appearing
 * in "Product Manager – Python Team") are **not** sufficient.
 */
function isRelevantRole(title: string): boolean {
  const t = title.toLowerCase().replace(/[–—]/g, "-").trim();

  const excluded =
    /\b(copywriter|writer|editor|sales|account executive|office assistant|administrative assistant|virtual assistant|service desk|help desk|customer support|customer service|technical support|support specialist|data annotator|video annotation|ai trainer|recruiter|marketing specialist|business development|project manager|product manager|product owner|scrum master|qa engineer|qa tester|tester|technical writer|ux designer|ui designer|graphic designer|data analyst|business analyst|human resources|talent acquisition|sourcer)\b/i;

  if (excluded.test(t)) return false;

  const developerRole =
    /\b(software developer|software engineer|web developer|web engineer|frontend developer|front-end developer|front end developer|frontend engineer|front-end engineer|front end engineer|backend developer|back-end developer|back end developer|backend engineer|back-end engineer|back end engineer|full.?stack developer|full.?stack engineer|mobile developer|mobile engineer|application developer|application engineer|api developer|api engineer|platform engineer|devops engineer|site reliability engineer|sre|programmer|automation developer|automation engineer|ai engineer|machine learning engineer|ml engineer|data engineer|cloud engineer|systems engineer|technical lead|tech lead|software architect|blockchain developer|blockchain engineer|embedded developer|embedded engineer|firmware engineer|security engineer|infrastructure engineer)\b/i;

  return developerRole.test(t);
}

/**
 * Conservative eligibility check for the `nigeria_eligible` database field.
 *
 * Returns `true` **only** when the location string explicitly mentions
 * Nigeria.  Broader terms like "Worldwide" or "Africa" do not confirm
 * eligibility and must not set this flag — they are surfaced separately
 * in the eligibility note so the user can verify manually.
 */
function assessNigeriaEligibility(location: string): boolean {
  return /\bnigeria\b/i.test(location);
}

/**
 * Broader check used only for the human-readable eligibility note.
 * "Worldwide", "Anywhere", "Africa", etc. *may* include Nigeria but
 * require manual verification.
 */
function mayIncludeNigeria(location: string): boolean {
  const loc = location.toLowerCase().replace(/[–—]/g, "-").trim();

  return (
    /\bnigeria\b/.test(loc) ||
    /\bworldwide\b/.test(loc) ||
    /\banywhere\b/.test(loc) ||
    /\bglobal(?:ly)?\b/.test(loc) ||
    /\ball countries\b/.test(loc) ||
    /\bafrica\b/.test(loc) ||
    /\bafrican countries\b/.test(loc)
  );
}

function eligibilityNote(job: TrackedJob): string {
  const location = job.candidate_required_location.trim();

  if (/\bnigeria\b/i.test(location)) {
    return (
      `Nigeria is explicitly listed. ` +
      `Verify work-authorisation requirements. Source: ${job.source}.`
    );
  }

  if (mayIncludeNigeria(location)) {
    return (
      `The listing says "${location}", which may include Nigeria. ` +
      `Verify eligibility before applying. Source: ${job.source}.`
    );
  }

  return (
    `Nigeria eligibility is unconfirmed; listing location: "${location}". ` +
    `Verify before applying. Source: ${job.source}.`
  );
}

function relevanceScore(job: TrackedJob): number {
  const t = job.title.toLowerCase();
  let score = 0;

  if (/\bsoftware developer\b|\bsoftware engineer\b/i.test(t)) score += 10;
  if (/full.?stack/i.test(t)) score += 9;
  if (/backend|back-end|back end/i.test(t)) score += 8;
  if (/frontend|front-end|front end/i.test(t)) score += 7;
  if (/typescript|node\.?js|javascript|python/i.test(t)) score += 5;
  if (/api|automation|devops|platform|ai engineer|machine learning/i.test(t)) score += 3;
  if (/senior|lead|staff|principal/i.test(t)) score += 1;

  return score;
}

// ─── Diagnostics type ───────────────────────────────────────────────────────

interface SourceResult {
  source: string;
  returned: number;
  valid: number;
  matched: number;
  sampleTitles?: string[];
  error?: string;
}

// ─── Per-source fetchers ────────────────────────────────────────────────────

async function fetchRemotive(source: {
  name: string;
  url: string;
}): Promise<{ result: SourceResult; jobs: TrackedJob[] }> {
  const result: SourceResult = {
    source: source.name,
    returned: 0,
    valid: 0,
    matched: 0,
  };
  const jobs: TrackedJob[] = [];

  try {
    const response = await fetchWithRetry(source.url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 429) {
      result.error = "HTTP 429 (rate limited)";
      return { result, jobs };
    }
    if (!response.ok) {
      result.error = `HTTP ${response.status}`;
      return { result, jobs };
    }

    const payload: unknown = await response.json();

    if (
      !payload ||
      typeof payload !== "object" ||
      !("jobs" in payload) ||
      !Array.isArray((payload as Record<string, unknown>).jobs)
    ) {
      result.error = "Unexpected Remotive response format";
      return { result, jobs };
    }

    const rawJobs = (payload as { jobs: unknown[] }).jobs;
    result.returned = rawJobs.length;
    const sampleTitles: string[] = [];

    for (const item of rawJobs) {
      const parsed = JobSchema.safeParse(item);
      if (!parsed.success) continue;

      const data = parsed.data;

      // Separate URL validation — a bad URL must not silently kill the record
      if (!isValidHttpUrl(data.url)) continue;

      result.valid++;

      // Only collect sample titles from fully validated entries
      if (sampleTitles.length < 8) sampleTitles.push(data.title);

      if (!isRelevantRole(data.title)) continue;

      result.matched++;
      jobs.push({ ...data, url: data.url, source: source.name });
    }

    result.sampleTitles = sampleTitles;
  } catch (error) {
    result.error =
      error instanceof Error
        ? error.message.slice(0, 200)
        : "Unknown source error";
  }

  return { result, jobs };
}

async function fetchRemoteOk(): Promise<{
  result: SourceResult;
  jobs: TrackedJob[];
}> {
  const result: SourceResult = {
    source: "Remote OK",
    returned: 0,
    valid: 0,
    matched: 0,
  };
  const jobs: TrackedJob[] = [];

  try {
    const response = await fetchWithRetry(REMOTE_OK_URL, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });

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

    // First element is often a legal-notice object, not a job.
    const items = payload.filter(
      (item) => item && typeof item === "object" && "position" in item,
    );

    result.returned = items.length;
    const sampleTitles: string[] = [];

    for (const item of items) {
      const parsed = RemoteOkSchema.safeParse(item);
      if (!parsed.success) continue;

      const remote = parsed.data;

      // ── URL resolution: never fabricate a URL ──────────────────────
      // 1. Prefer the canonical Remote OK listing URL (hostname must be
      //    remoteok.com) so we don't store a redirect or third-party link.
      // 2. Fall back to apply_url as-is from the feed when it provides a
      //    genuine application destination.
      // 3. Skip the job entirely when neither is usable.  We never
      //    construct a URL from the job ID.
      let listingUrl: string | undefined;

      if (isValidHttpUrl(remote.url)) {
        const hostname = new URL(remote.url).hostname.toLowerCase();
        if (hostname === "remoteok.com" || hostname === "www.remoteok.com") {
          listingUrl = remote.url;
        }
      }

      if (!listingUrl && isValidHttpUrl(remote.apply_url)) {
        listingUrl = remote.apply_url;
      }

      if (!listingUrl) continue;

      result.valid++;

      if (sampleTitles.length < 8) sampleTitles.push(remote.position);

      if (!isRelevantRole(remote.position)) continue;

      result.matched++;
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
    result.error =
      error instanceof Error
        ? error.message.slice(0, 200)
        : "Unknown source error";
  }

  return { result, jobs };
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function discoverJobs() {
  const uniqueJobs = new Map<string, TrackedJob>();

  // ── Fetch all sources concurrently ─────────────────────────────────
  // Remotive requests are staggered by 1.5 s to reduce the chance of
  // triggering HTTP 429 rate limits across the three endpoints.
  const remotivePromises = REMOTIVE_SOURCES.map(
    (source, i) =>
      new Promise<{ result: SourceResult; jobs: TrackedJob[] }>((resolve) =>
        setTimeout(() => resolve(fetchRemotive(source)), i * 1_500),
      ),
  );

  const outcomes = await Promise.allSettled([
    ...remotivePromises,
    fetchRemoteOk(),
  ]);

  const sourceResults: SourceResult[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      const { result, jobs } = outcome.value;
      sourceResults.push(result);

      for (const job of jobs) {
        const existing = uniqueJobs.get(job.url);
        if (!existing || relevanceScore(job) > relevanceScore(existing)) {
          uniqueJobs.set(job.url, job);
        }
      }
    } else {
      sourceResults.push({
        source: "Unknown",
        returned: 0,
        valid: 0,
        matched: 0,
        error:
          outcome.reason instanceof Error
            ? outcome.reason.message.slice(0, 200)
            : "Unhandled promise rejection",
      });
    }
  }

  // ── Rank, persist, report ──────────────────────────────────────────

  const rankedJobs = [...uniqueJobs.values()].sort(
    (a, b) => relevanceScore(b) - relevanceScore(a),
  );

  let saved = 0;
  let skipped = 0;
  let nigeriaEligible = 0;
  const saveErrors: Array<{ url: string; error: string }> = [];

  for (const job of rankedJobs) {
    // Only explicitly-Nigerian locations set the boolean flag.
    // "Worldwide" / "Africa" etc. are surfaced in the note, not the flag.
    const eligible = assessNigeriaEligibility(job.candidate_required_location);

    try {
      const result = await addJob({
        company: job.company_name,
        title: job.title,
        location: job.candidate_required_location,
        url: job.url,
        source: "job_board",
        employment_type: job.job_type,
        remote: true,
        nigeria_eligible: eligible,
        description: truncateDescription(job.description),
        status: "discovered",
        notes: eligibilityNote(job),
      });

      if (result) {
        saved++;
        if (eligible) nigeriaEligible++;
      } else {
        skipped++;
      }
    } catch (error) {
      saveErrors.push({
        url: job.url,
        error:
          error instanceof Error
            ? error.message.slice(0, 200)
            : "Unknown database error",
      });
    }
  }

  return {
    ok: true,
    checkedSources: sourceResults.length,
    sourceResults,
    matched: rankedJobs.length,
    saved,
    skipped,
    nigeriaEligible,
    sourceErrors: sourceResults
      .filter((s) => s.error)
      .map((s) => ({ source: s.source, error: s.error! })),
    saveFailures: saveErrors.length,
    saveErrors: saveErrors.slice(0, 5),
  };
}
