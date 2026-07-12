// Thin wrapper around the WhatsApp Cloud API (Meta Graph API). Everything
// here is a real network call — nothing is mocked — but it requires
// business-specific configuration that doesn't exist until a real Meta
// WhatsApp Business Account is set up. See the "PLUG IN REAL VALUES" notes
// below for exactly what's missing before this can send a live message.
import { getBusinessProfile } from "../controlPlaneSync.js";

// PLUG IN REAL VALUES: the access token is a long-lived secret issued by
// Meta (System User token, WhatsApp Business Platform). It is deliberately
// NOT synced through the control plane (unlike whatsapp_number_id/
// whatsapp_templates, which ride along on the business profile) — same
// reasoning as the control plane's own API keys: a real secret should
// never round-trip through a third system if it can live only where it's
// used. Set it as a local-only env var on each NemenchPos instance.
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? "";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface SendResult {
  ok: boolean;
  waMessageId: string | null;
  error: string | null;
}

function getPhoneNumberId(): string | null {
  // PLUG IN REAL VALUES: whatsapp_number_id comes from the control-plane
  // business profile (the WhatsApp Business phone number's Graph API
  // "Phone number ID", not the phone number itself) — set it once in the
  // control-plane admin UI for this business, it syncs down automatically.
  return getBusinessProfile().whatsapp_number_id;
}

// Only the two shapes this module actually reads from a Graph API
// response — the real payload has many more fields depending on endpoint,
// but nothing here needs them.
interface GraphResponse {
  error?: { message?: string };
  messages?: { id?: string }[];
}

async function graphPost(path: string, body: unknown): Promise<{ ok: boolean; json: GraphResponse }> {
  if (!WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, json: { error: { message: "WHATSAPP_ACCESS_TOKEN is not configured on this instance" } } };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${GRAPH_API_BASE}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({})) as GraphResponse;
    return { ok: res.ok, json };
  } catch (err) {
    return { ok: false, json: { error: { message: err instanceof Error ? err.message : "network error" } } };
  } finally {
    clearTimeout(timeout);
  }
}

// PLUG IN REAL VALUES: templateName must exactly match a template already
// approved in the Meta WhatsApp Manager (business-initiated messages
// outside the 24h service window can ONLY use approved templates — a
// freeform send here will be rejected by Meta). params are positional
// {{1}}, {{2}}... body variables for that template, in order.
export async function sendTemplateMessage(toPhoneNumber: string, templateName: string, params: unknown[]): Promise<SendResult> {
  const phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) return { ok: false, waMessageId: null, error: "whatsapp_number_id is not configured for this business" };
  const { ok, json } = await graphPost(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: toPhoneNumber,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components: params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }] : undefined
    }
  });
  if (!ok) return { ok: false, waMessageId: null, error: json?.error?.message ?? "send failed" };
  return { ok: true, waMessageId: json?.messages?.[0]?.id ?? null, error: null };
}

// Freeform text — only valid within Meta's 24h customer-service window
// (see KotDatabase.isWithinServiceWindow). Sending outside that window
// will be rejected by Meta regardless of what this function does.
export async function sendFreeformMessage(toPhoneNumber: string, body: string): Promise<SendResult> {
  const phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) return { ok: false, waMessageId: null, error: "whatsapp_number_id is not configured for this business" };
  const { ok, json } = await graphPost(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: toPhoneNumber,
    type: "text",
    text: { body }
  });
  if (!ok) return { ok: false, waMessageId: null, error: json?.error?.message ?? "send failed" };
  return { ok: true, waMessageId: json?.messages?.[0]?.id ?? null, error: null };
}
