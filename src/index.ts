
import "dotenv/config";
import express from "express";
import { z } from "zod";
import {
  addJob,
  listJobs,
  updateJobStatus
} from "./tracker.js";
import type { JobLead } from "./types.js";

const app = express();
app.use(express.json({ limit: "100kb" }));

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.AGENT_API_KEY;

function authenticate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!apiKey) {
    res.status(503).json({
      error: "AGENT_API_KEY is not configured."
    });
    return;
  }

  const supplied = req.header("x-agent-key");

  if (!supplied || supplied !== apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

app.get("/", (_req, res) => {
  res.json({
    name: "XTOP Career Agent",
    version: "0.1.0",
    status: "running",
    capabilities: [
      "health check",
      "job lead tracking",
      "application status tracking"
    ]
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use("/api", authenticate);

app.get("/api/jobs", async (_req, res) => {
  try {
    res.json(await listJobs());
  } catch {
    res.status(500).json({ error: "Could not retrieve job leads." });
  }
});

app.post("/api/jobs", async (req, res) => {
  try {
    const job = await addJob(req.body as JobLead);
    res.status(201).json({ job });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: "Invalid job data",
        details: error.issues
      });
      return;
    }

    res.status(500).json({ error: "Could not save job lead." });
  }
});

app.patch("/api/jobs/:id/status", async (req, res) => {
  const schema = z.object({
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
    ])
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid application status." });
    return;
  }

  try {
    const job = await updateJobStatus(
      req.params.id,
      parsed.data.status
    );

    res.json({ job });
  } catch {
    res.status(500).json({ error: "Could not update job status." });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`XTOP Career Agent listening on port ${port}`);
});
