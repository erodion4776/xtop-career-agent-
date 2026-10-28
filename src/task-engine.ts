import { supabase } from "./supabase.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskRecord {
  id: string;
  task_type: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  progress: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  requested_by: string;
  approval_state: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export async function createTask(
  taskType: string,
  params: Record<string, unknown>,
  requestedBy: string,
  maxRetries = 2
): Promise<TaskRecord> {
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      task_type: taskType,
      params,
      status: "pending",
      requested_by: requestedBy,
      max_retries: maxRetries,
    })
    .select()
    .single();

  if (error) throw error;
  return data as TaskRecord;
}

export async function getTask(
  taskId: string
): Promise<TaskRecord | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();

  if (error) throw error;
  return data as TaskRecord | null;
}

/**
 * Atomically claim a pending task. Returns true if this
 * worker successfully claimed it, false if another worker
 * already did or the task is no longer pending.
 */
export async function claimTask(
  taskId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("tasks")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
    })
    .eq("id", taskId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data !== null;
}

export async function updateTask(
  taskId: string,
  status: TaskStatus,
  fields?: {
    progress?: string;
    result?: Record<string, unknown>;
    error?: string;
  }
): Promise<void> {
  const updates: Record<string, unknown> = { status };

  if (fields?.progress !== undefined)
    updates.progress = fields.progress;
  if (fields?.result !== undefined)
    updates.result = fields.result;
  if (fields?.error !== undefined)
    updates.error = fields.error;

  if (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    updates.completed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", taskId);

  if (error) throw error;
}

export async function listRecentTasks(
  limit = 10
): Promise<TaskRecord[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as TaskRecord[];
}

export async function getPendingTasks(): Promise<TaskRecord[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("status", "pending")
    .lte("retry_count", supabase.rpc("noop"))
    .order("created_at", { ascending: true })
    .limit(5);

  if (error) {
    // Fallback without the retry check
    const { data: fallback, error: fbErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(5);

    if (fbErr) throw fbErr;
    return ((fallback ?? []) as TaskRecord[]).filter(
      (t) => t.retry_count <= t.max_retries
    );
  }

  return (data ?? []) as TaskRecord[];
}

export async function retryTask(
  taskId: string
): Promise<boolean> {
  const task = await getTask(taskId);
  if (!task) return false;
  if (task.retry_count >= task.max_retries) return false;

  const { error } = await supabase
    .from("tasks")
    .update({
      status: "pending",
      retry_count: task.retry_count + 1,
      error: null,
    })
    .eq("id", taskId);

  if (error) throw error;
  return true;
}
