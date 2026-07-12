// Renders the freeform order-notification body for a given order, by
// picking the matching row from order_message_templates (see
// database.ts's schema comment) and interpolating placeholders. This is
// deliberately separate from getTemplate/renderTemplateBody in
// templates.ts - that module renders Meta-APPROVED template bodies
// ({{1}}, {{2}}... positional, display-only, the real send uses the
// template name) for automation; this one is a fully freeform, always-
// editable body meant only for a real freeform WhatsApp send when the
// contact is within the 24h service window (see isWithinServiceWindow) -
// Meta does not allow business-initiated freeform sends outside that
// window. This function only renders text; triggerOrderReadyMessage
// (automation.ts) is what actually gates whether it's legal to send.
import { db } from "../index.js";
import type { Order } from "../../src/shared/types.js";

type FulfillmentType = "pickup" | "delivery";
type PaymentStatus = "paid" | "unpaid";

// paidAt is set only for a completeImmediately (POS) sale, at creation
// time (see database.ts's createOrder) - the one point "paid" is an
// actually-known fact today. A regular KOT ticket stays "unpaid" here
// even after it's fulfilled, until a real "mark as paid" action exists.
function resolvePaymentStatus(order: Order): PaymentStatus {
  return order.paidAt ? "paid" : "unpaid";
}

function resolveFulfillmentType(order: Order): FulfillmentType {
  return order.orderType === "delivery" ? "delivery" : "pickup";
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;

export interface OrderMessageContext {
  businessName: string;
  businessAddress: string;
  closingTime: string;
}

export function buildOrderMessage(order: Order, ctx: OrderMessageContext): string {
  const fulfillmentType = resolveFulfillmentType(order);
  const paymentStatus = resolvePaymentStatus(order);

  const row = db.getOrderMessageTemplate(fulfillmentType, paymentStatus);
  if (!row) {
    throw new Error(`No order_message_templates row for ${fulfillmentType}/${paymentStatus} - did the migration seed run?`);
  }

  const amount = order.items.reduce((s, i) => s + (i.lineTotal ?? 0), 0) - order.discountAmount;
  const vars: Record<string, string> = {
    customer_name: order.customerName?.trim() || "there",
    business_name: ctx.businessName,
    order_number: order.ticketNumber,
    amount: amount.toFixed(2),
    business_address: ctx.businessAddress,
    closing_time: ctx.closingTime || "closing time",
    delivery_address: [order.deliveryAddress?.street, order.deliveryAddress?.area].filter(Boolean).join(", "),
    // requestedTime is the customer's requested slot, captured at order
    // creation - reused as a stand-in ETA; not a live driver ETA.
    eta: order.requestedTime || "shortly"
  };

  return row.body.replace(PLACEHOLDER_RE, (_match, key: string) => vars[key] ?? `{${key}}`);
}
