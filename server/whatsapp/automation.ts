// Fires an automated WhatsApp notification for a business event (order
// ready, payment received, ...). Called from server/routes/orders.ts —
// order_ready on the transition into "Ready" (dept-status/status PATCH
// handlers), payment_received on a completeImmediately (POS) order's
// creation — this module only decides whether a message is allowed and
// queues it; it never sends synchronously (that's
// server/whatsapp/outboxWorker.ts's job), so a slow or unreachable Meta
// API can never block the order flow that triggered it.
import { db } from "../index.js";
import { getTemplate, renderTemplateBody } from "./templates.js";

export type AutomationEvent = "order_ready" | "payment_received";

// Never throws — a failure here (bad contact id, disabled rule, etc.)
// must never surface into the order-status/payment code path that calls
// it. Returns true if a message was actually queued, false otherwise
// (useful for tests/logging, not required by callers).
export function triggerAutomation(event: AutomationEvent, contactId: string | null, params: Record<string, unknown>): boolean {
  try {
    if (!contactId) return false; // no linked contact — nothing to do (e.g. walk-in sale with no phone captured)

    const rule = db.getAutomationRule(event);
    if (!rule || !rule.enabled) return false;

    const contact = db.getContact(contactId);
    if (!contact) return false;

    // Transactional/utility messages (order ready, payment received) are
    // allowed for 'unknown' and 'opted_in' — only an explicit opt-out
    // blocks them. This mirrors WhatsApp's own utility-vs-marketing
    // distinction: these are not promotional, so default consent state
    // doesn't block them, but an explicit opt-out always wins.
    if (contact.consentStatus === "opted_out") return false;

    const template = getTemplate(rule.templateName);
    if (!template) {
      console.error(`[whatsapp-automation] template "${rule.templateName}" for event "${event}" not found in catalog`);
      return false;
    }

    // Params are passed positionally in the order the template expects —
    // callers pass an ordered array; template rendering/logging uses it
    // as-is via renderTemplateBody.
    const orderedParams = Array.isArray(params.args) ? (params.args as unknown[]) : Object.values(params);
    const body = renderTemplateBody(template, orderedParams);

    db.enqueueOutboundMessage({
      contactId,
      messageType: "template",
      templateName: template.name,
      templateParams: orderedParams,
      body,
      triggeredBy: `automation:${event}`
    });
    return true;
  } catch (err) {
    console.error(`[whatsapp-automation] failed to trigger "${event}":`, err);
    return false;
  }
}
