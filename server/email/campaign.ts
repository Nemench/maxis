// Builds the HTML for an admin-composed news/deals broadcast to the email
// marketing list (server/routes/emailSubscribers.ts) — deliberately
// simpler than buildSimpleReceiptHtml (no itemized table), just the
// admin's message plus a footer with an unsubscribe link so recipients
// have a real, working way to opt out (a legal requirement in most
// jurisdictions for marketing email, not just a courtesy).
import fs from "fs";
import path from "path";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const EXT_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

function readAsDataUri(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    const mime = EXT_MIME[path.extname(filePath).toLowerCase()] || "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Falls back to the bundled default logo both when no custom one was ever
// uploaded AND when the configured logoUrl points at a file that no longer
// exists (e.g. after a restore from an older backup) — same reasoning as
// server/email/receipt.ts's resolveLogoDataUri, kept as a separate copy
// rather than a shared import since each caller's fallback path (data dir
// vs bundled default) is a two-line function, not worth a shared module.
function resolveLogoDataUri(logoUrl: string): string | null {
  const bundledDefault = path.join(process.cwd(), "public/logo.jpg");
  if (!logoUrl) return readAsDataUri(bundledDefault);
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const uploaded = readAsDataUri(path.join(dataDir, logoUrl.replace(/^\/+/, "")));
  return uploaded ?? readAsDataUri(bundledDefault);
}

// `body` is plain text from the admin's compose box — rendered with
// `white-space:pre-wrap` rather than accepting raw HTML, same posture as
// the order-notification templates in server/email/automation.ts, so an
// admin never has to think about escaping/injection when writing a
// campaign.
export function buildCampaignHtml(siteName: string, logoUrl: string, body: string, unsubscribeUrl: string): string {
  const logoDataUri = resolveLogoDataUri(logoUrl);
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;color:#1a1a2e;">
      ${logoDataUri ? `<img src="${logoDataUri}" alt="${escHtml(siteName)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;margin-bottom:6px;">` : ""}
      <h2 style="color:#1a47a0;margin:0 0 12px;">${escHtml(siteName)}</h2>
      <div style="white-space:pre-wrap;font-size:14px;line-height:1.5;">${escHtml(body)}</div>
      <p style="color:#888;font-size:11px;margin-top:24px;border-top:1px solid #e0e6f0;padding-top:12px;">
        You're receiving this because you gave us your email at ${escHtml(siteName)}.
        <a href="${unsubscribeUrl}" style="color:#888;">Unsubscribe</a>
      </p>
    </div>`;
}
