
import { createClient } from "@supabase/supabase-js";
import { encryptToken, decryptToken } from "./gmail.js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !key) {
  throw new Error("Missing Supabase configuration.");
}

const db = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

export async function saveGmailConnection(
  email: string,
  refreshToken: string
) {
  const { error } = await db
    .from("gmail_connections")
    .upsert({
      email,
      refresh_token_encrypted: encryptToken(refreshToken),
      updated_at: new Date().toISOString()
    }, {
      onConflict: "email"
    });

  if (error) throw error;
}

export async function getGmailConnection(email: string) {
  const { data, error } = await db
    .from("gmail_connections")
    .select("email, refresh_token_encrypted")
    .eq("email", email)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    email: data.email,
    refreshToken: decryptToken(data.refresh_token_encrypted)
  };
}
