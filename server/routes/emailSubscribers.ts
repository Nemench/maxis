// Admin API for the email marketing list: view/add/remove subscribers
// (mostly auto-captured from order checkouts, see db.upsertEmailSubscriber
// in orders.ts) and send a one-off news/deals broadcast to everyone still
// subscribed. Admin-only, same posture as crm.ts — a list of customer
// names/emails is sensitive customer data.
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import { buildCampaignHtml } from "../email/campaign.js";
import type { CampaignPromo } from "../email/campaign.js";
import { resolvePublicBaseUrl } from "../email/publicUrl.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const uploadsDir = path.join(dataDir, "uploads");

const ALLOWED_IMAGE_TYPES: Record<string, string> = { png: "png", jpeg: "jpg", jpg: "jpg", webp: "webp" };

router.get("/", (_req, res) => { res.json(db.listEmailSubscribers()); });

router.post("/", (req: AuthRequest, res) => {
  const { email, name } = req.body as { email?: string; name?: string };
  if (!email || !/\S+@\S+\.\S+/.test(email)) { res.status(400).json({ message: "Enter a valid email address" }); return; }
  try { res.status(201).json(db.addEmailSubscriber(email, name?.trim() || null)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to add subscriber" }); }
});

router.patch("/:id", (req: AuthRequest, res) => {
  const { status } = req.body as { status?: string };
  if (status !== "subscribed" && status !== "unsubscribed") { res.status(400).json({ message: "status must be 'subscribed' or 'unsubscribed'" }); return; }
  try { res.json(db.setEmailSubscriberStatus(req.params.id as string, status)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update subscriber" }); }
});

router.delete("/:id", (req, res) => {
  db.deleteEmailSubscriber(req.params.id as string);
  res.json({ success: true });
});

// Uploads a promo image for a "picture-style" discount campaign (see
// buildCampaignHtml/CampaignPromo) — same base64-data-URL-in, static-file-
// out shape as the logo upload in settings.ts, but each campaign keeps its
// own file (randomUUID-named) rather than overwriting a single slot, so an
// admin can build several campaigns without one clobbering another's image.
router.post("/campaign-image", (req: AuthRequest, res) => {
  const { dataUrl } = req.body as { dataUrl: string };
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl ?? "");
  if (!match) {
    res.status(400).json({ message: "Expected a base64 PNG/JPEG/WebP data URL" });
    return;
  }
  const ext = ALLOWED_IMAGE_TYPES[match[1].toLowerCase()];
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `campaign-${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(match[2], "base64"));
  res.json({ imageUrl: `/uploads/${filename}` });
});

// Queues one email per currently-subscribed address via the same
// email_outbox the order-notification system uses (server/email/worker.ts
// drains it out-of-band), so a broadcast to a large list never blocks this
// request. `promo` is optional — a plain-text campaign when omitted, a
// picture-style discount announcement banner when given (see
// buildCampaignHtml). Both the unsubscribe link and any images resolve
// against resolvePublicBaseUrl, not this request's own origin — an admin
// sending from a LAN address would otherwise bake an unreachable link into
// every recipient's email.
router.post("/send-campaign", (req: AuthRequest, res) => {
  const { subject, body, promo } = req.body as { subject?: string; body?: string; promo?: CampaignPromo };
  const hasPromoContent = promo && (promo.headline || promo.discountLabel || promo.description || promo.imageUrl);
  if (!subject?.trim() || (!body?.trim() && !hasPromoContent)) {
    res.status(400).json({ message: "Subject and a message (or discount banner content) are required" });
    return;
  }
  const settings = db.getAllSettings();
  const siteName = settings.siteName || "NemenchPos";
  const publicBaseUrl = resolvePublicBaseUrl(settings, `${req.protocol}://${req.get("host")}`);
  const subscribers = db.listSubscribedEmails();
  for (const sub of subscribers) {
    const token = db.getEmailSubscriberToken(sub.id);
    const unsubscribeUrl = `${publicBaseUrl}/api/unsubscribe/${token}`;
    const html = buildCampaignHtml(siteName, settings.logoUrl || "", body ?? "", unsubscribeUrl, publicBaseUrl, promo, settings.themeColor);
    db.enqueueEmail(null, sub.email, subject, body || promo?.headline || subject, html);
  }
  res.json({ queued: subscribers.length });
});

export default router;
