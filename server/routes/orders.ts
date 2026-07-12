// Core order (KOT ticket) lifecycle: create, list, fetch one, and update
// status per-department (kitchen/counter) or overall.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { CreateOrderInput, Order, OrderItemInput, OrderStatus, Department, DeptStatus } from "../../src/shared/types.js";
import { triggerAutomation } from "../whatsapp/automation.js";
import { triggerEmailNotification } from "../email/automation.js";
import { sendEmail } from "../email/mailer.js";

// Fires the order_ready automation only on the transition INTO "Ready"
// (previous status wasn't already Ready) — callers pass the status just
// before their update so a second PATCH that leaves an order sitting at
// Ready doesn't re-send the notification. Lives here (not baked into
// db.updateDeptStatus/updateOrderStatus) because triggerAutomation reads
// `db` from server/index.ts, the same module that constructs the
// KotDatabase instance — importing it from database.ts would be circular.
// Fires both channels off the same computed transition — email piggybacks
// on this same check rather than a second one.
function maybeTriggerOrderReady(previousStatus: OrderStatus, order: Order, requestOrigin: string): void {
  if (order.status !== "Ready" || previousStatus === "Ready") return;
  // 3rd param says whether it's ready for collection or out for delivery
  // — if you've already submitted a real Meta template for order_ready
  // with only 2 body variables, adding this 3rd one means resubmitting an
  // updated template for approval before it'll actually send correctly.
  triggerAutomation("order_ready", order.crmContactId, { args: [order.customerName || "there", order.ticketNumber, order.orderType === "delivery" ? "out for delivery" : "ready for collection"] });
  triggerEmailNotification("order_ready", order, requestOrigin);
}

const router = Router();
router.use(requireAuth);

// Roles that build receipts — same set allowed to quick-create a product
// via an unrecognized barcode scan (see products.ts).
const canAddItems = (req: AuthRequest) =>
  req.user?.role === "admin" || req.user?.role === "cashier" || req.user?.role === "master_cashier";

// GET /api/orders?scope=active|history|all
// Kitchen/counter roles are implicitly scoped to their own department's
// orders (dept), everyone else (admin/cashier) sees all departments.
router.get("/", (req: AuthRequest, res) => {
  if (req.user?.id) db.touchLastSeen(req.user.id);
  const rawScope = req.query.scope as string;
  const scope: "active" | "history" | "all" =
    rawScope === "history" ? "history" : rawScope === "all" ? "all" : "active";
  const role = req.user?.role;
  const dept: Department | null =
    role === "kitchen" ? "kitchen" :
    role === "counter" ? "counter" :
    null;
  res.json(db.listOrders(scope, dept));
});

router.post("/", (req: AuthRequest, res) => {
  if (!canAddItems(req)) {
    res.status(403).json({ message: "Not authorized to create orders" });
    return;
  }
  try {
    const order = db.createOrder(req.body as CreateOrderInput, req.user!.id);
    // Auto-captures every order email into the marketing list (see
    // server/email/campaign.ts) — deliberately not opt-in gated the way
    // WhatsApp consent is, since this is a free-text email address the
    // customer typed in themselves, not a phone number resolved through
    // Meta's messaging channel.
    if (order.customerEmail) db.upsertEmailSubscriber(order.customerEmail, order.customerName);
    // "payment_received" only has a real trigger point for completeImmediately
    // (POS) sales — those are the only orders paid for at creation time in
    // this codebase; regular KOT tickets aren't paid until much later, if
    // ever, through a flow that doesn't exist yet.
    if ((req.body as CreateOrderInput).completeImmediately) {
      triggerAutomation("payment_received", order.crmContactId, {
        args: [order.customerName || "there", `R${(order.items.reduce((s, i) => s + (i.lineTotal ?? 0), 0) - order.discountAmount).toFixed(2)}`, order.ticketNumber]
      });
      triggerEmailNotification("payment_received", order, `${req.protocol}://${req.get("host")}`);
    }
    res.status(201).json(order);
  }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to create order" }); }
});

router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ message: "Not found" }); return; }
  try { res.json(db.getOrder(id)); }
  catch (err) { res.status(404).json({ message: err instanceof Error ? err.message : "Not found" }); }
});

// Adds one item to an already-created order — the "Scan barcode" button on
// an in-progress ticket in the Queue, as opposed to items added while
// first building the order in OrderEntry.
router.post("/:id/items", (req: AuthRequest, res) => {
  if (!canAddItems(req)) {
    res.status(403).json({ message: "Not authorized to add items to an order" });
    return;
  }
  try { res.status(201).json(db.addOrderItem(Number(req.params.id), req.body as OrderItemInput)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to add item" }); }
});

router.patch("/:id/status", (req, res) => {
  try {
    const id = Number(req.params.id);
    const previousStatus = db.getOrder(id).status;
    const order = db.updateOrderStatus(id, req.body.status as OrderStatus);
    maybeTriggerOrderReady(previousStatus, order, `${req.protocol}://${req.get("host")}`);
    res.json(order);
  }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update status" }); }
});

router.patch("/:id/dept-status", (req: AuthRequest, res) => {
  try {
    const { department, status } = req.body as { department: Department; status: DeptStatus };
    const role = req.user?.role;
    // Kitchen staff can only update kitchen; counter staff can only update counter
    if (role === "kitchen" && department !== "kitchen") {
      res.status(403).json({ message: "Kitchen staff can only update kitchen status" });
      return;
    }
    if (role === "counter" && department !== "counter") {
      res.status(403).json({ message: "Counter staff can only update counter status" });
      return;
    }
    const id = Number(req.params.id);
    const previousStatus = db.getOrder(id).status;
    const order = db.updateDeptStatus(id, department, status);
    maybeTriggerOrderReady(previousStatus, order, `${req.protocol}://${req.get("host")}`);
    res.json(order);
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update status" }); }
});

// Manual "Email receipt" button (Queue/History) — sent immediately (not
// queued through email_outbox), so staff get instant pass/fail feedback,
// same posture as the Settings test-email route. The client builds and
// sends the exact styled receipt HTML it already generates for printing
// (buildReceiptHtml in src/ui/App.tsx) — a real client is present for
// this action, unlike the automated order_ready/payment_received emails
// (see server/email/receipt.ts), so there's no need for the simplified
// server-built version here.
router.post("/:id/email-receipt", (req: AuthRequest, res) => {
  if (!canAddItems(req)) {
    res.status(403).json({ message: "Not authorized to email receipts" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ message: "Not found" }); return; }
  const { to, html } = req.body as { to: string; html: string };
  if (!to || !/\S+@\S+\.\S+/.test(to)) { res.status(400).json({ message: "Enter a valid email address" }); return; }
  if (!html) { res.status(400).json({ message: "No receipt content provided" }); return; }
  let order: Order;
  try { order = db.getOrder(id); }
  catch (err) { res.status(404).json({ message: err instanceof Error ? err.message : "Not found" }); return; }
  sendEmail(to, `Your receipt - #${order.ticketNumber}`, "Your receipt is attached. If your email doesn't show it, please contact us.", html)
    .then((result) => {
      if (result.ok) res.json({ ok: true });
      else res.status(400).json({ message: result.error ?? "Send failed" });
    })
    .catch((err) => res.status(500).json({ message: err instanceof Error ? err.message : "Send failed" }));
});

export default router;
