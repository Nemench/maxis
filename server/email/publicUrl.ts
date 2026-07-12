// Resolves the real, publicly-reachable base URL (e.g. https://shop.example.com)
// used to build absolute links/image URLs inside emails — logo, promo
// images, unsubscribe links. This deliberately does NOT fall back to a
// data: URI or to this server's own LAN address for those cases: major
// mail clients (Gmail, Outlook) strip inline data: URIs from received HTML
// as an anti-spam measure regardless of validity, and a LAN address
// (http://192.168.x.x:3000) is never reachable by a recipient's own device
// off that network. Without this configured, email images/links are
// omitted rather than embedded broken.
//
// Admin-configurable via Settings (key: publicBaseUrl), with an env var
// fallback (PUBLIC_BASE_URL) for anyone who'd rather deploy it that way —
// same pattern as server/email/mailer.ts's SMTP config. `requestOrigin`
// (derived from the request that triggered the send, when one exists) is
// the last resort: correct only when this server actually IS reachable at
// that origin (e.g. it's already behind a real domain/reverse proxy), so
// it's tried only after the explicit config is checked.
export function resolvePublicBaseUrl(settings: Record<string, string>, requestOrigin?: string): string {
  const configured = settings.publicBaseUrl || process.env.PUBLIC_BASE_URL || "";
  return (configured || requestOrigin || "").replace(/\/+$/, "");
}
