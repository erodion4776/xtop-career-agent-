
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { JobLead } from "./types.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing Supabase environment configuration."
  );
}

const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
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
    "manual"
  ]),
  employment_type: z.string().max(100).default("Unknown"),
  salary_min_ngn: z.number().nonnegative().nullable().optional(),
  salary_max_ngn: z.number().nonnegative().nullable().optional(),
  remote: z.boolean().default(true),
  nigeria_eligible: z.boolean().default(false),
  description: z.string().max(20000).optional(),
  status: z.enum([
    "discovered",
    "review_required",
    "ready",
    "submitted",
    "acknowledged",
    "interview",
    "rejected",
    "offer",
    "withdrawn"
  ]).default("discovered"),
  notes: z.string().max(5000).optional()
});

export async function addJob(input: JobLead) {
  const job = jobSchema.parse(input);

  const { data, error } = await supabase
    .from("job_leads")
    .upsert(job, {
      onConflict: "url",
      ignoreDuplicates: true
    })
    .select()
    .maybeSingle();

  if (error) throw error;

  return data;
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
  status: JobLead["status"]
) {
  const { data, error } = await supabase
    .from("job_leads")
    .update({ status })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;

  return data;
}
