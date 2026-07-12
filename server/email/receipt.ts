// Builds a simple, honest itemized receipt for the automated order-ready/
// payment-received emails, which fire server-side with no browser
// involved. This is deliberately NOT a port of buildReceiptHtml
// (src/ui/App.tsx, client-only - the exact thermal/A4 layout used for
// printing/the manual "Email receipt" button): that function depends on
// browser-only state (a client-side branding cache, locale-aware
// Intl.NumberFormat) that doesn't exist in this process. This one reads
// settings directly from the DB - real receipt content (itemized list,
// VAT, total, payment method), just not a pixel match. The logo is
// embedded as a base64 data URI (same reasoning as the client's
// logoDataUri cache): a remote URL would only resolve for whoever can
// reach this server, which is never guaranteed for an emailed receipt.
import fs from "fs";
import path from "path";
import type { Order } from "../../src/shared/types.js";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const rand = (n: number) => `R${n.toFixed(2)}`;

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

// Mirrors scripts/sync-branding.mjs's resolution: an admin-uploaded logo
// lives at DATA_DIR/<settings.logoUrl>, falling back to the bundled
// default at public/logo.jpg when none has been uploaded — and also
// falling back there if the configured logoUrl points at a file that no
// longer exists (e.g. after a restore from an older backup), rather than
// silently sending no logo at all.
function resolveLogoDataUri(logoUrl: string): string | null {
  const bundledDefault = path.join(process.cwd(), "public/logo.jpg");
  if (!logoUrl) return readAsDataUri(bundledDefault);
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const uploaded = readAsDataUri(path.join(dataDir, logoUrl.replace(/^\/+/, "")));
  return uploaded ?? readAsDataUri(bundledDefault);
}

export function buildSimpleReceiptHtml(order: Order, settings: Record<string, string>): string {
  const siteName = settings.siteName || "NemenchPos";
  const vatRegistered = settings.vatRegistered === "true";
  const subtotal = order.items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const discount = Math.min(Math.max(0, order.discountAmount || 0), subtotal);
  const total = subtotal - discount;
  const vat = vatRegistered ? total * (0.15 / 1.15) : 0;

  const rows = order.items.map((i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;">${escHtml(i.name)}${i.notes ? `<div style="font-size:11px;color:#777;">${escHtml(i.notes)}</div>` : ""}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${i.kg ? `${i.kg} kg` : i.quantity ? `×${i.quantity}` : "-"}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${i.lineTotal != null ? rand(i.lineTotal) : "-"}</td>
    </tr>`).join("");

  const paymentLine = order.paymentMethod === "cash" && order.cashTendered != null
    ? `Paid: Cash - Tendered ${rand(order.cashTendered)}, Change ${rand(Math.max(0, order.cashTendered - total))}`
    : order.paymentMethod === "card" ? "Paid: Card" : "";

  const logoDataUri = resolveLogoDataUri(settings.logoUrl || "");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;color:#1a1a2e;">
      ${logoDataUri ? `<img src="${logoDataUri}" alt="${escHtml(siteName)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;margin-bottom:6px;">` : ""}
      <h2 style="color:#1a47a0;margin:0 0 2px;">${escHtml(siteName)}</h2>
      <p style="color:#666;margin:0 0 16px;font-size:13px;">Ticket #${escHtml(order.ticketNumber)}</p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #1a47a0;font-size:12px;">Item</th>
            <th style="text-align:right;padding:6px 8px;border-bottom:2px solid #1a47a0;font-size:12px;">Qty</th>
            <th style="text-align:right;padding:6px 8px;border-bottom:2px solid #1a47a0;font-size:12px;">Price</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <table style="width:100%;max-width:240px;margin:12px 0 0 auto;font-size:13px;">
        <tr><td style="padding:2px 0;">Subtotal</td><td style="padding:2px 0;text-align:right;">${rand(subtotal)}</td></tr>
        ${discount > 0 ? `<tr><td style="padding:2px 0;">Discount</td><td style="padding:2px 0;text-align:right;">-${rand(discount)}</td></tr>` : ""}
        ${vatRegistered ? `<tr><td style="padding:2px 0;">VAT incl. (15%)</td><td style="padding:2px 0;text-align:right;">${rand(vat)}</td></tr>` : ""}
        <tr style="font-weight:bold;font-size:16px;"><td style="padding-top:6px;border-top:2px solid #1a47a0;">Total</td><td style="padding-top:6px;border-top:2px solid #1a47a0;text-align:right;">${rand(total)}</td></tr>
      </table>
      ${paymentLine ? `<p style="color:#666;font-size:13px;margin-top:10px;">${escHtml(paymentLine)}</p>` : ""}
      <p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #e0e6f0;padding-top:12px;">Thank you for your order - ${escHtml(siteName)}</p>
    </div>`;
}
