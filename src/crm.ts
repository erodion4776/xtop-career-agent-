import { supabase } from "./supabase.js";

export type ProspectStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal_sent"
  | "negotiating"
  | "won"
  | "lost";

export type OutreachType =
  | "email"
  | "whatsapp"
  | "call"
  | "social"
  | "in_person";

export type OutreachStatus =
  | "draft"
  | "approved"
  | "sent"
  | "replied"
  | "bounced"
  | "cancelled";

export interface Prospect {
  id: string;
  business_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string;
  industry: string | null;
  source: string;
  status: ProspectStatus;
  score: number;
  services_needed: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Outreach {
  id: string;
  prospect_id: string;
  type: OutreachType;
  subject: string | null;
  body: string | null;
  status: OutreachStatus;
  sent_at: string | null;
  replied_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface CrmStats {
  total: number;
  byStatus: Record<string, number>;
  recentProspects: Prospect[];
  pendingOutreach: number;
}

function scoreProspect(input: {
  industry?: string | null;
  services_needed?: string[];
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}): number {
  let score = 10; // Base score for any prospect

  // Contact info completeness
  if (input.email?.trim()) score += 15;
  if (input.phone?.trim()) score += 10;
  if (input.website?.trim()) score += 5;

  // Industry relevance (higher = more likely to need web services)
  const highValue = /\b(restaurant|hotel|shop|store|clinic|hospital|school|academy|salon|spa|gym|fitness|pharmacy|supermarket|bakery|cafe|bar|lounge|event|wedding|photography|studio|boutique|fashion|beauty|dental|medical|law|legal|accounting|consulting|real.?estate|property|construction|logistics|delivery|tech|software|startup)\b/i;
  if (input.industry && highValue.test(input.industry)) {
    score += 20;
  }

  // Services needed
  const services = input.services_needed || [];
  if (services.includes("website")) score += 15;
  if (services.includes("online_store")) score += 15;
  if (services.includes("whatsapp_bot")) score += 10;
  if (services.includes("automation")) score += 10;
  if (services.includes("social_media")) score += 5;

  return Math.min(100, Math.max(0, score));
}

export async function addProspect(input: {
  business_name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  industry?: string;
  source?: string;
  services_needed?: string[];
  notes?: string;
}): Promise<Prospect> {
  const score = scoreProspect(input);

  const { data, error } = await supabase
    .from("prospects")
    .insert({
      business_name: input.business_name.trim(),
      contact_name: input.contact_name?.trim() || null,
      email: input.email?.trim().toLowerCase() || null,
      phone: input.phone?.trim() || null,
      website: input.website?.trim() || null,
      address: input.address?.trim() || null,
      city: input.city?.trim() || "Benin City",
      industry: input.industry?.trim() || null,
      source: input.source || "manual",
      services_needed: input.services_needed || [],
      notes: input.notes?.trim() || null,
      score,
    })
    .select()
    .single();

  if (error) throw error;
  return data as Prospect;
}

export async function listProspects(
  limit = 10,
  status?: ProspectStatus
): Promise<Prospect[]> {
  let query = supabase
    .from("prospects")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Prospect[];
}

export async function getProspect(
  id: string
): Promise<Prospect | null> {
  const { data, error } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data as Prospect | null;
}

export async function updateProspectStatus(
  id: string,
  status: ProspectStatus
): Promise<void> {
  const { error } = await supabase
    .from("prospects")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

export async function getCrmStats(): Promise<CrmStats> {
  const { data: allProspects, error: pErr } = await supabase
    .from("prospects")
    .select("status")
    .order("created_at", { ascending: false });

  if (pErr) throw pErr;

  const byStatus: Record<string, number> = {};
  for (const p of allProspects || []) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  }

  const { data: recent, error: rErr } = await supabase
    .from("prospects")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5);

  if (rErr) throw rErr;

  const { count: pendingCount, error: oErr } = await supabase
    .from("outreach")
    .select("*", { count: "exact", head: true })
    .eq("status", "draft");

  if (oErr) throw oErr;

  return {
    total: (allProspects || []).length,
    byStatus,
    recentProspects: (recent ?? []) as Prospect[],
    pendingOutreach: pendingCount ?? 0,
  };
}

export async function createOutreach(input: {
  prospect_id: string;
  type: OutreachType;
  subject?: string;
  body?: string;
}): Promise<Outreach> {
  const { data, error } = await supabase
    .from("outreach")
    .insert({
      prospect_id: input.prospect_id,
      type: input.type,
      subject: input.subject || null,
      body: input.body || null,
      status: "draft",
    })
    .select()
    .single();

  if (error) throw error;
  return data as Outreach;
}

export async function listOutreach(
  prospectId: string
): Promise<Outreach[]> {
  const { data, error } = await supabase
    .from("outreach")
    .select("*")
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as Outreach[];
}

export async function updateOutreachStatus(
  id: string,
  status: OutreachStatus
): Promise<void> {
  const updates: Record<string, unknown> = { status };

  if (status === "sent") {
    updates.sent_at = new Date().toISOString();
  } else if (status === "replied") {
    updates.replied_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("outreach")
    .update(updates)
    .eq("id", id);

  if (error) throw error;
}

export async function searchProspects(
  query: string
): Promise<Prospect[]> {
  const { data, error } = await supabase
    .from("prospects")
    .select("*")
    .or(
      `business_name.ilike.%${query}%,contact_name.ilike.%${query}%,email.ilike.%${query}%,city.ilike.%${query}%`
    )
    .order("score", { ascending: false })
    .limit(10);

  if (error) throw error;
  return (data ?? []) as Prospect[];
}
