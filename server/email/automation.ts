// Fires an order-notification email for a business event (order_ready,
// payment_received) — independent of the WhatsApp automation in
// server/whatsapp/automation.ts (see server/database.ts's email_outbox
// schema comment for why: no consent/contact indirection, free-text
// templates since there's no Meta-style approval process to constrain
// them). Called from server/routes/orders.ts right next to the WhatsApp
// trigger, at the same two points. Never throws — a mistake here must
// never surface into the order-status/payment code path that calls it.
import { db } from "../index.js";
import type { Order } from "../../src/shared/types.js";
import { buildSimpleReceiptHtml } from "./receipt.js";

export type EmailEvent = "order_ready" | "payment_received";

// {{customerName}} / {{ticketNumber}} / {{amount}} / {{fulfillment}} —
// plain string substitution, not the WhatsApp templates' positional-array
// shape, since there's no pre-approval process constraining what an admin
// can write into the subject/body settings fields.
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? "");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function triggerEmailNotification(event: EmailEvent, order: Order): boolean {
  try {
    if (!order.customerEmail) return false; // no email captured at checkout — nothing to do

    const settings = db.getAllSettings();
    if (settings.emailNotificationsEnabled !== "true") return false;

    const subjectTemplate = event === "order_ready" ? settings.emailOrderReadySubject : settings.emailPaymentReceivedSubject;
    const bodyTemplate = event === "order_ready" ? settings.emailOrderReadyBody : settings.emailPaymentReceivedBody;
    if (!subjectTemplate || !bodyTemplate) return false; // admin hasn't written a template for this event yet

    const amount = order.items.reduce((s, i) => s + (i.lineTotal ?? 0), 0) - order.discountAmount;
    const vars = {
      customerName: order.customerName?.trim() || "there",
      ticketNumber: order.ticketNumber,
      amount: `R${amount.toFixed(2)}`,
      // Lets a single order_ready template read correctly either way,
      // rather than always saying "ready for collection" regardless of
      // how the order is actually meant to reach the customer.
      fulfillment: order.orderType === "delivery" ? "out for delivery" : "ready for collection"
    };

    const subject = renderTemplate(subjectTemplate, vars);
    const body = renderTemplate(bodyTemplate, vars);
    // The admin's own message goes above a simple itemized receipt — see
    // server/email/receipt.ts for why this isn't the exact printed layout.
    const receiptHtml = buildSimpleReceiptHtml(order, settings);
    const htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto 20px;color:#1a1a2e;white-space:pre-wrap;">${escHtml(body)}</div>${receiptHtml}`;

    db.enqueueEmail(order.id, order.customerEmail, subject, body, htmlBody);
    return true;
  } catch (err) {
    console.error(`[email-automation] failed to trigger "${event}":`, err);
    return false;
  }
}
