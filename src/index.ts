import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { google } from "googleapis";

import {
  addJob,
  listJobs,
  updateJobStatus
} from "./tracker.js";

import type { JobLead } from "./types.js";

import {
  oauthClient,
  gmailAuthorizationUrl,
  sendGmail
} from "./gmail.js";

import {
  createState,
  consumeState
} from "./oauth-state.js";

import {
  saveGmailConnection,
  getGmailConnection
} from "./gmail-store.js";

import { discoverJobs } from "./job-discovery.js";

// === WORKFORCE: new imports ===
import {
  isConfigured as telegramReady,
  setWebhook,
} from "./telegram.js";
import { handleUpdate } from "./telegram-handler.js";
import { listRecentTasks, getTask } from "./task-engine.js";
import { processPendingTasks } from "./task-runner.js";
import { logAction } from "./audit-log.js";
// === END WORKFORCE ===

const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirectory = path.resolve(__dirname, "../public");

app.use(express.static(publicDirectory));

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.AGENT_API_KEY;

const allowedEmail = process.env.GMAIL_ALLOWED_EMAIL
  ?.trim()
  .toLowerCase();

function authenticate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!apiKey) {
    res.status(503).json({
      ok: false,
      error: "AGENT_API_KEY is not configured."
    });
    return;
  }

  const supplied = req.header("x-agent-key");

  if (!supplied || supplied !== apiKey) {
    res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  next();
}

// API information
app.get("/api-info", (_req, res) => {
  res.json({
    name: "XTOP Career Agent",
    version: "0.4.0",
    status: "running",
    capabilities: [
      "health check",
      "job lead tracking",
      "application status tracking",
      "remote job discovery",
      "Nigeria eligibility assessment",
      "Gmail OAuth connection",
      "test email to authorized account",
      "telegram workforce control",   // === WORKFORCE ===
      "persistent task engine",       // === WORKFORCE ===
      "audit logging"                 // === WORKFORCE ===
    ]
  });
});

// Public health check
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString()
  });
});

// Start Gmail OAuth
app.get("/auth/google", (_req, res) => {
  if (!allowedEmail) {
    res.status(503).send(
      "GMAIL_ALLOWED_EMAIL is not configured."
    );
    return;
  }

  const state = createState();
  res.redirect(gmailAuthorizationUrl(state));
});

// Gmail OAuth callback
app.get("/auth/google/callback", async (req, res) => {
  const state = String(req.query.state || "");
  const code = String(req.query.code || "");

  if (req.query.error) {
    res.status(400).send(
      "Google authorization was cancelled or denied."
    );
    return;
  }

  if (!state || !consumeState(state)) {
    res.status(400).send(
      "Invalid or expired authorization state. Start again at /auth/google."
    );
    return;
  }

  if (!code) {
    res.status(400).send(
      "Google authorization code is missing."
    );
    return;
  }

  if (!allowedEmail) {
    res.status(503).send(
      "GMAIL_ALLOWED_EMAIL is not configured."
    );
    return;
  }

  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      res.status(400).send(
        "Google did not return a refresh token. Retry authorization and consent."
      );
      return;
    }

    client.setCredentials(tokens);

    const oauth2 = google.oauth2({
      version: "v2",
      auth: client
    });

    const { data } = await oauth2.userinfo.get();
    const email = data.email?.trim().toLowerCase();

    if (!email || email !== allowedEmail) {
      res.status(403).send(
        "The authorized Google account does not match GMAIL_ALLOWED_EMAIL."
      );
      return;
    }

    await saveGmailConnection(
      email,
      tokens.refresh_token
    );

    res.status(200).send(
      "Gmail connected successfully. You may close this page."
    );
  } catch {
    res.status(500).send(
      "Gmail authorization failed. Check the private server logs and configuration."
    );
  }
});

// === WORKFORCE: Telegram webhook (no x-agent-key auth) ===
app.post("/telegram/webhook", async (req, res) => {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  if (webhookSecret) {
    const supplied = req.header("x-telegram-bot-api-secret-token");
    if (supplied !== webhookSecret) {
      res.status(403).json({ ok: false, error: "Invalid webhook secret." });
      return;
    }
  }

  if (!telegramReady()) {
    res.status(503).json({ ok: false, error: "Telegram not configured." });
    return;
  }

  // Respond immediately so Telegram doesn't retry
  res.json({ ok: true });

  // Process the update asynchronously
  try {
    await handleUpdate(req.body as Record<string, unknown>);
  } catch (error) {
    console.error(
      "[Telegram] Update handling error:",
      error instanceof Error ? error.message : String(error)
    );
  }
});

// === WORKFORCE: Telegram webhook setup helper ===
app.post("/api/telegram/setup-webhook", authenticate, async (req, res) => {
  if (!telegramReady()) {
    res.status(503).json({ ok: false, error: "Telegram not configured." });
    return;
  }

  const publicUrl = process.env.RENDER_EXTERNAL_URL
    || `https://xtop-career-agent.onrender.com`;
  const webhookUrl = `${publicUrl}/telegram/webhook`;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  try {
    await setWebhook(webhookUrl, secret);
    await logAction("webhook_configured", { url: webhookUrl });
    res.json({ ok: true, webhookUrl });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Webhook setup failed.",
    });
  }
});
// === END WORKFORCE ===

// All /api routes below this point require the agent API key.
app.use("/api", authenticate);

// List saved job leads
app.get("/api/jobs", async (_req, res) => {
  try {
    res.json(await listJobs());
  } catch {
    res.status(500).json({
      ok: false,
      error: "Could not retrieve job leads."
    });
  }
});

// Manually add a job lead
app.post("/api/jobs", async (req, res) => {
  try {
    const job = await addJob(req.body as JobLead);

    res.status(201).json({
      ok: true,
      job
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        ok: false,
        error: "Invalid job data",
        details: error.issues
      });
      return;
    }

    res.status(500).json({
      ok: false,
      error: "Could not save job lead."
    });
  }
});

// Discover and save remote software jobs
app.post("/api/jobs/discover", async (_req, res) => {
  try {
    const result = await discoverJobs();

    // discoverJobs() already returns ok: true.
    // Return it directly to avoid a duplicate-property error.
    res.json(result);
  } catch {
    res.status(500).json({
      ok: false,
      error: "Job discovery failed. Check the private server logs."
    });
  }
});

// Update application status
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
    res.status(400).json({
      ok: false,
      error: "Invalid application status."
    });
    return;
  }

  try {
    const job = await updateJobStatus(
      req.params.id,
      parsed.data.status
    );

    res.json({
      ok: true,
      job
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Could not update job status."
    });
  }
});

// Check Supabase connectivity
app.get("/api/db-check", async (_req, res) => {
  try {
    const jobs = await listJobs();

    res.json({
      ok: true,
      database: "connected",
      jobCount: jobs.length
    });
  } catch {
    res.status(500).json({
      ok: false,
      database: "connection_failed"
    });
  }
});

// Send a test email only to the authorized account
app.post("/api/gmail/test-send", async (_req, res) => {
  if (!allowedEmail) {
    res.status(503).json({
      ok: false,
      error: "GMAIL_ALLOWED_EMAIL is not configured."
    });
    return;
  }

  try {
    const connection = await getGmailConnection(
      allowedEmail
    );

    if (!connection) {
      res.status(409).json({
        ok: false,
        error: "Gmail is not connected. Open /auth/google first."
      });
      return;
    }

    await sendGmail(
      connection.refreshToken,
      allowedEmail,
      "XTOP Career Agent — Gmail test",
      "This is a test email from your XTOP Career Agent. Gmail sending is connected."
    );

    res.json({
      ok: true,
      message: "Test email sent to your authorized Gmail account."
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Test email failed. Check the private deployment logs."
    });
  }
});

// === WORKFORCE: Task API routes ===
app.get("/api/tasks", async (req, res) => {
  try {
    const limit = Math.min(
      Number(req.query.limit) || 10,
      50
    );
    const tasks = await listRecentTasks(limit);
    res.json({ ok: true, tasks });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Could not retrieve tasks."
    });
  }
});

app.get("/api/tasks/:id", async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) {
      res.status(404).json({ ok: false, error: "Task not found." });
      return;
    }
    res.json({ ok: true, task });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Could not retrieve task."
    });
  }
});

app.post("/api/tasks/process", async (_req, res) => {
  try {
    const completed = await processPendingTasks();
    res.json({ ok: true, completed });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Task processing failed."
    });
  }
});
// === END WORKFORCE ===

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(
    `XTOP Career Agent listening on port ${port}`
  );

  // === WORKFORCE: auto-configure Telegram webhook on startup ===
  if (telegramReady()) {
    const publicUrl = process.env.RENDER_EXTERNAL_URL
      || "https://xtop-career-agent.onrender.com";
    const webhookUrl = `${publicUrl}/telegram/webhook`;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

    setWebhook(webhookUrl, secret)
      .then(() => {
        console.log(`[Telegram] Webhook set to ${webhookUrl}`);
        return logAction("webhook_auto_configured", { url: webhookUrl });
      })
      .catch((err) => {
        console.error(
          "[Telegram] Webhook setup failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
  } else {
    console.log(
      "[Telegram] Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID to enable."
    );
  }
  // === END WORKFORCE ===
});
