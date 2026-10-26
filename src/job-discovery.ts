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

const SEARCH_URLS = [
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

function isRelevantRole(job: RemoteJob): boolean {

function isRelevantRole(job: RemoteJob): boolean {
  const text = `${job.title} ${job.description}`.toLowerCase();

  return /software|developer|engineer|typescript|javascript|node\.?js|backend|back-end|full.?stack|automation|python|api\b|programmer|web development/i.test(text);
}


return /software|developer|engineer|typescript|javascript|node.?js|backend|back-end|full.?stack|automation|python|api\b|programmer|web development/i.test(text);
}

function assessNigeriaEligibility(job: RemoteJob): boolean {
const location = job.candidate_required_location.toLowerCase();

// Only mark eligibility when the location explicitly indicates
// Nigeria or a sufficiently broad location policy.
return (
/\bnigeria\b|\bworldwide\b|\banywhere\b|\bglobal\b|\ball countries\b|\bafrica\b|\bafrican countries\b/i.test(location)
);
}

export async function discoverJobs() {
const uniqueJobs = new Map<string, RemoteJob>();

const sourceResults: Array<{
source: string;
returned: number;
matched: number;
error?: string;
}> = [];

for (const source of SEARCH_URLS) {
let returned = 0;
let matched = 0;

try {
  const response = await fetch(source.url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "XTOP-Career-Agent/0.3"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    sourceResults.push({
      source: source.name,
      returned: 0,
      matched: 0,
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
      returned: 0,
      matched: 0,
      error: "Unexpected response format"
    });
    continue;
  }

  returned = payload.jobs.length;

  for (const item of payload.jobs) {
    const parsed = JobSchema.safeParse(item);
    if (!parsed.success) continue;

    const job = parsed.data;

    if (!isRelevantRole(job)) continue;

    matched++;
    uniqueJobs.set(job.url, job);
  }

  sourceResults.push({
    source: source.name,
    returned,
    matched
  });
} catch (error) {
  sourceResults.push({
    source: source.name,
    returned,
    matched,
    error: error instanceof Error
      ? error.message.slice(0, 200)
      : "Unknown source error"
  });
}

}

let saved = 0;
let skipped = 0;
let nigeriaEligible = 0;

const saveErrors: Array<{
url: string;
error: string;
}> = [];

for (const job of uniqueJobs.values()) {
const eligible = assessNigeriaEligibility(job);

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
    notes: eligible
      ? "Location appears compatible with Nigeria. Verify the original listing before applying."
      : "Remote role found, but Nigeria eligibility is unconfirmed. Verify location restrictions before applying."
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
checkedSources: SEARCH_URLS.length,
sourceResults,
matched: uniqueJobs.size,
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
