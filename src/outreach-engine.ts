import { GoogleGenAI } from "@google/genai";
import { supabase } from "./supabase.js";
import type { Prospect, Outreach } from "./crm.js";

function getApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    undefined
  );
}

function getModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
}

function templateDraft(prospect: Prospect): {
  subject: string;
  body: string;
} {
  const services =
    prospect.services_needed.length > 0
      ? prospect.services_needed.join(", ")
      : "a professional website and online automation";

  const subject = `Help ${prospect.business_name} grow online`;

  const body = [
    `Dear ${prospect.contact_name || "Business Owner"},`,
    "",
    `My name is Osarodion and I run XTOP Retail Technologies, a web development and automation agency based in Benin City.`,
    "",
    `I noticed ${prospect.business_name} and believe we can help you with ${services}.`,
    "",
    `Here is what we offer:`,
    `- Professional, mobile-friendly websites`,
    `- Online stores with payment integration`,
    `- WhatsApp chatbots for customer service`,
    `- Business process automation`,
    "",
    `I would love to prepare a free demonstration of what your new website could look like. Would you be available for a quick chat this week?`,
    "",
    `Best regards,`,
    `Osarodion Ero`,
    `XTOP Retail Technologies`,
    `Benin City, Edo State`,
  ].join("\n");

  return { subject, body };
}

async function aiDraft(
  prospect: Prospect
): Promise<{ subject: string; body: string } | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const prompt = `
You are a professional outreach email writer for XTOP Retail Technologies,
a web development and automation agency in Benin City, Nigeria.

Write a short, personalised outreach email to this prospect.

Prospect details:
- Business: ${prospect.business_name}
- Industry: ${prospect.industry || "unknown"}
- City: ${prospect.city}
- Services they may need: ${prospect.services_needed.join(", ") || "website, online store, WhatsApp bot, automation"}
- Contact: ${prospect.contact_name || "Business Owner"}

Rules:
- Be warm, professional, and concise (under 200 words).
- Mention their business by name.
- Suggest 1-2 specific services relevant to their industry.
- Offer a free website mockup or demonstration.
- Do NOT make false claims or promise specific results.
- Sign off as "Osarodion Ero, XTOP Retail Technologies, Benin City".
- Return ONLY valid JSON with "subject" and "body" fields.

Example JSON:
{
  "subject": "A new website for Business Name",
  "body": "Dear ...\\n\\n..."
}
`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const response = await ai.models.generateContent({
      model: getModel(),
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        abortSignal: controller.signal,
      },
    });

    clearTimeout(timer);

    if (!response.text?.trim()) return null;

    const cleaned = response.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");

    const parsed = JSON.parse(cleaned) as {
      subject?: string;
      body?: string;
    };

    if (
      typeof parsed.subject === "string" &&
      typeof parsed.body === "string" &&
      parsed.subject.trim().length > 0 &&
      parsed.body.trim().length > 0
    ) {
      return {
        subject: parsed.subject.trim().slice(0, 200),
        body: parsed.body.trim().slice(0, 5000),
      };
    }

    return null;
  } catch (error) {
    console.warn(
      "[Outreach] AI draft failed, using template:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

export async function generateDraft(
  prospectId: string
): Promise<Outreach> {
  const { data: prospect, error: pErr } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", prospectId)
    .maybeSingle();

  if (pErr) throw pErr;
  if (!prospect) throw new Error("Prospect not found.");

  const p = prospect as Prospect;

  // Try AI first, fall back to template
  let content = await aiDraft(p);
  if (!content) {
    content = templateDraft(p);
  }

  const { data, error } = await supabase
    .from("outreach")
    .insert({
      prospect_id: prospectId,
      type: "email",
      subject: content.subject,
      body: content.body,
      status: "draft",
    })
    .select()
    .single();

  if (error) throw error;
  return data as Outreach;
}

export async function listDrafts(
  status?: "draft" | "approved"
): Promise<
  Array<Outreach & { business_name?: string; email?: string }>
> {
  // Fetch drafts
  const { data: drafts, error: dErr } = await supabase
    .from("outreach")
    .select("*")
    .eq("status", status || "draft")
    .order("created_at", { ascending: false })
    .limit(10);

  if (dErr) throw dErr;
  if (!drafts || drafts.length === 0) return [];

  // Fetch prospect names separately to avoid join issues
  const prospectIds = [
    ...new Set(drafts.map((d) => d.prospect_id)),
  ];

  const { data: prospects } = await supabase
    .from("prospects")
    .select("id, business_name, email")
    .in("id", prospectIds);

  const prospectMap = new Map(
    (prospects || []).map((p) => [
      p.id,
      { business_name: p.business_name, email: p.email },
    ])
  );

  return drafts.map((d) => {
    const p = prospectMap.get(d.prospect_id);
    return {
      ...d,
      business_name: p?.business_name,
      email: p?.email,
    };
  });
}

export async function approveDraft(
  id: string
): Promise<void> {
  const { error } = await supabase
    .from("outreach")
    .update({ status: "approved" })
    .eq("id", id)
    .eq("status", "draft");

  if (error) throw error;
}

export async function rejectDraft(
  id: string
): Promise<void> {
  const { error } = await supabase
    .from("outreach")
    .update({ status: "cancelled" })
    .eq("id", id)
    .in("status", ["draft", "approved"]);

  if (error) throw error;
}

export async function sendDraft(
  id: string
): Promise<{ recipient: string; subject: string }> {
  // Step 1: Get the approved draft (simple query, no join)
  const { data: draft, error: dErr } = await supabase
    .from("outreach")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (dErr) throw new Error(`Database error: ${dErr.message}`);
  if (!draft) {
    throw new Error("Draft not found.");
  }
  if (draft.status !== "approved") {
    throw new Error(
      `Draft status is "${draft.status}", not "approved". Approve it first.`
    );
  }

  // Step 2: Get the prospect separately
  const { data: prospect, error: pErr } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", draft.prospect_id)
    .maybeSingle();

  if (pErr) throw new Error(`Prospect lookup failed: ${pErr.message}`);
  if (!prospect) throw new Error("Prospect record not found.");

  const recipient = prospect.email;
  if (!recipient) {
    throw new Error("Prospect has no email address.");
  }

  // Step 3: Load Gmail modules dynamically
  let sendGmail: typeof import("./gmail.js").sendGmail;
  let getGmailConnection: typeof import("./gmail-store.js").getGmailConnection;

  try {
    const gmailModule = await import("./gmail.js");
    sendGmail = gmailModule.sendGmail;

    const storeModule = await import("./gmail-store.js");
    getGmailConnection = storeModule.getGmailConnection;
  } catch (importErr) {
    throw new Error(
      `Gmail module failed to load: ${importErr instanceof Error ? importErr.message : String(importErr)}`
    );
  }

  // Step 4: Get Gmail connection
  const allowedEmail =
    process.env.GMAIL_ALLOWED_EMAIL?.trim().toLowerCase();

  if (!allowedEmail) {
    throw new Error("GMAIL_ALLOWED_EMAIL not configured in Render.");
  }

  const connection = await getGmailConnection(allowedEmail);
  if (!connection) {
    throw new Error(
      "Gmail not connected. Visit https://xtop-career-agent.onrender.com/auth/google first."
    );
  }

  // Step 5: Send the email
  try {
    await sendGmail(
      connection.refreshToken,
      recipient,
      draft.subject || "Hello from XTOP Retail Technologies",
      draft.body || ""
    );
  } catch (sendErr) {
    throw new Error(
      `Gmail API error: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`
    );
  }

  // Step 6: Mark as sent
  await supabase
    .from("outreach")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
    })
    .eq("id", id);

  // Step 7: Update prospect status if still "new"
  if (prospect.status === "new") {
    await supabase
      .from("prospects")
      .update({
        status: "contacted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", draft.prospect_id);
  }

  return {
    recipient,
    subject: draft.subject || "(no subject)",
  };
}

export async function findProspectByName(
  name: string
): Promise<Prospect | null> {
  const { data, error } = await supabase
    .from("prospects")
    .select("*")
    .ilike("business_name", `%${name}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as Prospect | null;
}

export async function getProspectWithHistory(
  prospectId: string
): Promise<{
  prospect: Prospect;
  outreach: Outreach[];
}> {
  const { data: prospect, error: pErr } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", prospectId)
    .maybeSingle();

  if (pErr) throw pErr;
  if (!prospect) throw new Error("Prospect not found.");

  const { data: outreach, error: oErr } = await supabase
    .from("outreach")
    .select("*")
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false });

  if (oErr) throw oErr;

  return {
    prospect: prospect as Prospect,
    outreach: (outreach ?? []) as Outreach[],
  };
}

export async function changeProspectStatus(
  prospectId: string,
  newStatus: string
): Promise<void> {
  const valid = [
    "new",
    "contacted",
    "qualified",
    "proposal_sent",
    "negotiating",
    "won",
    "lost",
  ];

  if (!valid.includes(newStatus)) {
    throw new Error(
      `Invalid status. Choose: ${valid.join(", ")}`
    );
  }

  const { error } = await supabase
    .from("prospects")
    .update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId);

  if (error) throw error;
}
