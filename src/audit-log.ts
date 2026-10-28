import { supabase } from "./supabase.js";

export async function logAction(
  action: string,
  details: Record<string, unknown>,
  actor: string = "system"
): Promise<void> {
  try {
    await supabase.from("audit_log").insert({
      action,
      details,
      actor,
    });
  } catch (error) {
    console.error(
      "[Audit] Failed to log action:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
