import { z } from "zod";
import { addJob } from "./tracker.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().min(1),
  company_name: z.string().optional().default("Company not listed"),
  candidate_required_location: z.string().optional().default("Not specified"),
  url: z.string().optional().default(""),
  description: z.string().optional().default(""),
  job_type: z.string().optional().default("Unknown"),
  publication_date: z.string().optional(),
  salary: z.string().optional(),
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
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
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

const USER_AGENT = "XTOP-Career-Agent/1.2";

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

function truncateDescription(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  var cut = text.slice(0, maxLen);
  cut = cut.replace(/<[^>]*$/, "");

  var lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.9) {
    cut = cut.slice(0, lastSpace);
  }

  return cut + "...";
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries?: number,
): Promise<Response> {
  var retries = maxRetries ?? 2;
  var lastError: Error | undefined;

  for (var attempt = 0; attempt <= retries; attempt++) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    try {
      var res = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (res.status === 429) return res;

      if (res.status >= 400 && res.status < 500) {
        return res;
      }

      if (res.ok || attempt === retries) {
        return res;
      }
    } catch (err) {
      lastError =
        err instanceof Error ? err : new Error(String(err));

      if (attempt === retries) {
        throw lastError;
      }
    } finally {
      clearTimeout(timer);
    }

    await delay(1000 * (attempt + 1));
  }

  throw lastError ?? new Error("fetch failed after retries");
}

function delay(ms: number): Promise<void> {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ─── Relevance filtering ────────────────────────────────────────────────────

function isRelevantRole(title: string): boolean {
  var t = title.toLowerCase().replace(/[\u2013\u2014]/g, "-").trim();

  var excluded =
    /\b(copywriter|writer|editor|sales|account executive|office assistant|administrative assistant|virtual assistant|service desk|help desk|customer support|customer service|technical support|support specialist|data annotator|video annotation|ai trainer|recruiter|marketing specialist|business development|project manager|product manager|product owner|scrum master|qa engineer|qa tester|tester|technical writer|ux designer|ui designer|graphic designer|data analyst|business analyst|human resources|talent acquisition|sourcer|content strategist|seo specialist|community manager|operations manager|office manager|executive assistant|legal|compliance|finance|accounting|bookkeeper|payroll|procurement|logistics|supply chain)\b/i;

  if (excluded.test(t)) return false;

  var developerRole =
    /\b(software developer|software engineer|web developer|web engineer|frontend developer|front-end developer|front end developer|frontend engineer|front-end engineer|front end engineer|backend developer|back-end developer|back end developer|backend engineer|back-end engineer|back end engineer|full.?stack developer|full.?stack engineer|mobile developer|mobile engineer|application developer|application engineer|api developer|api engineer|platform engineer|devops engineer|site reliability engineer|sre|programmer|automation developer|automation engineer|ai engineer|machine learning engineer|ml engineer|data engineer|cloud engineer|systems engineer|technical lead|tech lead|software architect|solutions architect|blockchain developer|blockchain engineer|embedded developer|embedded engineer|firmware engineer|security engineer|infrastructure engineer|integration engineer|release engineer|build engineer)\b/i;

  return developerRole.test(t);
}

function matchesTechStack(job: TrackedJob): boolean {
  var haystack = (job.title + " " + job.description).toLowerCase();

  return /\b(node\.?js|typescript|javascript|react|next\.?js|express|backend|back-end|full.?stack|supabase|api\b|apis\b|automation|rest\s*api|graphql|ai.?agent|llm|agent.?integration)\b/i.test(
    haystack,
  );
}

// ─── Experience level detection ─────────────────────────────────────────────

type ExperienceLevel = "junior" | "mid" | "senior" | "staff" | "unknown";

function detectExperienceLevel(job: TrackedJob): ExperienceLevel {
  var haystack = (job.title + " " + job.description).toLowerCase();

  if (/\b(staff|principal|distinguished|fellow)\b/i.test(haystack)) return "staff";
  if (/\b(senior|sr\.?|lead|head of|director|vp of|chief|architect)\b/i.test(haystack)) return "senior";
  if (/\b(junior|jr\.?|entry.?level|graduate|intern|associate)\b/i.test(haystack)) return "junior";
  if (/\b(mid.?level|intermediate)\b/i.test(haystack)) return "mid";

  return "unknown";
}

/**
 * Detect explicit years-of-experience requirements from the description.
 * Returns the minimum years mentioned, or 0 if none found.
 */
function detectMinYearsRequired(description: string): number {
  var d = description.toLowerCase();

  var patterns = [
    /(\d+)\+?\s*years?\s*(of\s*)?(experience|exp\.?)/i,
    /minimum\s*(of\s*)?(\d+)\s*years?/i,
    /at\s*least\s*(\d+)\s*years?/i,
    /(\d+)\s*-\s*\d+\s*years?\s*(of\s*)?(experience|exp\.?)/i,
  ];

  var minYears = 0;

  for (var i = 0; i < patterns.length; i++) {
    var match = d.match(patterns[i]);
    if (match) {
      var years = parseInt(match[1] || match[2] || "0", 10);
      if (years > minYears) minYears = years;
    }
  }

  return minYears;
}

// ─── Relevance scoring ──────────────────────────────────────────────────────

/**
 * Suitability score weighted for the user's profile:
 * - Strong preference for Node.js, TypeScript, APIs, Supabase,
 *   automation, AI-agent integration, and full-stack roles
 * - Penalty for senior/staff/architect roles and high experience
 *   requirements that exceed demonstrated experience
 * - Bonus for contract and freelance opportunities
 *
 * Used for ranking and suitability classification.
 */
function relevanceScore(job: TrackedJob): number {
  var t = job.title.toLowerCase();
  var haystack = (job.title + " " + job.description).toLowerCase();
  var score = 0;

  // ── Role type (title-based) ────────────────────────────────────────
  if (/full.?stack/i.test(t)) score += 14;
  else if (/backend|back-end|back end/i.test(t)) score += 12;
  else if (/api developer|api engineer|integration engineer/i.test(t)) score += 11;
  else if (/automation/i.test(t)) score += 10;
  else if (/\bsoftware developer\b|\bsoftware engineer\b/i.test(t)) score += 9;
  else if (/frontend|front-end|front end/i.test(t)) score += 7;
  else if (/mobile developer|mobile engineer/i.test(t)) score += 6;
  else if (/devops|platform engineer|sre|site reliability/i.test(t)) score += 5;

  // ── User's preferred stack (title + description) ───────────────────
  if (/\bnode\.?js\b/i.test(haystack)) score += 8;
  if (/\btypescript\b/i.test(haystack)) score += 8;
  if (/\bsupabase\b/i.test(haystack)) score += 7;
  if (/\brest\s*api\b|\bapi\b|\bapis\b|\bgraphql\b/i.test(haystack)) score += 5;
  if (/\breact\b/i.test(haystack)) score += 5;
  if (/\bautomation\b/i.test(haystack)) score += 5;
  if (/\bai.?agent\b|\bagent.?integration\b|\bllm\b/i.test(haystack)) score += 6;
  if (/\bexpress\b/i.test(haystack)) score += 4;
  if (/\bnext\.?js\b/i.test(haystack)) score += 4;
  if (/\bjavascript\b/i.test(haystack)) score += 3;

  // ── Other tech (lower weight) ──────────────────────────────────────
  if (/\bpython\b/i.test(haystack)) score += 2;
  if (/ai engineer|machine learning|ml engineer/i.test(t)) score += 2;
  if (/cloud engineer|aws|gcp|azure/i.test(t)) score += 2;

  // ── Experience level adjustment ────────────────────────────────────
  var level = detectExperienceLevel(job);
  if (level === "staff") score -= 8;
  else if (level === "senior") score -= 4;
  else if (level === "mid") score += 2;
  else if (level === "junior") score += 1;

  // ── Explicit years-of-experience penalty ───────────────────────────
  var minYears = detectMinYearsRequired(job.description);
  if (minYears >= 10) score -= 6;
  else if (minYears >= 7) score -= 4;
  else if (minYears >= 5) score -= 2;

  // ── Contract/freelance bonus ───────────────────────────────────────
  if (/\b(contract|freelance|part.?time|temporary|fixed.?term)\b/i.test(haystack)) {
    score += 4;
  }

  return score;
}

type SuitabilityTier = "high" | "medium" | "low";

function classifySuitability(score: number): SuitabilityTier {
  if (score >= 25) return "high";
  if (score >= 14) return "medium";
  return "low";
}

// ─── Nigeria eligibility ────────────────────────────────────────────────────

function assessNigeriaEligibility(location: string): boolean {
  return /\bnigeria\b/i.test(location);
}

function nigeriaCategory(
  location: string,
): "confirmed" | "potential" | "restricted" | "unknown" {
  var loc = location.toLowerCase().replace(/[\u2013\u2014]/g, "-").trim();

  if (!loc || loc === "remote" || loc === "not specified" || loc === "n/a" || loc === "-") {
    return "unknown";
  }

  if (/\bnigeria\b/.test(loc)) return "confirmed";

  if (
    /\bworldwide\b/.test(loc) ||
    /\banywhere\b/.test(loc) ||
    /\bglobal(?:ly)?\b/.test(loc) ||
    /\ball countries\b/.test(loc) ||
    /\bafrica\b/.test(loc) ||
    /\bafrican countries\b/.test(loc) ||
    /\bemerging markets\b/.test(loc) ||
    /\bemea\b/.test(loc)
  ) {
    return "potential";
  }

  var specificCountry =
    /\b(us|usa|united states|america|uk|united kingdom|britain|england|europe|eu|canada|australia|germany|france|netherlands|sweden|norway|denmark|finland|switzerland|austria|belgium|ireland|spain|italy|portugal|poland|czech|romania|brazil|mexico|india|singapore|japan|south korea|new zealand|israel|uae|dubai|saudi|qatar)\b/i;

  if (specificCountry.test(loc)) return "restricted";

  return "unknown";
}

function eligibilityNote(job: TrackedJob): string {
  var location = job.candidate_required_location.trim();
  var cat = nigeriaCategory(location);

  if (cat === "confirmed") {
    return (
      "Nigeria is explicitly listed. " +
      "Verify work-authorisation requirements. Provider: " + job.source + "."
    );
  }

  if (cat === "potential") {
    return (
      "The listing says \"" + location + "\", which may include Nigeria. " +
      "Verify eligibility before applying. Provider: " + job.source + "."
    );
  }

  if (cat === "restricted") {
    return (
      "The listing says \"" + location + "\", which appears to restrict " +
      "applicants to specific countries. Nigeria is not mentioned. " +
      "Provider: " + job.source + "."
    );
  }

  return (
    "Nigeria eligibility is unknown; listing location: \"" + location + "\". " +
    "Verify before applying. Provider: " + job.source + "."
  );
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

interface TopJob {
  title: string;
  company: string;
  score: number;
  tier: SuitabilityTier;
  eligibility: string;
  url: string;
}

// ─── Per-source fetchers ────────────────────────────────────────────────────

async function fetchRemotive(source: {
  name: string;
  url: string;
}): Promise<{ result: SourceResult; jobs: TrackedJob[] }> {
  var result: SourceResult = {
    source: source.name,
    returned: 0,
    valid: 0,
    matched: 0,
  };
  var jobs: TrackedJob[] = [];

  try {
    var response = await fetchWithRetry(
      source.url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      },
      15000,
    );

    if (response.status === 429) {
      result.error = "HTTP 429 (rate limited)";
      return { result: result, jobs: jobs };
    }
    if (!response.ok) {
      result.error = "HTTP " + response.status;
      return { result: result, jobs: jobs };
    }

    var payload: unknown = await response.json();

    if (
      !payload ||
      typeof payload !== "object" ||
      !("jobs" in payload) ||
      !Array.isArray((payload as Record<string, unknown>).jobs)
    ) {
      result.error = "Unexpected Remotive response format";
      return { result: result, jobs: jobs };
    }

    var rawJobs = (payload as { jobs: unknown[] }).jobs;
    result.returned = rawJobs.length;
    var sampleTitles: string[] = [];

    for (var i = 0; i < rawJobs.length; i++) {
      var item = rawJobs[i];
      var parsed = JobSchema.safeParse(item);
      if (!parsed.success) continue;

      var data = parsed.data;
      if (!isValidHttpUrl(data.url)) continue;

      result.valid++;

      if (!isRelevantRole(data.title)) continue;

      result.matched++;

      if (sampleTitles.length < 8) sampleTitles.push(data.title);

      jobs.push({ ...data, url: data.url, source: source.name });
    }

    result.sampleTitles = sampleTitles;
  } catch (error) {
    result.error =
      error instanceof Error
        ? error.message.slice(0, 200)
        : "Unknown source error";
  }

  return { result: result, jobs: jobs };
}

async function fetchRemoteOk(): Promise<{
  result: SourceResult;
  jobs: TrackedJob[];
}> {
  var result: SourceResult = {
    source: "Remote OK",
    returned: 0,
    valid: 0,
    matched: 0,
  };
  var jobs: TrackedJob[] = [];

  try {
    var response = await fetchWithRetry(
      REMOTE_OK_URL,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      },
      20000,
    );

    if (response.status === 429) {
      result.error = "HTTP 429 (rate limited)";
      return { result: result, jobs: jobs };
    }
    if (!response.ok) {
      result.error = "HTTP " + response.status;
      return { result: result, jobs: jobs };
    }

    var payload: unknown = await response.json();

    if (!Array.isArray(payload)) {
      result.error = "Expected a JSON array";
      return { result: result, jobs: jobs };
    }

    var items = payload.filter(
      function (item: unknown) {
        return item && typeof item === "object" && "position" in item;
      },
    );

    result.returned = items.length;
    var sampleTitles: string[] = [];

    for (var i = 0; i < items.length; i++) {
      var parsed = RemoteOkSchema.safeParse(items[i]);
      if (!parsed.success) continue;

      var remote = parsed.data;
      var listingUrl: string | undefined;

      if (isValidHttpUrl(remote.url)) {
        var hostname = new URL(remote.url).hostname.toLowerCase();
        if (hostname === "remoteok.com" || hostname === "www.remoteok.com") {
          listingUrl = remote.url;
        }
      }

      if (!listingUrl && isValidHttpUrl(remote.apply_url)) {
        listingUrl = remote.apply_url;
      }

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
        publication_date: remote.date,
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

  return { result: result, jobs: jobs };
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function discoverJobs() {
  var uniqueJobs = new Map<string, TrackedJob>();

  var remotivePromises = REMOTIVE_SOURCES.map(
    function (source, i) {
      return new Promise<{ result: SourceResult; jobs: TrackedJob[] }>(
        function (resolve) {
          setTimeout(function () { resolve(fetchRemotive(source)); }, i * 1500);
        },
      );
    },
  );

  var outcomes = await Promise.allSettled([
    ...remotivePromises,
    fetchRemoteOk(),
  ]);

  var sourceResults: SourceResult[] = [];

  for (var o = 0; o < outcomes.length; o++) {
    var outcome = outcomes[o];
    if (outcome.status === "fulfilled") {
      var value = outcome.value;
      sourceResults.push(value.result);

      for (var j = 0; j < value.jobs.length; j++) {
        var job = value.jobs[j];
        var existing = uniqueJobs.get(job.url);
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

  var rankedJobs = [...uniqueJobs.values()].sort(
    function (a, b) { return relevanceScore(b) - relevanceScore(a); },
  );

  // ── Classify every matched job ─────────────────────────────────────

  var techStackMatched = 0;
  var nigeriaConfirmed = 0;
  var nigeriaPotential = 0;
  var nigeriaRestricted = 0;
  var nigeriaUnknown = 0;
  var highSuitability = 0;
  var mediumSuitability = 0;
  var lowSuitability = 0;
  var topJobs: TopJob[] = [];

  for (var k = 0; k < rankedJobs.length; k++) {
    var rj = rankedJobs[k];
    var rjScore = relevanceScore(rj);
    var rjTier = classifySuitability(rjScore);

    if (matchesTechStack(rj)) techStackMatched++;

    var cat = nigeriaCategory(rj.candidate_required_location);
    if (cat === "confirmed") nigeriaConfirmed++;
    else if (cat === "potential") nigeriaPotential++;
    else if (cat === "restricted") nigeriaRestricted++;
    else nigeriaUnknown++;

    if (rjTier === "high") highSuitability++;
    else if (rjTier === "medium") mediumSuitability++;
    else lowSuitability++;

    // Collect top 10 jobs for the priority queue
    if (topJobs.length < 10) {
      topJobs.push({
        title: rj.title,
        company: rj.company_name,
        score: rjScore,
        tier: rjTier,
        eligibility: cat,
        url: rj.url,
      });
    }
  }

  // ── Persist ────────────────────────────────────────────────────────

  var saved = 0;
  var updated = 0;
  var duplicates = 0;
  var validationFailures = 0;
  var saveErrors: Array<{ url: string; error: string }> = [];

  for (var m = 0; m < rankedJobs.length; m++) {
    var dj = rankedJobs[m];
    var eligible = assessNigeriaEligibility(dj.candidate_required_location);

    try {
      var result = await addJob({
        company: dj.company_name,
        title: dj.title,
        location: dj.candidate_required_location,
        url: dj.url,
        source: "job_board",
        employment_type: dj.job_type,
        remote: true,
        nigeria_eligible: eligible,
        description: truncateDescription(dj.description, 19000),
        status: "discovered",
        notes: eligibilityNote(dj),
      });

      if (result.inserted) {
        saved++;
      } else if (result.updated) {
        updated++;
      } else if (result.reason === "validation") {
        validationFailures++;
      } else if (result.reason === "unchanged") {
        duplicates++;
      } else {
        saveErrors.push({
          url: dj.url,
          error: result.error ?? result.reason ?? "Unknown save error",
        });
      }
    } catch (error) {
      saveErrors.push({
        url: dj.url,
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
    sourceResults: sourceResults,
    matched: rankedJobs.length,
    techStackMatched: techStackMatched,
    saved: saved,
    updated: updated,
    duplicates: duplicates,
    validationFailures: validationFailures,
    skipped: duplicates,
    nigeriaEligible: nigeriaConfirmed,
    nigeriaPotential: nigeriaPotential,
    nigeriaRestricted: nigeriaRestricted,
    nigeriaUnknown: nigeriaUnknown,
    highSuitability: highSuitability,
    mediumSuitability: mediumSuitability,
    lowSuitability: lowSuitability,
    topJobs: topJobs,
    sourceErrors: sourceResults
      .filter(function (s) { return !!s.error; })
      .map(function (s) { return { source: s.source, error: s.error! }; }),
    saveFailures: saveErrors.length,
    saveErrors: saveErrors.slice(0, 5),
  };
}
