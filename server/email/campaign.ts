// Builds the HTML for an admin-composed news/deals broadcast to the email
// marketing list (server/routes/emailSubscribers.ts) — deliberately
// simpler than buildSimpleReceiptHtml (no itemized table). Supports two
// looks: a plain message (just the admin's text) or a "picture-style"
// discount announcement — a colored banner with a headline/discount/expiry,
// optionally topped with a full-width promo image — for admins who want
// something that reads as an actual flyer rather than a wall of text.
// Every recipient gets a working unsubscribe link either way (a legal
// requirement in most jurisdictions for marketing email, not just a
// courtesy).
//
// Images (logo, promo) are plain <img src> URLs against the resolved
// public base URL, NOT base64 data URIs — see server/email/receipt.ts's
// header comment for why: major mail clients strip inline data: URIs from
// received HTML regardless of validity, so they never actually render for
// a real recipient. Without a public base URL configured, images are
// omitted rather than embedding a link that's guaranteed unreachable.

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatValidUntil(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });
}

// All optional — an admin can supply just a discount label, just an image,
// or the full set. Nothing here is wired into checkout/orders; it's purely
// promotional copy for the email, same as a printed flyer would be.
export interface CampaignPromo {
  headline?: string;
  discountLabel?: string;
  description?: string;
  validUntil?: string;
  imageUrl?: string;
}

function buildPromoBanner(promo: CampaignPromo, themeColor: string, publicBaseUrl: string): string {
  const imageUrl = promo.imageUrl && publicBaseUrl ? `${publicBaseUrl}${promo.imageUrl}` : "";
  const validUntilStr = promo.validUntil ? formatValidUntil(promo.validUntil) : "";
  if (!imageUrl && !promo.headline && !promo.discountLabel && !promo.description) return "";

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;overflow:hidden;margin-bottom:20px;">
      <tbody>
        ${imageUrl ? `<tr><td><img src="${imageUrl}" alt="" style="width:100%;max-width:420px;display:block;"></td></tr>` : ""}
        <tr>
          <td bgcolor="${themeColor}" style="background:${themeColor};padding:22px 20px;text-align:center;">
            ${promo.headline ? `<div style="color:#ffffff;font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.9;font-family:Arial,Helvetica,sans-serif;">${escHtml(promo.headline)}</div>` : ""}
            ${promo.discountLabel ? `<div style="color:#ffffff;font-size:34px;font-weight:800;margin:6px 0;font-family:Arial,Helvetica,sans-serif;">${escHtml(promo.discountLabel)}</div>` : ""}
            ${promo.description ? `<div style="color:#ffffff;font-size:14px;line-height:1.4;font-family:Arial,Helvetica,sans-serif;">${escHtml(promo.description)}</div>` : ""}
            ${validUntilStr ? `<div style="color:#ffffff;font-size:12px;margin-top:10px;opacity:.9;font-family:Arial,Helvetica,sans-serif;">Valid until ${escHtml(validUntilStr)}</div>` : ""}
          </td>
        </tr>
      </tbody>
    </table>`;
}

// `body` is plain text from the admin's compose box - rendered with
// `white-space:pre-wrap` rather than accepting raw HTML, same posture as
// the order-notification templates in server/email/automation.ts, so an
// admin never has to think about escaping/injection when writing a
// campaign. `promo`/`themeColor` are optional — omit promo entirely for a
// plain-text campaign.
export function buildCampaignHtml(siteName: string, logoUrl: string, body: string, unsubscribeUrl: string, publicBaseUrl: string, promo?: CampaignPromo, themeColor?: string): string {
  const resolvedLogoUrl = publicBaseUrl ? `${publicBaseUrl}${logoUrl || "/logo.jpg"}` : "";
  const banner = promo ? buildPromoBanner(promo, /^#[0-9a-f]{6}$/i.test(themeColor ?? "") ? themeColor! : "#1a47a0", publicBaseUrl) : "";
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;color:#1a1a2e;">
      ${resolvedLogoUrl ? `<img src="${resolvedLogoUrl}" alt="${escHtml(siteName)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;margin-bottom:6px;">` : ""}
      <h2 style="color:#1a47a0;margin:0 0 12px;">${escHtml(siteName)}</h2>
      ${banner}
      ${body.trim() ? `<div style="white-space:pre-wrap;font-size:14px;line-height:1.5;">${escHtml(body)}</div>` : ""}
      <p style="color:#888;font-size:11px;margin-top:24px;border-top:1px solid #e0e6f0;padding-top:12px;">
        You're receiving this because you gave us your email at ${escHtml(siteName)}.
        <a href="${unsubscribeUrl}" style="color:#888;">Unsubscribe</a>
      </p>
    </div>`;
}
