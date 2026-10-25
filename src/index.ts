
import "dotenv/config";
import express from "express";
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

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.AGENT_API_KEY;
const allowedEmail = process.env.GMAIL_ALLOWED_EMAIL?.trim().toLowerCase();

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
    res.status(401).json({
      error: "Unauthorized"
    });
    return;
  }

  next();
}

app.get("/", (_req, res) => {
  res.json({
    name: "XTOP Career Agent",
    version: "0.2.0",
    status: "running",
    capabilities: [
      "health check",
      "job lead tracking",
      "application status tracking",
      "Gmail OAuth connection",
      "test email to authorized account"
    ]
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString()
  });
});

/*
 * Start Gmail OAuth.
 * The state is short-lived and single-use.
 */
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

/*
 * Google redirects back here after authorization.
 * Only the configured Gmail account is accepted.
 */
app.get("/auth/google/callback", async (req, res) => {
  const state = String(req.query.state || "");
  const code = String(req.query.code || "");

  if (!state || !consumeState(state)) {
    res.status(400).send(
      "Invalid or expired authorization state. Start again at /auth/google."
    );
    return;
  }

  if (req.query.error) {
    res.status(400).send(
      "Google authorization was cancelled or denied."
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

/*
 * All API routes below this point require x-agent-key.
 */
app.use("/api", authenticate);

app.get("/api/jobs", async (_req, res) => {
  try {
    res.json(await listJobs());
  } catch {
    res.status(500).json({
      error: "Could not retrieve job leads."
    });
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

    res.status(500).json({
      error: "Could not save job lead."
    });
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
    res.status(400).json({
      error: "Invalid application status."
    });
    return;
  }

  try {
    const job = await updateJobStatus(
      req.params.id,
      parsed.data.status
    );

    res.json({ job });
  } catch {
    res.status(500).json({
      error: "Could not update job status."
    });
  }
});

/*
 * Database diagnostic endpoint.
 */
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

/*
 * Send a test message only to GMAIL_ALLOWED_EMAIL.
 */
app.post("/api/gmail/test-send", async (_req, res) => {
  if (!allowedEmail) {
    res.status(503).json({
      error: "GMAIL_ALLOWED_EMAIL is not configured."
    });
    return;
  }

  try {
    const connection = await getGmailConnection(allowedEmail);

    if (!connection) {
      res.status(409).json({
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
      error: "Test email failed. Check the private deployment logs."
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    `XTOP Career Agent listening on port ${port}`
  );
});
