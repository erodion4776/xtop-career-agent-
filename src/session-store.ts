import { supabase } from "./supabase.js";

export interface Session {
  workflow: string;
  state: Record<string, any>;
}

export async function getSession(chatId: number, userId: number): Promise<Session | null> {
  const { data } = await supabase
    .from("bot_sessions")
    .select("workflow, state")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .single();
  if (!data) return null;
  return { workflow: data.workflow, state: data.state || {} };
}

export async function setSession(
  chatId: number,
  userId: number,
  workflow: string,
  state: Record<string, any>
): Promise<void> {
  await supabase.from("bot_sessions").upsert({
    chat_id: chatId,
    user_id: userId,
    workflow,
    state,
    updated_at: new Date().toISOString(),
  });
}

export async function clearSession(chatId: number, userId: number): Promise<void> {
  await supabase
    .from("bot_sessions")
    .delete()
    .eq("chat_id", chatId)
    .eq("user_id", userId);
}
