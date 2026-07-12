// Builds a simple, honest itemized receipt for the automated order-ready/
// payment-received emails, which fire server-side with no browser
// involved. This is deliberately NOT a port of buildReceiptHtml
// (src/ui/App.tsx, client-only - the exact thermal/A4 layout used for
// printing/the manual "Email receipt" button): that function depends on
// browser-only state (a client-side branding cache, locale-aware
// Intl.NumberFormat) that doesn't exist in this process. This one reads
// settings directly from the DB - real receipt content (itemized list,
// VAT, total, payment method), just not a pixel match. The logo is a
// plain <img src> against the resolved public base URL (see
// resolvePublicBaseUrl) - NOT a base64 data URI. That was tried first and
// seemed like the obvious fix (no network dependency, works offline), but
// major mail clients (Gmail, Outlook) strip inline data: URIs from
// received HTML as an anti-spam measure regardless of validity, so it
// never actually rendered for a real recipient. If no public base URL is
// configured, the logo is omitted entirely rather than embedding a link
// that's guaranteed unreachable.
import type { Order } from "../../src/shared/types.js";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const rand = (n: number) => `R${n.toFixed(2)}`;

export function buildSimpleReceiptHtml(order: Order, settings: Record<string, string>, publicBaseUrl: string): string {
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

  const logoUrl = publicBaseUrl ? `${publicBaseUrl}${settings.logoUrl || "/logo.jpg"}` : "";

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;color:#1a1a2e;">
      ${logoUrl ? `<img src="${logoUrl}" alt="${escHtml(siteName)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;margin-bottom:6px;">` : ""}
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
