// Thin wrapper around Nodemailer (MIT-licensed, the standard Node.js
// SMTP-sending library — https://nodemailer.com/) for order notification
// emails. Independent of the WhatsApp integration; see server/whatsapp/
// for that one's equivalent (metaClient.ts).
import nodemailer from "nodemailer";
import { db } from "../index.js";

// Config is read fresh from the settings table on every send (admin-
// configurable from Settings → Email notifications, no server restart
// needed), falling back to the equivalent env var for anyone who'd rather
// deploy it that way (e.g. via a secrets manager). Building a fresh
// transporter per send (rather than one cached at module load) is what
// makes changing these in the UI take effect immediately — send volume
// here is low enough that this has no real performance cost.
function resolveConfig() {
  const s = db.getAllSettings();
  return {
    host: s.emailSmtpHost || process.env.EMAIL_SMTP_HOST || "",
    port: Number(s.emailSmtpPort || process.env.EMAIL_SMTP_PORT || "587"),
    user: s.emailSmtpUser || process.env.EMAIL_SMTP_USER || "",
    pass: s.emailSmtpPass || process.env.EMAIL_SMTP_PASS || "",
    from: s.emailFromAddress || process.env.EMAIL_FROM_ADDRESS || ""
  };
}

export interface SendEmailResult {
  ok: boolean;
  error: string | null;
}

// Never throws — a slow or unreachable SMTP server can never block the
// order flow that triggered a send (same posture as
// server/whatsapp/metaClient.ts's sendTemplateMessage/sendFreeformMessage).
export async function sendEmail(to: string, subject: string, body: string): Promise<SendEmailResult> {
  const config = resolveConfig();
  if (!config.host || !config.from) {
    return { ok: false, error: "Email is not configured on this instance (set it in Settings → Email notifications, or EMAIL_SMTP_HOST/EMAIL_FROM_ADDRESS)" };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined
    });
    await transporter.sendMail({ from: config.from, to, subject, text: body });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "send failed" };
  }
}
