// Receives inbound WhatsApp messages and Meta's webhook verification
// handshake. Mounted PUBLIC (no requireAuth) at /api/whatsapp/webhook —
// Meta calls this directly, it can't send a session cookie or API key.
// Authenticity instead comes from (a) the GET verify-token check on setup,
// and (b) verifying the `X-Hub-Signature-256` header against
// WHATSAPP_APP_SECRET on every inbound POST (see verifyMetaSignature below).
import type { Request } from "express";
import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../index.js";

const router = Router();

// PLUG IN REAL VALUES: set this to whatever string you choose when
// configuring the webhook in Meta's App Dashboard (WhatsApp > Configuration
// > Webhook > Verify Token) — Meta echoes it back on the GET verification
// request, and this must match exactly or the subscription will fail.
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "";

// PLUG IN REAL VALUES: from Meta App Dashboard > Settings > Basic. Used to
// verify the X-Hub-Signature-256 header Meta signs every POST body with
// (HMAC-SHA256 of the exact raw bytes — see server/index.ts's express.json
// `verify` callback, which stashes those raw bytes onto req.rawBody since
// re-serializing the parsed JSON would never byte-for-byte match what Meta
// actually signed). If unset, every inbound POST is still processed (so a
// fresh install works before Meta is configured) but with a loud warning —
// this endpoint is then trusting *anyone* who can reach it, not just Meta.
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "";
let warnedMissingSecret = false;

function verifyMetaSignature(req: Request): boolean {
  if (!APP_SECRET) {
    if (!warnedMissingSecret) {
      console.warn("[whatsapp-webhook] WHATSAPP_APP_SECRET is not set — inbound webhook signature is NOT being verified. Anyone who can reach this endpoint can inject messages.");
      warnedMissingSecret = true;
    }
    return true;
  }
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const header = req.header("x-hub-signature-256");
  if (!rawBody || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  const provided = header.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

// Meta's one-time subscription verification handshake.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN && VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Inbound message delivery. Meta's payload shape (WhatsApp Cloud API
// webhook, `messages` field): entry[].changes[].value.{contacts[],messages[]}.
router.post("/webhook", (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn("[whatsapp-webhook] rejected POST with missing/invalid X-Hub-Signature-256");
    res.sendStatus(403);
    return;
  }
  // Acknowledge immediately — Meta expects a fast 200 and will retry/
  // disable the webhook on repeated timeouts; do the work synchronously
  // here since it's cheap (a couple of sqlite writes), but respond first
  // isn't required by better-sqlite3's sync API, so this is just defensive.
  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        const messages = value?.messages ?? [];
        const contactNames: Record<string, string> = {};
        for (const c of value?.contacts ?? []) {
          if (c?.wa_id && c?.profile?.name) contactNames[c.wa_id] = c.profile.name;
        }
        for (const msg of messages) {
          const fromPhone: string | undefined = msg?.from;
          if (!fromPhone) continue;
          const body: string = msg?.text?.body ?? `[unsupported message type: ${msg?.type ?? "unknown"}]`;
          const contact = db.resolveOrCreateContactByPhone(fromPhone);
          // If this is a brand-new contact and WhatsApp gave us a display
          // name, capture it — but never overwrite a name staff already
          // entered manually.
          if (!contact.fullName && contactNames[fromPhone]) {
            db.updateContact(contact.id, { fullName: contactNames[fromPhone] });
          }
          db.insertMessage({
            contactId: contact.id,
            direction: "inbound",
            messageType: "freeform",
            body,
            status: "delivered",
            triggeredBy: "customer",
            waMessageId: msg?.id ?? null
          });
        }
      }
    }
  } catch (err) {
    console.error("[whatsapp-webhook] failed to process inbound payload:", err);
  }
  res.sendStatus(200);
});

export default router;
