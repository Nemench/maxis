// Core order (KOT ticket) lifecycle: create, list, fetch one, and update
// status per-department (kitchen/counter) or overall.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { CreateOrderInput, OrderItemInput, OrderStatus, Department, DeptStatus } from "../../src/shared/types.js";

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
  try { res.status(201).json(db.createOrder(req.body as CreateOrderInput, req.user!.id)); }
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
  try { res.json(db.updateOrderStatus(Number(req.params.id), req.body.status as OrderStatus)); }
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
    res.json(db.updateDeptStatus(Number(req.params.id), department, status));
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update status" }); }
});

export default router;
