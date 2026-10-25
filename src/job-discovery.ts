import { z } from "zod";
import { addJob } from "./tracker.js";

const JobSchema = z.object({
id: z.string().optional(),
title: z.string().min(1),
company_name: z.string().optional().default("Company not listed"),
candidate_required_location: z.string().optional().default("Remote"),
url: z.string().url(),
description: z.string().optional().default(""),
job_type: z.string().optional().default("Unknown")
});

type RemoteJob = z.infer<typeof JobSchema>;

const SEARCH_URLS = [
"https://remotive.com/api/remote-jobs?category=software-dev&limit=50",
"https://remotive.com/api/remote-jobs?search=typescript&limit=50",
"https://remotive.com/api/remote-jobs?search=node.js&limit=50"
];

function isNigeriaEligible(job: RemoteJob): boolean {
const location = job.candidate_required_location.toLowerCase();
const text = "${job.title} ${job.description}".toLowerCase();

const locationAllowsNigeria =
location.includes("worldwide") ||
location.includes("anywhere") ||
location.includes("africa") ||
location.includes("nigeria") ||
location.includes("global") ||
location.includes("all countries") ||
location.includes("remote");

const relevantRole =
/software|developer|engineer|typescript|javascript|node.?js|backend|back-end|full.?stack|automation|python|api\b/i
.test(text);

return locationAllowsNigeria && relevantRole;
}

export async function discoverJobs() {
const uniqueJobs = new Map<string, RemoteJob>();
const sourceErrors: string[] = [];

for (const endpoint of SEARCH_URLS) {
try {
const response = await fetch(endpoint, {
headers: { Accept: "application/json" },
signal: AbortSignal.timeout(15000)
});

  if (!response.ok) {
    sourceErrors.push(`Job source returned HTTP ${response.status}`);
    continue;
  }

  const payload: unknown = await response.json();

  if (
    !payload ||
    typeof payload !== "object" ||
    !("jobs" in payload) ||
    !Array.isArray(payload.jobs)
  ) {
    sourceErrors.push("Job source returned an unexpected response");
    continue;
  }

  for (const item of payload.jobs) {
    const parsed = JobSchema.safeParse(item);
    if (!parsed.success) continue;

    const job = parsed.data;
    if (isNigeriaEligible(job)) {
      uniqueJobs.set(job.url, job);
    }
  }
} catch {
  sourceErrors.push("Could not reach one of the job sources");
}

}

let saved = 0;
let skipped = 0;
const saveErrors: string[] = [];

for (const job of uniqueJobs.values()) {
try {
const result = await addJob({
company: job.company_name,
title: job.title,
location: job.candidate_required_location,
url: job.url,
source: "job_board",
employment_type: job.job_type,
remote: true,
nigeria_eligible: true,
description: job.description.slice(0, 19000),
status: "discovered",
notes: "Discovered automatically. Verify eligibility and closing date before applying."
});

  if (result) saved++;
  else skipped++;
} catch {
  saveErrors.push(job.url);
}

}

return {
checkedSources: SEARCH_URLS.length,
matched: uniqueJobs.size,
saved,
skipped,
sourceErrors,
saveFailures: saveErrors.length
};
}
