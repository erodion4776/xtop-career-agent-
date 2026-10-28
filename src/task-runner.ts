import {
  getPendingTasks,
  claimTask,
  updateTask,
  retryTask,
} from "./task-engine.js";
import { logAction } from "./audit-log.js";
import { discoverJobs } from "./job-discovery.js";
import { listJobs } from "./tracker.js";

let processing = false;

export async function processPendingTasks(): Promise<number> {
  if (processing) return 0;
  processing = true;
  let completed = 0;

  try {
    const tasks = await getPendingTasks();

    for (const task of tasks) {
      const claimed = await claimTask(task.id);
      if (!claimed) continue;

      try {
        const result = await executeTask(
          task.id,
          task.task_type,
          task.params
        );

        await updateTask(task.id, "completed", { result });
        await logAction("task_completed", {
          taskId: task.id,
          type: task.task_type,
        });
        completed++;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        const canRetry = await retryTask(task.id);

        if (!canRetry) {
          await updateTask(task.id, "failed", {
            error: message,
          });
        }

        await logAction("task_failed", {
          taskId: task.id,
          type: task.task_type,
          error: message,
          willRetry: canRetry,
        });
      }
    }
  } finally {
    processing = false;
  }

  return completed;
}

async function executeTask(
  taskId: string,
  taskType: string,
  _params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (taskType) {
    case "discover_jobs": {
      await updateTask(taskId, "running", {
        progress: "Fetching job listings from sources...",
      });

      const result = await discoverJobs();

      return {
        matched: result.matched,
        saved: result.saved,
        updated: result.updated,
        highSuitability: result.highSuitability,
        nigeriaEligible: result.nigeriaEligible,
      };
    }

    case "health_check": {
      const jobs = await listJobs();

      return {
        server: "online",
        database: "connected",
        jobCount: jobs.length,
        timestamp: new Date().toISOString(),
      };
    }

    case "task_report": {
      const { listRecentTasks } = await import(
        "./task-engine.js"
      );
      const recent = await listRecentTasks(5);

      return {
        totalRecent: recent.length,
        tasks: recent.map((t) => ({
          id: t.id.slice(0, 8),
          type: t.task_type,
          status: t.status,
          created: t.created_at,
        })),
      };
    }

    default:
      throw new Error(`Unknown task type: ${taskType}`);
  }
}
