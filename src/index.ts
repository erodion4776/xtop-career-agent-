import express from "express";
import { handleUpdate } from "./telegram-handler.js";
import { sendMessage } from "./telegram.js";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3000", 10);
const OWNER_ID = process.env.TELEGRAM_OWNER_ID;

// ── Health check ───────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/health", (_req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

// ── Telegram webhook ───────────────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;

    // Verify secret if configured
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && req.header("x-telegram-bot-api-secret-token") !== secret) {
      res.sendStatus(403);
      return;
    }

    // Route callback queries (button presses) to callback handler
    if (update.callback_query) {
      const { handleCallback } = await import("./callback-handler.js");
      await handleCallback(update);
    }
    // Route messages to existing handler
    else if (update.message) {
      await handleUpdate(update);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200); // Always return 200 to Telegram
  }
});

// ── Gmail OAuth routes ─────────────────────────────────
app.get("/auth/google", async (_req, res) => {
  try {
    const { getAuthUrl } = await import("./gmail.js");
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (e: any) {
    res.status(500).send(`Auth error: ${e.message}`);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { handleCallback } = await import("./gmail.js");
    await handleCallback(req.query.code as string);
    res.send("✅ Gmail connected! You can close this window.");
  } catch (e: any) {
    res.status(500).send(`Callback error: ${e.message}`);
  }
});

// ── API: Trigger job discovery ─────────────────────────
app.post("/api/discover", async (req, res) => {
  const apiKey = req.header("x-api-key");
  if (apiKey !== process.env.AGENT_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { supabase } = await import("./supabase.js");
    await supabase.from("tasks").insert({
      task_type: "job_discovery",
      status: "pending",
      payload: { triggered_by: "api" },
    });
    res.json({ status: "queued" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Set webhook on startup ─────────────────────────────
async function setupWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = process.env.RENDER_EXTERNAL_URL || "https://xtop-career-agent.onrender.com";
  if (!token) {
    console.log("No TELEGRAM_BOT_TOKEN, skipping webhook setup");
    return;
  }
  try {
    const webhookUrl = `${url}/telegram/webhook`;
    const body: Record<string, any> = { url: webhookUrl };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) {
      body.secret_token = 
