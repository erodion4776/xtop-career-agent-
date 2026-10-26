
import { z } from "zod";
import { addJob } from "./tracker.js";

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().min(1),
  company_name: z.string().optional().default("Company not listed"),
  candidate_required_location: z.string().optional().default("Not specified"),
  url: z.string().url(),
  description: z.string().optional().default(""),
  job_type: z.string().optional().default("Unknown")
});

type RemoteJob = z.infer<typeof JobSchema>;

const REMOTIVE_URLS = [
  {
    name: "Remotive software development",
    url: "https://remotive.com/api/remote-jobs?category=software-dev&limit=50"
  },
  {
    name: "Remotive TypeScript",
    url: "https://remotive.com/api/remote-jobs?search=typescript&limit=50"
  },
  {
    name: "Remotive Node.js",
    url: "https://remotive.com/api/remote-jobs?search=node.js&limit=50"
  }
];

const REMOTE_OK_URL = "https://remoteok.com/api";

const RemoteOkSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  position: z.string().min(1),
  company: z.string().optional(),
  location: z.string().optional(),
  url: z.string().url().optional(),
  apply_url: z.string().url().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  date: z.string().optional()
});

function isRelevantRole(job: RemoteJob): boolean {
  const title = job.title.toLowerCase().replace(/[–—]/g, "-").trim();

  const excluded =
    /\b(copywriter|writer|editor|sales|account executive|office assistant|administrative assistant|virtual assistant|service desk|help desk|customer support|customer service|technical support|support specialist|data annotator|video annotation|ai trainer|recruiter|marketing specialist|business development)\b/i;

  if (excluded.test(title)) return false;

  const developerTitle =
    /\b(software developer|software engineer|web developer|web engineer|frontend developer|front-end developer|front end developer|frontend engineer|front-end engineer|front end engineer|backend developer|back-end developer|back end developer|backend engineer|back-end engineer|back end engineer|full.?stack developer|full.?stack engineer|mobile developer|mobile engineer|application developer|application engineer|api developer|api engineer|platform engineer|devops engineer|site reliability engineer|sre|programmer|automation developer|automation engineer|ai engineer|machine learning engineer|ml engineer|data engineer|cloud engineer|systems engineer|technical lead|tech lead|software architect)\b/i;

  const technicalTitle =
    /\b(node\.?js|typescript|javascript|python|react|angular|vue|java|golang|ruby on rails|rails engineer|php developer|laravel|django|fastapi|api development|software development|web development|mobile development|devops|machine learning|artificial intelligence|full.?stack|backend|back-end|frontend|front-end)\b/i;

  return developerTitle.test(title) || technicalTitle.test(title);
}

function assessNigeriaEligibility(job: RemoteJob): boolean {
  const location = job.candidate_required_location
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .trim();

  return (
    /\bnigeria\b/.test(location) ||
    /\bworldwide\b/.test(location) ||
    /\banywhere\b/.test(location) ||
    /\bglobal(?:ly)?\b/.test(location) ||
    /\ball countries\b/.test(location) ||
    /\bafrica\b/.test(location) ||
    /\bafrican countries\b/.test(location)
  );
}

function eligibilityNote(job: RemoteJob, source: string): string {
  const location = job.candidate_required_location.trim();

  if (/\bnigeria\b/i.test(location)) {
    return `Nigeria is explicitly listed. Verify work-authorisation requirements. Source: ${source}.`;
  }

  if (assessNigeriaEligibility(job)) {
    return `The listing says "${location}", which may include Nigeria. Verify eligibility before applying. Source: ${source}.`;
  }

  return `Nigeria eligibility is unconfirmed; listing location: "${location}". Verify before applying. Source: ${source}.`;
}

function relevanceScore(job: RemoteJob): number {
  const title = job.title.toLowerCase();
  let score = 0;

  if (/\bsoftware developer\b|\bsoftware engineer\b/i.test(title)) score += 10;
  if (/full.?stack/i.test(title)) score += 9;
  if (/backend|back-end|back end/i.test(title)) score += 8;
  if (/frontend|front-end|front end/i.test(title)) score += 7;
  if (/typescript|node\.?js|javascript|python/i.test(title)) score += 5;
  if (/api|automation|devops|platform|ai engineer|machine learning/i.test(title)) score += 3;
  if (/senior|lead|staff|principal/i.test(title)) score += 1;

  return score;
}

function addUniqueJob(
  jobs: Map<string, RemoteJob>,
  job: RemoteJob
): void {
  const existing = jobs.get(job.url);

  if (!existing || relevanceScore(job) > relevanceScore(existing)) {
    jobs.set(job.url, job);
  }
}

export async function discoverJobs() {
  const uniqueJobs = new Map<string, RemoteJob>();

  const sourceResults: Array<{
    source: string;
    returned: number;
    valid: number;
    matched: number;
    sampleTitles?: string[];
    error?: string;
  }> = [];

  // Remotive searches
  for (const source of REMOTIVE_URLS) {
    let returned = 0;
    let valid = 0;
    let matched = 0;

    try {
      const response = await fetch(source.url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "XTOP-Career-Agent/0.6"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        sourceResults.push({
          source: source.name,
          returned, valid, matched,
          error: `HTTP ${response.status}`
        });
        continue;
      }

      const payload: unknown = await response.json();

      if (
        !payload ||
        typeof payload !== "object" ||
        !("jobs" in payload) ||
        !Array.isArray(payload.jobs)
      ) {
        sourceResults.push({
          source: source.name,
          returned, valid, matched,
          error: "Unexpected Remotive response format"
        });
        continue;
      }

      returned = payload.jobs.length;
      const sampleTitles: string[] = [];

      for (const item of payload.jobs) {
        if (
          item &&
          typeof item === "object" &&
          "title" in item &&
          typeof item.title === "string" &&
          sampleTitles.length < 8
        ) {
          sampleTitles.push(item.title);
        }

        const parsed = JobSchema.safeParse(item);
        if (!parsed.success) continue;

        valid++;
        const job = parsed.data;

        if (!isRelevantRole(job)) continue;

        matched++;
        addUniqueJob(uniqueJobs, job);
      }

      sourceResults.push({
        source: source.name,
        returned, valid, matched, sampleTitles
      });
    } catch (error) {
      sourceResults.push({
        source: source.name,
        returned, valid, matched,
        error: error instanceof Error
          ? error.message.slice(0, 200)
          : "Unknown source error"
      });
    }
  }

  // Remote OK's independent public JSON feed
  {
    let returned = 0;
    let valid = 0;
    let matched = 0;

    try {
      const response = await fetch(REMOTE_OK_URL, {
        headers: {
          Accept: "application/json",
          "User-Agent": "XTOP-Career-Agent/0.6"
        },
        signal: AbortSignal.timeout(20000)
      });

      if (!response.ok) {
        sourceResults.push({
          source: "Remote OK",
          returned, valid, matched,
          error: `HTTP ${response.status}`
        });
      } else {
        const payload: unknown = await response.json();

        if (!Array.isArray(payload)) {
          sourceResults.push({
            source: "Remote OK",
            returned, valid, matched,
            error: "Expected a JSON array"
          });
        } else {
          // The feed may begin with a legal notice rather than a job.
          const items = payload.filter(item =>
            item &&
            typeof item === "object" &&
            "position" in item
          );

          returned = items.length;
          const sampleTitles: string[] = [];

          for (const item of items) {
            const parsed = RemoteOkSchema.safeParse(item);
            if (!parsed.success) continue;

            valid++;
            const remote = parsed.data;

            if (sampleTitles.length < 8) {
              sampleTitles.push(remote.position);
            }

            // Only accept original Remote OK listing URLs.
            let listingUrl: string | undefined;

            if (
              remote.url &&
              /^https:\/\/(?:www\.)?remoteok\.com\//i.test(remote.url)
            ) {
              listingUrl = remote.url;
            } else if (remote.id !== undefined) {
              listingUrl = `https://remoteok.com/remote-jobs/${encodeURIComponent(String(remote.id))}`;
            }

            if (!listingUrl) continue;

            const normalised = JobSchema.safeParse({
              title: remote.position,
              company_name: remote.company || "Company not listed",
              candidate_required_location: remote.location || "Not specified",
              url: listingUrl,
              description: remote.description || "",
              job_type: "Unknown"
            });

            if (!normalised.success || !isRelevantRole(normalised.data)) {
              continue;
            }

            matched++;
            addUniqueJob(uniqueJobs, normalised.data);
          }

          sourceResults.push({
            source: "Remote OK",
            returned, valid, matched, sampleTitles
          });
        }
      }
    } catch (error) {
      sourceResults.push({
        source: "Remote OK",
        returned, valid, matched,
        error: error instanceof Error
          ? error.message.slice(0, 200)
          : "Unknown source error"
      });
    }
  }

  const rankedJobs = [...uniqueJobs.values()].sort(
    (a, b) => relevanceScore(b) - relevanceScore(a)
  );

  let saved = 0;
  let skipped = 0;
  let nigeriaEligible = 0;

  const saveErrors: Array<{ url: string; error: string }> = [];

  for (const job of rankedJobs) {
    const eligible = assessNigeriaEligibility(job);
    const source = job.url.includes("remoteok.com")
      ? "Remote OK"
      : "Remotive";

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
        description: job.description.slice(0, 19000),
        status: "discovered",
        notes: eligibilityNote(job, source)
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
        error: error instanceof Error
          ? error.message.slice(0, 200)
          : "Unknown database error"
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
      .filter(source => source.error)
      .map(source => ({
        source: source.source,
        error: source.error
      })),
    saveFailures: saveErrors.length,
    saveErrors: saveErrors.slice(0, 5)
  };
}
