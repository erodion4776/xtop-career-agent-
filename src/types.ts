
export type JobSource =
  | "company"
  | "job_board"
  | "recruiter"
  | "referral"
  | "manual";

export type ApplicationStatus =
  | "discovered"
  | "review_required"
  | "ready"
  | "submitted"
  | "acknowledged"
  | "interview"
  | "rejected"
  | "offer"
  | "withdrawn";

export interface JobLead {
  id?: string;
  company: string;
  title: string;
  location: string;
  url: string;
  source: JobSource;
  employment_type: string;
  salary_min_ngn?: number | null;
  salary_max_ngn?: number | null;
  remote: boolean;
  nigeria_eligible: boolean;
  description?: string;
  status: ApplicationStatus;
  notes?: string;
}
