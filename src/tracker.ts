import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { JobLead } from "./types.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("Missing Supabase environment configuration.");
}

const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const jobSchema = z.object({
  company: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  location: z.string().max(200).default("Remote"),
  url: z.string().url(),
  source: z.enum([
    "company",
    "job_board",
    "recruiter",
    "referral",
    "manual",
  ]),
  employment_type: z.string().max(100).default("Unknown"),
  salary_min_ngn: z.number().nonnegative().nullable().optional(),
  salary_max_ngn: z.number().nonnegative().nullable().optional(),
  remote: z.boolean().default(true),
  nigeria_eligible: z.boolean().default(false),
  description: z.string().max(20000).optional(),
  status: z
    .enum([
      "discovered",
      "review_required",
      "ready",
      "submitted",
      "acknowledged",
      "interview",
      "rejected",
      "offer",
      "withdrawn",
    ])
    .default("discovered"),
  notes: z.string().max(5000).optional(),
});

export interface AddJobResult {
  inserted: boolean;
  updated: boolean;
  reason?: string;
  error?: string;
}

export async function addJob(input: JobLead): Promise<AddJobResult> {
  const parsed = jobSchema.safeParse(input);
  if (!parsed.success) {
    return {
      inserted: false,
      updated: false,
      reason: "validation",
      error: parsed.error.message.slice(0, 300),
    };
  }

  const job = parsed.data;

  // Step 1: try insert, skip if URL already exists
  const { data: inserted, error: insertError } = await supabase
    .from("job_leads")
    .upsert(job, {
      onConflict: "url",
      ignoreDuplicates: true,
    })
    .select("id")
    .maybeSingle();

  if (insertError) {
    return {
      inserted: false,
      updated: false,
      reason: "database",
      error: insertError.message.slice(0, 300),
    };
  }

  if (inserted) {
    return { inserted: true, updated: false };
  }

  // Step 2: row exists — refresh feed-owned fields only.
  // User-owned fields (status, notes, salary_min_ngn, salary_max_ngn)
  // are intentionally excluded from the update.
  //
  // IMPORTANT: the select string must be a single literal so that the
  // Supabase TypeScript client can infer the return shape at compile time.
  const { data: existing, error: lookupError } = await supabase
    .from("job_leads")
    .select("id,title,company,location,description,nigeria_eligible,employment_type,remote,source")
    .eq("url", job.url)
    .maybeSingle();

  if (lookupError || !existing) {
    return {
      inserted: false,
      updated: false,
      reason: "lookup_failed",
      error: lookupError ? lookupError.message.slice(0, 300) : undefined,
    };
  }

  const changed =
    existing.title !== job.title ||
    existing.company !== job.company ||
    existing.location !== job.location ||
    existing.description !== job.description ||
    existing.nigeria_eligible !== job.nigeria_eligible ||
    existing.employment_type !== job.employment_type ||
    existing.remote !== job.remote ||
    existing.source !== job.source;

  if (!changed) {
    return { inserted: false, updated: false, reason: "unchanged" };
  }

  const { error: updateError } = await supabase
    .from("job_leads")
    .update({
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      nigeria_eligible: job.nigeria_eligible,
      employment_type: job.employment_type,
      remote: job.remote,
      source: job.source,
    })
    .eq("id", existing.id);

  if (updateError) {
    return {
      inserted: false,
      updated: false,
      reason: "update_failed",
      error: updateError.message.slice(0, 300),
    };
  }

  return { inserted: false, updated: true };
}

export async function listJobs() {
  const { data, error } = await supabase
    .from("job_leads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return data;
}

export async function updateJobStatus(
  id: string,
  status: JobLead["status"],
) {
  const { data, error } = await supabase
    .from("job_leads")
    .update({ status })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) throw error;

  return data;
}
