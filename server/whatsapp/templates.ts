// Shared shape + helpers for reading the business's approved WhatsApp
// template catalog, which rides down from the control plane as the opaque
// `whatsapp_templates` field on the business profile (see
// server/controlPlaneSync.ts). Meta's Graph API doesn't need anything
// beyond the template's name + ordered params to send a message — this
// catalog exists purely so NemenchPos itself can (a) render a human-readable
// body for the crm_messages log/chat view, and (b) know which templates
// are "marketing" tier so opted-out/unknown-consent contacts can never be
// sent one (see KotDatabase's consent rules).
import { getBusinessProfile } from "../controlPlaneSync.js";

export interface WhatsappTemplateConfig {
  name: string;
  category: "utility" | "marketing";
  // Human-readable body with {{1}}, {{2}}, ... placeholders, matching the
  // params array positions sent to Meta — used only for local display, not
  // sent to Meta (Meta already knows the approved body server-side).
  bodyTemplate: string;
}

// PLUG IN REAL VALUES: this is the fallback catalog used until the
// business profile's whatsapp_templates field is populated via the
// control-plane admin UI once real templates are submitted to and
// approved by Meta. Template `name` values here are placeholders — they
// MUST be replaced with the exact names Meta approves (template names are
// fixed at submission time and cannot be renamed after approval).
const FALLBACK_TEMPLATES: WhatsappTemplateConfig[] = [
  { name: "order_ready_v1", category: "utility", bodyTemplate: "Hi {{1}}, your order #{{2}} is {{3}}!" },
  { name: "payment_received_v1", category: "utility", bodyTemplate: "Hi {{1}}, we've received your payment of {{2}} for order #{{3}}. Thank you!" }
];

export function getTemplateCatalog(): WhatsappTemplateConfig[] {
  const configured = getBusinessProfile().whatsapp_templates;
  if (Array.isArray(configured) && configured.length > 0) return configured as WhatsappTemplateConfig[];
  return FALLBACK_TEMPLATES;
}

export function getTemplate(name: string): WhatsappTemplateConfig | null {
  return getTemplateCatalog().find((t) => t.name === name) ?? null;
}

export function renderTemplateBody(template: WhatsappTemplateConfig, params: unknown[]): string {
  return template.bodyTemplate.replace(/\{\{(\d+)\}\}/g, (_match, idx) => {
    const i = Number(idx) - 1;
    return i >= 0 && i < params.length ? String(params[i]) : `{{${idx}}}`;
  });
}
