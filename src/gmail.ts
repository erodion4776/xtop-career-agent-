
import crypto from "node:crypto";
import { google } from "googleapis";

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const redirectUri = process.env.GMAIL_REDIRECT_URI;
const encryptionKeyHex = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

if (!clientId || !clientSecret || !redirectUri) {
  throw new Error("Gmail OAuth environment variables are missing.");
}

if (!encryptionKeyHex || !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
  throw new Error(
    "GMAIL_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters."
  );
}

const encryptionKey = Buffer.from(encryptionKeyHex, "hex");

export function oauthClient() {
  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
}

export function gmailAuthorizationUrl(state: string) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.send"
    ],
    state
  });
}

export function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    encryptionKey,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

export function decryptToken(value: string): string {
  const [ivHex, tagHex, encryptedHex] = value.split(":");

  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error("Invalid encrypted token format.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

export async function sendGmail(
  refreshToken: string,
  recipient: string,
  subject: string,
  body: string
) {
  const auth = oauthClient();

  auth.setCredentials({
    refresh_token: refreshToken
  });

  const gmail = google.gmail({
    version: "v1",
    auth
  });

  const message = [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\r\n");

  const raw = Buffer.from(message).toString("base64url");

  return gmail.users.messages.send({
    userId: "me",
    requestBody: { raw }
  });
}
